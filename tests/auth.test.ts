import { describe, expect, test } from "bun:test";
import {
  BMW_DEVICE_CODE_ENDPOINT,
  BMW_DEVICE_OAUTH_LABEL,
  BMW_OAUTH_CLIENT_ID,
  BMW_OAUTH_SCOPE,
  BMW_TOKEN_ENDPOINT,
  BmwDeviceOAuthError,
  createBmwDeviceOAuthMethod,
  pollBmwDeviceAuthorization,
  requestBmwDeviceAuthorization,
  type BmwDeviceAuthorization,
  type BmwDeviceOAuthDependencies,
} from "../src/auth.ts";

const DEVICE_CODE = "device-code-secret";
const USER_CODE = "user-code-secret";
const ACCESS_TOKEN = "access-token-secret";
const AUTHORIZATION = `token ${ACCESS_TOKEN}`;
const authorization: BmwDeviceAuthorization = {
  deviceCode: DEVICE_CODE,
  userCode: USER_CODE,
  verificationUrl: "https://bmw.ghe.com/login/device",
  expiresAt: 100_000,
  pollIntervalMs: 1_000,
};

function json(payload: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

function assertSecretFree(error: Error): void {
  const output = [error.message, String(error), JSON.stringify(error), ...Object.values(error)].join(" ");
  for (const secret of [DEVICE_CODE, USER_CODE, ACCESS_TOKEN, AUTHORIZATION]) expect(output).not.toContain(secret);
}

async function rejected(action: Promise<unknown>): Promise<BmwDeviceOAuthError> {
  try {
    await action;
    throw new Error("Expected rejection.");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BmwDeviceOAuthError);
    const result = error as BmwDeviceOAuthError;
    assertSecretFree(result);
    return result;
  }
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (reason: unknown) => void } {
  let resolve: (value: T) => void = (): void => undefined;
  let reject: (reason: unknown) => void = (): void => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise): void => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface ControllableDeadlineTimer extends BmwDeviceOAuthDependencies {
  fireDeadline(): void;
  readonly clearedTimers: ReadonlyArray<ReturnType<typeof globalThis.setTimeout>>;
}

function controllableDeadlineTimer(): ControllableDeadlineTimer {
  let callback: (() => void) | undefined;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const cleared: Array<ReturnType<typeof globalThis.setTimeout>> = [];

  return {
    setDeadlineTimer: (nextCallback: () => void, _milliseconds: number): ReturnType<typeof globalThis.setTimeout> => {
      callback = nextCallback;
      timer = {} as ReturnType<typeof globalThis.setTimeout>;
      return timer;
    },
    clearDeadlineTimer: (nextTimer: ReturnType<typeof globalThis.setTimeout>): void => {
      cleared.push(nextTimer);
    },
    fireDeadline(): void {
      callback?.();
    },
    get clearedTimers(): ReadonlyArray<ReturnType<typeof globalThis.setTimeout>> {
      return cleared;
    },
  };
}

