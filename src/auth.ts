export const BMW_DEVICE_CODE_ENDPOINT = "https://bmw.ghe.com/login/device/code";
export const BMW_TOKEN_ENDPOINT = "https://bmw.ghe.com/login/oauth/access_token";
export const BMW_OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const BMW_OAUTH_SCOPE = "read:user";
export const BMW_DEVICE_OAUTH_LABEL = "BMW Copilot device login";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const SLOW_DOWN_INTERVAL_MS = 5_000;

export type BmwDeviceOAuthErrorCode =
  | "BMW_DEVICE_OAUTH_PROTOCOL_ERROR"
  | "BMW_DEVICE_OAUTH_NETWORK_ERROR"
  | "BMW_DEVICE_OAUTH_DENIED"
  | "BMW_DEVICE_OAUTH_EXPIRED"
  | "BMW_DEVICE_OAUTH_TIMEOUT";

export class BmwDeviceOAuthError extends Error {
  readonly code: BmwDeviceOAuthErrorCode;

  constructor(code: BmwDeviceOAuthErrorCode) {
    super("BMW device OAuth failed.");
    this.name = "BmwDeviceOAuthError";
    this.code = code;
  }
}

export interface BmwDeviceOAuthDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly clock?: () => number;
  readonly setDeadlineTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearDeadlineTimer?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
}

export interface BmwDeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresAt: number;
  readonly pollIntervalMs: number;
}

export interface BmwDeviceOAuthToken {
  readonly access: string;
}

export interface CallbackSuccess {
  readonly type: "success";
  readonly access: string;
  readonly refresh: string;
  readonly expires: 0;
}

export interface CallbackFailed {
  readonly type: "failed";
}

export type CallbackResult = CallbackSuccess | CallbackFailed;

export interface BmwDeviceOAuthMethod {
  readonly type: "oauth";
  readonly label: typeof BMW_DEVICE_OAUTH_LABEL;
  authorize(): Promise<{
    readonly url: string;
    readonly instructions: string;
    readonly method: "auto";
    callback(): Promise<CallbackResult>;
  }>;
}

interface ResolvedDependencies {
  readonly fetch: typeof globalThis.fetch;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly clock: () => number;
  readonly setDeadlineTimer: (callback: () => void, milliseconds: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearDeadlineTimer: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
}

export function createBmwDeviceOAuthMethod(dependencies: BmwDeviceOAuthDependencies = {}): BmwDeviceOAuthMethod {
  const resolvedDependencies: ResolvedDependencies = resolveDependencies(dependencies);

  return {
    type: "oauth",
    label: BMW_DEVICE_OAUTH_LABEL,
    async authorize(): Promise<{
      readonly url: string;
      readonly instructions: string;
      readonly method: "auto";
      callback(): Promise<CallbackResult>;
    }> {
      const authorization = await requestBmwDeviceAuthorization(resolvedDependencies);
      return {
        url: authorization.verificationUrl,
        instructions: `Open the URL and enter code ${authorization.userCode}.`,
        method: "auto",
        async callback(): Promise<CallbackResult> {
          try {
            const token = await pollBmwDeviceAuthorization(authorization, resolvedDependencies);
            return { type: "success", access: token.access, refresh: token.access, expires: 0 };
          } catch {
            return { type: "failed" };
          }
        },
      };
    },
  };
}

export async function requestBmwDeviceAuthorization(
  dependencies: BmwDeviceOAuthDependencies = {},
): Promise<BmwDeviceAuthorization> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const response = await postForm(resolvedDependencies.fetch, BMW_DEVICE_CODE_ENDPOINT, {
    client_id: BMW_OAUTH_CLIENT_ID,
    scope: BMW_OAUTH_SCOPE,
  });
  const payload = await responsePayload(response);

  if (!response.ok) throw protocolError();

  const deviceCode = readNonEmptyString(payload, "device_code");
  const userCode = readNonEmptyString(payload, "user_code");
  const verificationUrl = readVerificationUrl(payload);
  const expiresIn = readPositiveFiniteNumber(payload, "expires_in");
  const expiresAt = resolvedDependencies.clock() + expiresIn * 1_000;
  if (!Number.isFinite(expiresAt)) throw protocolError();

  const intervalSeconds = readOptionalPositiveFiniteNumber(payload, "interval");
  const pollIntervalMs = (intervalSeconds ?? DEFAULT_POLL_INTERVAL_MS / 1_000) * 1_000;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw protocolError();

  return { deviceCode, userCode, verificationUrl, expiresAt, pollIntervalMs };
}

