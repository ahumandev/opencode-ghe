import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  DEFAULT_BASE_URL,
  FIXED_PROMPT,
  REDACTED,
  buildRequest,
  executeProbe,
  parseArguments,
  parseConfig,
  redactUrl,
  sanitizeHeaders,
  sanitizeValue,
  selectEndpoint,
  validateBaseUrl,
  type FetchFunction,
  type ProbeConfig,
} from "../src/contract-probe.ts";

function secretValue(): string {
  return ["private", "probe", "value"].join("-");
}

function config(overrides: Partial<ProbeConfig> = {}): ProbeConfig {
  return {
    baseUrl: DEFAULT_BASE_URL,
    model: "gpt-5.6-terra",
    stream: false,
    live: false,
    ...overrides,
  };
}

describe("endpoint and request contract", () => {
  test("uses generic default and selects endpoint by model", () => {
    expect(DEFAULT_BASE_URL).toBe("https://ghe.example.test");
    expect(selectEndpoint("gpt-5.6-terra")).toBe("responses");
    expect(selectEndpoint("gpt-5.6-luna")).toBe("responses");
    expect(selectEndpoint("other-model")).toBe("chat");
  });

  test("builds exact responses request", () => {
    expect(buildRequest(config())).toEqual({
      url: "https://ghe.example.test/responses",
      method: "POST",
      headers: {
        Authorization: "Bearer <redacted>",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: { model: "gpt-5.6-terra", input: FIXED_PROMPT, stream: false },
      endpoint: "responses",
    });
  });

  test("builds exact streamed chat request", () => {
    expect(buildRequest(config({ model: "other-model", stream: true }))).toEqual({
      url: "https://ghe.example.test/chat/completions",
      method: "POST",
      headers: {
        Authorization: "Bearer <redacted>",
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: { model: "other-model", messages: [{ role: "user", content: FIXED_PROMPT }], stream: true },
      endpoint: "chat",
    });
  });
});

describe("configuration contract", () => {
  test("preserves HTTPS base paths and rejects unsafe base URL boundaries", () => {
    expect(validateBaseUrl("https://ghe.example.test/")).toBe("https://ghe.example.test/");
    expect(validateBaseUrl("https://host/custom/v1/")).toBe("https://host/custom/v1/");
    for (const value of ["not-a-url", "http://ghe.example.test", "https://name:password@ghe.example.test", "https://ghe.example.test/?value=1", "https://ghe.example.test/#part"]) {
      expect((): string => validateBaseUrl(value)).toThrow(ConfigError);
    }
  });

  test("joins configured base paths without duplicate path slashes", () => {
    const baseUrl = "https://host/custom/v1/";
    expect(buildRequest(config({ baseUrl, model: "other-model" })).url).toBe("https://host/custom/v1/chat/completions");
    expect(buildRequest(config({ baseUrl, model: "gpt-5.6-terra" })).url).toBe("https://host/custom/v1/responses");
  });

  test("rejects unknown, missing, blank, and duplicate arguments", () => {
    expect((): unknown => parseArguments(["--unknown"])).toThrow("Unknown argument: --unknown.");
    for (const args of [["--model"], ["--base-url"], ["--output"], ["--model", "  "]] as const) {
      expect((): unknown => parseArguments(args)).toThrow("Missing value");
    }
    expect((): unknown => parseArguments(["--stream", "--stream"])).toThrow("Duplicate flag: --stream.");
    expect((): unknown => parseArguments(["--model", "first", "--model", "second"])).toThrow("Duplicate option: --model.");
  });

  test("requires model and token only for live probes", () => {
    expect((): unknown => parseConfig([], undefined)).toThrow("Missing required option: --model.");
    expect((): unknown => parseConfig(["--model", "other-model", "--live"], "   ")).toThrow("--live requires nonblank BMW_GHE_TOKEN.");
    expect(parseConfig(["--model", "other-model"], undefined)).toMatchObject({ live: false });
  });
});

describe("sanitization contract", () => {
  test("redacts URL credentials and every query value without serializing secrets", () => {
    const secret = secretValue();
    const redacted = redactUrl(`https://user:${secret}@example.test/path?Token=${secret}&safe=value&empty=`);
    const parsed = new URL(redacted);
    expect([decodeURIComponent(parsed.username), decodeURIComponent(parsed.password)]).toEqual([REDACTED, REDACTED]);
    expect(Array.from(parsed.searchParams.values())).toEqual([REDACTED, REDACTED, REDACTED]);
    expect(JSON.stringify({ redacted })).not.toContain(secret);
  });

  test("recursively minimizes sensitive values and ordinary text", () => {
    const secret = secretValue();
    const sanitized = {
      headers: sanitizeHeaders({ Authorization: secret, COOKIE: secret, "Set-Cookie": secret, "x-API-key": secret, Accept: "application/json" }),
      body: sanitizeValue({ nested: { ToKeN: secret, ordinary: secret }, items: [{ Credential: secret }, [secret, { api_key: secret }]] }),
    };
    expect(sanitized).toEqual({
      headers: { Authorization: REDACTED, COOKIE: REDACTED, "Set-Cookie": REDACTED, "x-API-key": REDACTED, Accept: "application/json" },
      body: { nested: { ToKeN: REDACTED, ordinary: REDACTED }, items: [{ Credential: REDACTED }, [REDACTED, { api_key: REDACTED }]] },
    });
    expect(JSON.stringify(sanitized)).not.toContain(secret);
  });
});

describe("execution contract", () => {
  test("live false dry run makes zero fetches and serializes no token", async () => {
    const secret = secretValue();
    let calls = 0;
    const fetchFunction: FetchFunction = async (): Promise<Response> => {
      calls += 1;
      throw new Error("Unexpected fetch.");
    };
    const result = await executeProbe(config({ live: false, token: secret }), fetchFunction);
    expect(result).toMatchObject({ method: "dry-run", ok: true });
    expect(calls).toBe(0);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.fixture.request.headers.Authorization).toBe(REDACTED);
  });

  test("live missing token fails before fetch", async () => {
    let calls = 0;
    const fetchFunction: FetchFunction = async (): Promise<Response> => {
      calls += 1;
      return new Response();
    };
    await expect(executeProbe(config({ live: true }), fetchFunction)).rejects.toThrow("--live requires nonblank BMW_GHE_TOKEN.");
    expect(calls).toBe(0);
  });

  test("captures sanitized non-stream JSON", async () => {
    const secret = secretValue();
    const fetchFunction: FetchFunction = async (input, init): Promise<Response> => {
      expect(String(input)).toBe("https://ghe.example.test/responses");
      expect(init).toMatchObject({ method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json" } });
      expect(init?.body).toBe(JSON.stringify({ model: "gpt-5.6-terra", input: FIXED_PROMPT, stream: false }));
      return new Response(JSON.stringify({ result: secret }), { status: 200, headers: { "X-Token": secret } });
    };
    const result = await executeProbe(config({ live: true, token: secret }), fetchFunction);
    expect(result).toEqual({
      method: "live",
      ok: true,
      fixture: {
        request: expect.any(Object),
        response: { status: 200, statusText: "", headers: { "x-token": REDACTED }, body: { result: REDACTED } },
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("captures multiple sanitized SSE events without raw text", async () => {
    const secret = secretValue();
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode(`event: update\ndata: {"value":"${secret}"}\n\ndata: malformed-${secret}\ndata: [DONE]\nretry: ${secret}\n`));
        controller.close();
      },
    });
    const result = await executeProbe(config({ model: "other-model", stream: true, live: true, token: secret }), async (): Promise<Response> => new Response(stream, { status: 200 }));
    expect(result.fixture.response?.body).toEqual({ type: "sse", events: [{ field: "event", value: REDACTED }, { field: "data", json: { value: REDACTED } }, { field: "data", text: REDACTED }, { field: "data", done: true }, { field: "retry", value: REDACTED }] });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("captures non-2xx responses and fetch failures without secrets", async () => {
    const secret = secretValue();
    const non2xx = await executeProbe(config({ live: true, token: secret }), async (): Promise<Response> => new Response(JSON.stringify({ detail: secret }), { status: 401, statusText: "Unauthorized" }));
    expect(non2xx).toMatchObject({ ok: false, fixture: { response: { status: 401, statusText: "Unauthorized", body: { detail: REDACTED } } } });
    const failure = await executeProbe(config({ live: true, token: secret }), async (): Promise<Response> => Promise.reject(new Error(secret)));
    expect(failure).toEqual(expect.objectContaining({ ok: false, fixture: expect.objectContaining({ error: { name: "Error", message: REDACTED } }) }));
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  test("sanitizes empty, malformed, and unreadable response bodies", async () => {
    const secret = secretValue();
    const empty = await executeProbe(config({ live: true, token: secret }), async (): Promise<Response> => new Response("", { status: 200 }));
    const malformed = await executeProbe(config({ live: true, token: secret }), async (): Promise<Response> => new Response(`malformed-${secret}`, { status: 200 }));
    const unreadableResponse = { status: 200, statusText: "", ok: true, headers: new Headers(), text: async (): Promise<string> => Promise.reject(new Error(secret)) } as unknown as Response;
    const unreadable = await executeProbe(config({ live: true, token: secret }), async (): Promise<Response> => unreadableResponse);
    expect(empty.fixture.response?.body).toBeNull();
    expect(malformed.fixture.response?.body).toBe(REDACTED);
    expect(unreadable.fixture.error).toEqual({ name: "Error", message: REDACTED });
    expect(JSON.stringify({ empty, malformed, unreadable })).not.toContain(secret);
  });
});