describe("BMW device OAuth", () => {
  test("requests exact device form and exposes discovery label, verification URL, and callback result", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return calls.length === 1
        ? json({ device_code: DEVICE_CODE, user_code: USER_CODE, verification_uri_complete: "https://bmw.ghe.com/login/device?user_code=abc", expires_in: 60, interval: 2 })
        : json({ access_token: ACCESS_TOKEN });
    }) as typeof fetch;
    const method = createBmwDeviceOAuthMethod({ fetch: fetcher, sleep: async (): Promise<void> => undefined, clock: (): number => 0 });

    expect(method).toMatchObject({ type: "oauth", label: BMW_DEVICE_OAUTH_LABEL });
    expect(BMW_DEVICE_CODE_ENDPOINT).toBe("https://bmw.ghe.com/login/device/code");
    expect(BMW_TOKEN_ENDPOINT).toBe("https://bmw.ghe.com/login/oauth/access_token");
    expect(BMW_OAUTH_CLIENT_ID).toBe("Iv1.b507a08c87ecfe98");
    expect(BMW_OAUTH_SCOPE).toBe("read:user");
    const prompt = await method.authorize();
    expect(prompt).toMatchObject({ url: "https://bmw.ghe.com/login/device?user_code=abc", instructions: `Open the URL and enter code ${USER_CODE}.`, method: "auto" });
    expect(await prompt.callback()).toEqual({ type: "success", access: ACCESS_TOKEN, refresh: ACCESS_TOKEN, expires: 0 });
    expect(calls[0]).toMatchObject({ url: BMW_DEVICE_CODE_ENDPOINT, init: { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" } } });
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]?.init?.body)))).toEqual({ client_id: BMW_OAUTH_CLIENT_ID, scope: BMW_OAUTH_SCOPE });
    expect(calls[1]).toMatchObject({ url: BMW_TOKEN_ENDPOINT, init: { method: "POST" } });
    expect(String(calls[1]?.init?.body)).toBe(`client_id=${BMW_OAUTH_CLIENT_ID}&device_code=${DEVICE_CODE}&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code`);
  });

  test("polls pending requests, slows later polls, and returns redacted denial, expiry, and timeout errors", async () => {
    const sleeps: number[] = [];
    const responses = [{ error: "authorization_pending" }, { error: "slow_down" }, { access_token: ACCESS_TOKEN }];
    const token = await pollBmwDeviceAuthorization(authorization, {
      fetch: (async (): Promise<Response> => json(responses.shift())) as typeof fetch,
      sleep: async (milliseconds: number): Promise<void> => { sleeps.push(milliseconds); },
      clock: (): number => 0,
    });
    expect(token).toEqual({ access: ACCESS_TOKEN });
    expect(sleeps).toEqual([1_000, 1_000, 6_000]);

    for (const [payload, code] of [[{ error: "access_denied", detail: DEVICE_CODE }, "BMW_DEVICE_OAUTH_DENIED"], [{ error: "expired_token", detail: ACCESS_TOKEN }, "BMW_DEVICE_OAUTH_EXPIRED"]] as const) {
      const error = await rejected(pollBmwDeviceAuthorization(authorization, { fetch: (async (): Promise<Response> => json(payload)) as typeof fetch, sleep: async (): Promise<void> => undefined, clock: (): number => 0 }));
      expect(error.code).toBe(code);
    }
    const timeout = await rejected(pollBmwDeviceAuthorization({ ...authorization, expiresAt: 1_000 }, { sleep: async (): Promise<void> => undefined, clock: (): number => 0 }));
    expect(timeout.code).toBe("BMW_DEVICE_OAUTH_TIMEOUT");

    for (const [fetcher, code] of [
      [(async (): Promise<Response> => json({ error: DEVICE_CODE }, 503)) as typeof fetch, "BMW_DEVICE_OAUTH_PROTOCOL_ERROR"],
      [(async (): Promise<Response> => new Response(`{${ACCESS_TOKEN}`, { status: 200 })) as typeof fetch, "BMW_DEVICE_OAUTH_PROTOCOL_ERROR"],
      [(async (): Promise<Response> => { throw new Error(AUTHORIZATION); }) as typeof fetch, "BMW_DEVICE_OAUTH_NETWORK_ERROR"],
    ] as const) {
      const error = await rejected(pollBmwDeviceAuthorization(authorization, { fetch: fetcher, sleep: async (): Promise<void> => undefined, clock: (): number => 0 }));
      expect(error.code).toBe(code);
    }
  });

  test("rejects invalid poll intervals before polling without exposing secrets", async () => {
    for (const pollIntervalMs of [0, -1_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      let fetchCalls = 0;
      let sleepCalls = 0;
      const error = await rejected(pollBmwDeviceAuthorization(
        { ...authorization, pollIntervalMs },
        {
          fetch: (async (): Promise<Response> => {
            fetchCalls += 1;
            return json({ access_token: ACCESS_TOKEN });
          }) as typeof fetch,
          sleep: async (): Promise<void> => { sleepCalls += 1; },
        },
      ));
      expect(error.code).toBe("BMW_DEVICE_OAUTH_PROTOCOL_ERROR");
      expect(fetchCalls).toBe(0);
      expect(sleepCalls).toBe(0);
    }
  });

  test("times out redacted when token fetch or poll sleep never settles", async () => {
    const fetchTimer = controllableDeadlineTimer();
    const hungFetch = deferred<Response>();
    const fetchStarted = deferred<void>();
    const fetchTimeoutPromise = pollBmwDeviceAuthorization(
      { ...authorization, expiresAt: 100_000 },
      {
        ...fetchTimer,
        fetch: (() => {
          fetchStarted.resolve();
          return hungFetch.promise;
        }) as typeof fetch,
        sleep: async (): Promise<void> => undefined,
        clock: (): number => 0,
      },
    );
    await fetchStarted.promise;
    fetchTimer.fireDeadline();
    const fetchTimeout = await rejected(fetchTimeoutPromise);
    expect(fetchTimeout.code).toBe("BMW_DEVICE_OAUTH_TIMEOUT");
    expect(fetchTimer.clearedTimers).toHaveLength(2);
    hungFetch.reject(new Error(AUTHORIZATION));
    await Promise.resolve();

    const sleepTimer = controllableDeadlineTimer();
    const hungSleep = deferred<void>();
    let sleepStarted = false;
    const sleepTimeoutPromise = pollBmwDeviceAuthorization(
      { ...authorization, expiresAt: 100_000 },
      {
        ...sleepTimer,
        fetch: (async (): Promise<Response> => json({ access_token: ACCESS_TOKEN })) as typeof fetch,
        sleep: (): Promise<void> => {
          sleepStarted = true;
          return hungSleep.promise;
        },
        clock: (): number => 0,
      },
    );
    expect(sleepStarted).toBe(true);
    sleepTimer.fireDeadline();
    const sleepTimeout = await rejected(sleepTimeoutPromise);
    expect(sleepTimeout.code).toBe("BMW_DEVICE_OAUTH_TIMEOUT");
    expect(sleepTimer.clearedTimers).toHaveLength(1);
    hungSleep.reject(new Error(AUTHORIZATION));
    await Promise.resolve();
  });

  test("redacts malformed, HTTP, and network device authorization failures and makes callback fail", async () => {
    const cases: Array<readonly [typeof fetch, string]> = [
      [(async (): Promise<Response> => json({ device_code: DEVICE_CODE }, 200)) as typeof fetch, "BMW_DEVICE_OAUTH_PROTOCOL_ERROR"],
      [(async (): Promise<Response> => json({ error: `${DEVICE_CODE}:${ACCESS_TOKEN}` }, 500)) as typeof fetch, "BMW_DEVICE_OAUTH_PROTOCOL_ERROR"],
      [(async (): Promise<Response> => new Response(`{${DEVICE_CODE}:${USER_CODE}`, { status: 200 })) as typeof fetch, "BMW_DEVICE_OAUTH_PROTOCOL_ERROR"],
      [(async (): Promise<Response> => { throw new Error(`${DEVICE_CODE}:${AUTHORIZATION}`); }) as typeof fetch, "BMW_DEVICE_OAUTH_NETWORK_ERROR"],
    ];
    for (const [fetcher, code] of cases) {
      const error = await rejected(requestBmwDeviceAuthorization({ fetch: fetcher, clock: (): number => 0 }));
      expect(error.code).toBe(code);
    }
    const method = createBmwDeviceOAuthMethod({ fetch: (async (): Promise<Response> => json({ device_code: DEVICE_CODE, user_code: USER_CODE, verification_uri: "https://bmw.ghe.com/device", expires_in: 60 })) as typeof fetch, sleep: async (): Promise<void> => undefined, clock: (): number => 0 });
    expect(await (await method.authorize()).callback()).toEqual({ type: "failed" });
  });
});