export async function pollBmwDeviceAuthorization(
  authorization: BmwDeviceAuthorization,
  dependencies: BmwDeviceOAuthDependencies = {},
): Promise<BmwDeviceOAuthToken> {
  if (!Number.isFinite(authorization.pollIntervalMs) || authorization.pollIntervalMs <= 0) throw protocolError();

  const resolvedDependencies = resolveDependencies(dependencies);
  let pollIntervalMs = authorization.pollIntervalMs;

  while (true) {
    await waitForPollInterval(authorization.expiresAt, pollIntervalMs, resolvedDependencies);
    const response = await raceUntilDeadline(
      postForm(resolvedDependencies.fetch, BMW_TOKEN_ENDPOINT, {
        client_id: BMW_OAUTH_CLIENT_ID,
        device_code: authorization.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      authorization.expiresAt,
      resolvedDependencies,
    );
    const payload = await responsePayload(response);
    const oauthError = readOptionalString(payload, "error");

    if (oauthError === "authorization_pending") continue;
    if (oauthError === "slow_down") {
      pollIntervalMs += SLOW_DOWN_INTERVAL_MS;
      if (!Number.isFinite(pollIntervalMs)) throw protocolError();
      continue;
    }
    if (oauthError === "access_denied") throw new BmwDeviceOAuthError("BMW_DEVICE_OAUTH_DENIED");
    if (oauthError === "expired_token") throw new BmwDeviceOAuthError("BMW_DEVICE_OAUTH_EXPIRED");
    if (!response.ok) throw protocolError();

    const access = readNonEmptyString(payload, "access_token");
    return { access };
  }
}

function resolveDependencies(dependencies: BmwDeviceOAuthDependencies): ResolvedDependencies {
  return {
    fetch: dependencies.fetch ?? globalThis.fetch,
    sleep: dependencies.sleep ?? defaultSleep,
    clock: dependencies.clock ?? Date.now,
    setDeadlineTimer: dependencies.setDeadlineTimer ?? globalThis.setTimeout,
    clearDeadlineTimer: dependencies.clearDeadlineTimer ?? globalThis.clearTimeout,
  };
}

async function postForm(
  fetch: typeof globalThis.fetch,
  url: string,
  values: Readonly<Record<string, string>>,
): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
    });
  } catch {
    throw new BmwDeviceOAuthError("BMW_DEVICE_OAUTH_NETWORK_ERROR");
  }
}

async function responsePayload(response: Response): Promise<Readonly<Record<string, unknown>>> {
  try {
    const payload: unknown = await response.json();
    if (!isRecord(payload)) throw protocolError();
    return payload;
  } catch (error: unknown) {
    if (error instanceof BmwDeviceOAuthError) throw error;
    throw protocolError();
  }
}

async function waitForPollInterval(
  expiresAt: number,
  pollIntervalMs: number,
  dependencies: ResolvedDependencies,
): Promise<void> {
  const remainingMs = expiresAt - dependencies.clock();
  if (!Number.isFinite(remainingMs) || remainingMs <= pollIntervalMs) {
    throw new BmwDeviceOAuthError("BMW_DEVICE_OAUTH_TIMEOUT");
  }
  try {
    await raceUntilDeadline(dependencies.sleep(pollIntervalMs), expiresAt, dependencies);
  } catch (error: unknown) {
    if (error instanceof BmwDeviceOAuthError && error.code === "BMW_DEVICE_OAUTH_TIMEOUT") throw error;
    throw new BmwDeviceOAuthError("BMW_DEVICE_OAUTH_NETWORK_ERROR");
  }
  if (dependencies.clock() >= expiresAt) throw new BmwDeviceOAuthError("BMW_DEVICE_OAUTH_TIMEOUT");
}

async function raceUntilDeadline<T>(operation: Promise<T>, expiresAt: number, dependencies: ResolvedDependencies): Promise<T> {
  const remainingMs = expiresAt - dependencies.clock();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new BmwDeviceOAuthError("BMW_DEVICE_OAUTH_TIMEOUT");
  }

  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject): void => {
    timer = dependencies.setDeadlineTimer((): void => reject(new BmwDeviceOAuthError("BMW_DEVICE_OAUTH_TIMEOUT")), remainingMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) dependencies.clearDeadlineTimer(timer);
  }
}

function readVerificationUrl(payload: Readonly<Record<string, unknown>>): string {
  const candidate = readOptionalString(payload, "verification_uri_complete")
    ?? readOptionalString(payload, "verification_uri");
  if (candidate === undefined) throw protocolError();

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw protocolError();
    return url.toString();
  } catch (error: unknown) {
    if (error instanceof BmwDeviceOAuthError) throw error;
    throw protocolError();
  }
}

function readNonEmptyString(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = readOptionalString(payload, key);
  if (value === undefined) throw protocolError();
  return value;
}

function readOptionalString(payload: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value: unknown = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readPositiveFiniteNumber(payload: Readonly<Record<string, unknown>>, key: string): number {
  const value = readOptionalPositiveFiniteNumber(payload, key);
  if (value === undefined) throw protocolError();
  return value;
}

function readOptionalPositiveFiniteNumber(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value: unknown = payload[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolError(): BmwDeviceOAuthError {
  return new BmwDeviceOAuthError("BMW_DEVICE_OAUTH_PROTOCOL_ERROR");
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve: () => void): void => {
    globalThis.setTimeout(resolve, milliseconds);
  });
}
