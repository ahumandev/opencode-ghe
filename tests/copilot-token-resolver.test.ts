import { describe, expect, test } from "bun:test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { createAdapterConfig, GhePluginConfigError, parseGhePluginOptions } from "../src/config.ts";
import { createGhe } from "../src/plugin.ts";
import {
  ConfigurationError,
  CopilotTokenExchangeError,
  CopilotTokenResolver,
  HttpError,
  MalformedResponseError,
  NetworkError,
  createGheProtocolAdapter,
  type GheProtocolAdapter,
} from "../src/ghe-protocol.ts";

const API_BASE = "https://ghe.example.test/copilot";
const EXCHANGE_URL = "https://ghe.example.test/copilot_internal/v2/token";
const CUSTOM_EXCHANGE_URL = "https://oauth.example.test/copilot_internal/v2/token";
const OAUTH_SECRET = "synthetic-oauth-secret";
const API_SECRET = "synthetic-api-secret";
const COPILOT_SECRET = "synthetic-copilot-secret";
const REQUEST_ID = "synthetic-request-id";

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function response(payload: unknown, status: number = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers });
}

function chatResponse(): Response {
  return response({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
}

function headers(call: Call): Record<string, string> {
  return call.init?.headers as Record<string, string>;
}

function body(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function request(messages: ReadonlyArray<{ readonly role: "system" | "user" | "assistant" | "tool"; readonly content: string }> = [{ role: "system", content: "rules" }, { role: "user", content: "hello" }]): { readonly model: string; readonly messages: typeof messages } {
  return { model: "github_copilot/claude-haiku-4.5", messages };
}

function staticAdapter(fetcher: typeof fetch, overrides: Record<string, unknown> = {}): GheProtocolAdapter {
  return createGheProtocolAdapter({
    baseUrl: API_BASE,
    copilotHeaders: {},
    credential: API_SECRET,
    fetch: fetcher,
    requestIdFactory: (): string => REQUEST_ID,
    ...overrides,
  });
}

function assertSecretFree(error: Error): void {
  const exposed = [error.message, String(error), JSON.stringify(error), ...Object.values(error)].join(" ");
  expect(exposed).not.toContain(OAUTH_SECRET);
  expect(exposed).not.toContain(API_SECRET);
  expect(exposed).not.toContain(COPILOT_SECRET);
}

async function rejected(value: Promise<unknown>): Promise<Error> {
  try {
    await value;
    throw new Error("Expected rejection.");
  } catch (error: unknown) {
    const result = error instanceof Error ? error : new Error(String(error));
    assertSecretFree(result);
    return result;
  }
}

async function atTime<T>(now: number, action: () => Promise<T>): Promise<T> {
  const original = Date.now;
  Date.now = (): number => now;
  try {
    return await action();
  } finally {
    Date.now = original;
  }
}

describe("Copilot token resolver", () => {
  test("prefers stored OAuth loader token, normalizes valid exchange token, and validates metadata", async () => {
    const calls: Call[] = [];
    const resolver = new CopilotTokenResolver({
      baseUrl: API_BASE,
      tokenEndpoint: EXCHANGE_URL,
      oauthToken: "fallback-oauth-secret",
      oauthTokenLoader: async (): Promise<string | undefined> => OAUTH_SECRET,
    });
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return response({ token: ` ${COPILOT_SECRET} `, expires_at: 1_000, endpoints: { api: "https://ghe.example.test/api/" } });
    }) as typeof fetch;
    expect(await atTime(0, (): Promise<Awaited<ReturnType<typeof resolver.resolve>>> => resolver.resolve(fetcher))).toEqual({ token: COPILOT_SECRET, apiEndpoint: "https://ghe.example.test/api" });
    expect(headers(calls[0] as Call).authorization).toBe(`token ${OAUTH_SECRET}`);
    for (const payload of [{ token: " \t\n ", expires_at: 1_000 }, { token: COPILOT_SECRET, expires_at: 0 }, { token: COPILOT_SECRET, expires_at: 1_000, refresh_in: 0 }, { token: COPILOT_SECRET, expires_at: 1_000, refresh_in: "9007199254740991" }, { token: COPILOT_SECRET, expires_at: 1_000, endpoints: { api: "https://attacker.example.test/api" } }, { token: COPILOT_SECRET, expires_at: 1_000, endpoints: { api: "http://ghe.example.test/api" } }, { token: COPILOT_SECRET, expires_at: 1_000, endpoints: { api: "https://user:password@ghe.example.test/api" } }, { token: COPILOT_SECRET, expires_at: 1_000, endpoints: { api: "https://ghe.example.test/api?redirect=attacker" } }, { token: COPILOT_SECRET, expires_at: 1_000, endpoints: { api: "https://ghe.example.test/api#attacker" } }]) {
      const error = await rejected(atTime(0, (): Promise<Awaited<ReturnType<typeof resolver.resolve>>> => new CopilotTokenResolver({ baseUrl: API_BASE, tokenEndpoint: EXCHANGE_URL, oauthToken: OAUTH_SECRET }).resolve((async (): Promise<Response> => response(payload)) as typeof fetch)));
      expect(error).toMatchObject({ code: "TOKEN_EXCHANGE_SCHEMA", message: "Copilot token exchange returned invalid token metadata." });
    }
  });

  test("adapter config sends GitHub OAuth credential to configured exchange", async () => {
    const config = createAdapterConfig(parseGhePluginOptions({ baseUrl: API_BASE, credential: { source: "github-oauth", name: "GITHUB_TOKEN", tokenEndpoint: CUSTOM_EXCHANGE_URL } }), { GITHUB_TOKEN: OAUTH_SECRET });
    const calls: Call[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return response({ token: COPILOT_SECRET, expires_at: 1_000 });
    }) as typeof fetch;
    await atTime(0, (): Promise<Awaited<ReturnType<NonNullable<typeof config.credentialResolver>["resolve"]>>> => config.credentialResolver!.resolve(fetcher));
    expect(calls[0]?.url).toBe(CUSTOM_EXCHANGE_URL);
    expect(headers(calls[0] as Call).authorization).toBe(`token ${OAUTH_SECRET}`);
  });

  test("adapter config sends stored OAuth loader token to configured GitHub OAuth exchange", async () => {
    const config = createAdapterConfig(parseGhePluginOptions({ baseUrl: API_BASE, credential: { source: "github-oauth", name: "FALLBACK", tokenEndpoint: CUSTOM_EXCHANGE_URL }, oauthTokenLoader: async (): Promise<string | undefined> => OAUTH_SECRET }), { FALLBACK: API_SECRET });
    const calls: Call[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return response({ token: COPILOT_SECRET, expires_at: 1_000 });
    }) as typeof fetch;
    await atTime(0, (): Promise<Awaited<ReturnType<NonNullable<typeof config.credentialResolver>["resolve"]>>> => config.credentialResolver!.resolve(fetcher));
    expect(calls[0]?.url).toBe(CUSTOM_EXCHANGE_URL);
    expect(headers(calls[0] as Call).authorization).toBe(`token ${OAUTH_SECRET}`);
  });

  test("default OpenCode auth exchanges and caches stored OAuth before sentinel environment credentials", async () => {
    const config = createAdapterConfig(parseGhePluginOptions({ baseUrl: API_BASE, oauthTokenLoader: async (): Promise<string | undefined> => OAUTH_SECRET }), { GHE_COPILOT_TOKEN: API_SECRET });
    const calls: Call[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return response({ token: COPILOT_SECRET, expires_at: 1_000 });
    }) as typeof fetch;
    await atTime(0, (): Promise<Awaited<ReturnType<NonNullable<typeof config.credentialResolver>["resolve"]>>> => config.credentialResolver!.resolve(fetcher));
    await atTime(0, (): Promise<Awaited<ReturnType<NonNullable<typeof config.credentialResolver>["resolve"]>>> => config.credentialResolver!.resolve(fetcher));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.bmw.ghe.com/copilot_internal/v2/token");
    expect(headers(calls[0] as Call).authorization).toBe(`token ${OAUTH_SECRET}`);
  });
  test("accepts BMW API sibling origin and rejects untrusted BMW sibling origin", async () => {
    const resolver = new CopilotTokenResolver({
      baseUrl: "https://copilot-api.bmw.ghe.com",
      tokenEndpoint: "https://api.bmw.ghe.com/copilot_internal/v2/token",
      oauthToken: OAUTH_SECRET,
    });
    const fetcher = (async (): Promise<Response> => response({ token: COPILOT_SECRET, expires_at: 1_000, endpoints: { api: "https://copilot-api.bmw.ghe.com/api" } })) as typeof fetch;
    expect(await atTime(0, (): Promise<Awaited<ReturnType<typeof resolver.resolve>>> => resolver.resolve(fetcher))).toEqual({ token: COPILOT_SECRET, apiEndpoint: "https://copilot-api.bmw.ghe.com/api" });

    const error = await rejected(atTime(0, (): Promise<Awaited<ReturnType<typeof resolver.resolve>>> => new CopilotTokenResolver({
      baseUrl: "https://copilot-api.bmw.ghe.com",
      tokenEndpoint: "https://api.bmw.ghe.com/copilot_internal/v2/token",
      oauthToken: OAUTH_SECRET,
    }).resolve((async (): Promise<Response> => response({ token: COPILOT_SECRET, expires_at: 1_000, endpoints: { api: "https://other-api.bmw.ghe.com/api" } })) as typeof fetch)));
    expect(error).toMatchObject({ code: "TOKEN_EXCHANGE_SCHEMA", message: "Copilot token exchange returned invalid token metadata." });
  });
  test("exchanges OAuth token with exact GET contract and uses returned API endpoint without implicit v1", async () => {
    const calls: Call[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) return response({ token: COPILOT_SECRET, expires_at: "1000", refresh_in: "600", endpoints: { api: "https://ghe.example.test/api/" } });
      return chatResponse();
    }) as typeof fetch;
    const resolver = new CopilotTokenResolver({ baseUrl: API_BASE, tokenEndpoint: EXCHANGE_URL, oauthToken: OAUTH_SECRET });
    const adapter = createGheProtocolAdapter({ baseUrl: API_BASE, copilotHeaders: {}, credentialResolver: resolver, fetch: fetcher, requestIdFactory: (): string => REQUEST_ID });

    await atTime(0, async (): Promise<void> => { await adapter.complete(request()); });

    expect(calls[0]).toEqual({
      url: EXCHANGE_URL,
      init: {
        method: "GET",
        headers: {
          authorization: `token ${OAUTH_SECRET}`,
          accept: "application/json",
          "content-type": "application/json",
          "editor-version": "vscode/1.85.1",
          "editor-plugin-version": "copilot/1.155.0",
          "user-agent": "GithubCopilot/1.155.0",
          "accept-encoding": "gzip,deflate,br",
        },
      },
    });
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(headers(calls[0] as Call)).not.toHaveProperty("x-github-api-version");
    expect(calls[1]?.url).toBe("https://ghe.example.test/api/chat/completions");
    expect(calls[1]?.url).not.toContain("/v1");
    expect(headers(calls[1] as Call).Authorization).toBe(`Bearer ${COPILOT_SECRET}`);
  });

  test("caches token, replaces refresh-due and expired tokens, and coalesces concurrent exchanges", async () => {
    let calls = 0;
    const fetcher = (async (): Promise<Response> => {
      calls += 1;
      return response({ token: `token-${calls}`, expires_at: calls === 1 ? "100" : calls === 2 ? 200 : "300", refresh_in: calls === 1 ? "600" : 600 });
    }) as typeof fetch;
    const resolver = new CopilotTokenResolver({ baseUrl: API_BASE, tokenEndpoint: EXCHANGE_URL, oauthToken: OAUTH_SECRET });

    expect((await atTime(0, (): Promise<Awaited<ReturnType<typeof resolver.resolve>>> => resolver.resolve(fetcher))).token).toBe("token-1");
    expect((await atTime(69_999, (): Promise<Awaited<ReturnType<typeof resolver.resolve>>> => resolver.resolve(fetcher))).token).toBe("token-1");
    expect((await atTime(70_000, (): Promise<Awaited<ReturnType<typeof resolver.resolve>>> => resolver.resolve(fetcher))).token).toBe("token-2");
    expect((await atTime(200_000, (): Promise<Awaited<ReturnType<typeof resolver.resolve>>> => resolver.resolve(fetcher))).token).toBe("token-3");
    expect(calls).toBe(3);

    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve: () => void): void => { release = resolve; });
    const concurrentFetcher = (async (): Promise<Response> => {
      calls += 1;
      await pending;
      return response({ token: "coalesced", expires_at: 1_000, refresh_in: 60 });
    }) as typeof fetch;
    const concurrent = new CopilotTokenResolver({ baseUrl: API_BASE, tokenEndpoint: EXCHANGE_URL, oauthToken: OAUTH_SECRET });
    const first = atTime(0, (): Promise<Awaited<ReturnType<typeof concurrent.resolve>>> => concurrent.resolve(concurrentFetcher));
    const second = atTime(0, (): Promise<Awaited<ReturnType<typeof concurrent.resolve>>> => concurrent.resolve(concurrentFetcher));
    release?.();
    expect(await Promise.all([first, second])).toEqual([{ token: "coalesced" }, { token: "coalesced" }]);
  });

  test("clears failed refresh state so an immediate retry replaces expired cache", async () => {
    let attempts = 0;
    const retryFetcher = (async (): Promise<Response> => {
      attempts += 1;
      if (attempts === 1) return response({ token: "cached-token", expires_at: 1_000, refresh_in: 60 });
      if (attempts === 2) throw new Error(OAUTH_SECRET);
      return response({ token: "retry-token", expires_at: 1_000, refresh_in: 60 });
    }) as typeof fetch;
    const retry = new CopilotTokenResolver({ baseUrl: API_BASE, tokenEndpoint: EXCHANGE_URL, oauthToken: OAUTH_SECRET });
    expect((await atTime(0, (): Promise<Awaited<ReturnType<typeof retry.resolve>>> => retry.resolve(retryFetcher))).token).toBe("cached-token");
    const failure = await rejected(atTime(70_000, (): Promise<Awaited<ReturnType<typeof retry.resolve>>> => retry.resolve(retryFetcher)));
    expect(failure).toMatchObject({ code: "TOKEN_EXCHANGE_NETWORK" });
    expect((await atTime(70_000, (): Promise<Awaited<ReturnType<typeof retry.resolve>>> => retry.resolve(retryFetcher))).token).toBe("retry-token");
    expect(attempts).toBe(3);
  });

  test("exposes exact redacted exchange error contracts", async () => {
    const cases: Array<readonly [typeof fetch, Record<string, unknown>]> = [
      [(async (): Promise<Response> => response({ detail: `${OAUTH_SECRET}:${API_SECRET}:${COPILOT_SECRET}` }, 401, { "x-github-request-id": "exchange-id" })) as typeof fetch, { code: "TOKEN_EXCHANGE_HTTP", status: 401, requestId: "exchange-id", message: "Copilot token exchange was rejected." }],
      [(async (): Promise<Response> => { throw new Error(`${OAUTH_SECRET}:${API_SECRET}:${COPILOT_SECRET}`); }) as typeof fetch, { code: "TOKEN_EXCHANGE_NETWORK", message: "Copilot token exchange failed." }],
      [(async (): Promise<Response> => new Response(`{${OAUTH_SECRET}:${API_SECRET}:${COPILOT_SECRET}`, { status: 200 })) as typeof fetch, { code: "TOKEN_EXCHANGE_PARSE", message: "Copilot token exchange returned invalid JSON." }],
      [(async (): Promise<Response> => response({ token: COPILOT_SECRET, expires_at: "invalid", refresh_in: 60, secret: `${OAUTH_SECRET}:${API_SECRET}` })) as typeof fetch, { code: "TOKEN_EXCHANGE_SCHEMA", message: "Copilot token exchange returned invalid token metadata." }],
    ];
    for (const [fetcher, expected] of cases) {
      const error = await rejected(new CopilotTokenResolver({ baseUrl: API_BASE, tokenEndpoint: EXCHANGE_URL, oauthToken: OAUTH_SECRET }).resolve(fetcher));
      expect(error).toBeInstanceOf(CopilotTokenExchangeError);
      expect(error).toMatchObject(expected);
      expect(error.message).toBe(expected.message);
      if (expected.status !== undefined) expect(error).toHaveProperty("status", expected.status);
      if (expected.status === undefined) expect(error).toHaveProperty("status", undefined);
      if (expected.requestId !== undefined) expect(error).toHaveProperty("requestId", expected.requestId);
      if (expected.requestId === undefined) expect(error).toHaveProperty("requestId", undefined);
    }
  });
});

describe("Copilot chat contract", () => {
  test("createGhe static API key overrides OAuth loader and environment fallback", async () => {
    const calls: Call[] = [];
    let loaderCalls = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return chatResponse();
    }) as typeof fetch;
    const sdk = createGhe({
      baseURL: API_BASE,
      apiKey: API_SECRET,
      credential: { source: "env", name: "COMPETING_COPILOT_TOKEN" },
      oauthTokenLoader: async (): Promise<never> => {
        loaderCalls += 1;
        throw new Error("OAuth loader must not run when apiKey is configured.");
      },
      fetch: fetcher,
    });

    await sdk.languageModel("github_copilot/claude-haiku-4.5").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    } as unknown as LanguageModelV3CallOptions);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${API_BASE}/chat/completions`);
    expect(headers(calls[0] as Call).Authorization).toBe(`Bearer ${API_SECRET}`);
    expect(loaderCalls).toBe(0);
  });

  test("uses static and environment API tokens without exchange", async () => {
    const calls: Call[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return chatResponse();
    }) as typeof fetch;
    await staticAdapter(fetcher).complete(request());
    const config = createAdapterConfig(parseGhePluginOptions({ baseUrl: "https://env.example.test/custom", credential: { source: "env", name: "COPILOT_API_TOKEN" } }), { COPILOT_API_TOKEN: API_SECRET });
    await createGheProtocolAdapter({ ...config, fetch: fetcher, requestIdFactory: (): string => REQUEST_ID }).complete(request());
    expect(calls).toHaveLength(2);
    expect(calls.map((call: Call): string => call.url)).toEqual([`${API_BASE}/chat/completions`, "https://env.example.test/custom/chat/completions"]);
    expect(calls.map((call: Call): string => headers(call).Authorization)).toEqual([`Bearer ${API_SECRET}`, `Bearer ${API_SECRET}`]);
  });

  test("sends exact protected chat headers and rejects case-insensitive overrides", async () => {
    const calls: Call[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return chatResponse();
    }) as typeof fetch;
    await staticAdapter(fetcher, { copilotHeaders: { "X-Copilot-Feature": "synthetic" } }).complete(request());
    expect(headers(calls[0] as Call)).toEqual({
      "X-Copilot-Feature": "synthetic",
      "copilot-integration-id": "vscode-chat",
      "editor-version": "vscode/1.95.0",
      "editor-plugin-version": "copilot-chat/0.26.7",
      "user-agent": "GitHubCopilotChat/0.26.7",
      "openai-intent": "conversation-panel",
      "x-github-api-version": "2025-04-01",
      "x-request-id": REQUEST_ID,
      "x-vscode-user-agent-library-version": "electron-fetch",
      "X-Initiator": "user",
      "content-type": "application/json",
      Authorization: `Bearer ${API_SECRET}`,
    });
    for (const name of ["aUtHoRiZaTiOn", "CoNtEnT-TyPe", "CoPiLoT-InTeGrAtIoN-Id", "EdItOr-VeRsIoN", "EdItOr-PlUgIn-VeRsIoN", "UsEr-AgEnT", "OpEnAi-InTeNt", "X-GiThUb-ApI-VeRsIoN", "X-ReQuEsT-Id", "X-VsCoDe-UsEr-AgEnT-LiBrArY-VeRsIoN", "X-InItIaToR"]) {
      expect((): GheProtocolAdapter => staticAdapter(fetcher, { copilotHeaders: { [name]: "override" } })).toThrow(ConfigurationError);
    }
  });

  test("sets initiator and system roles for chat and responses profiles", async () => {
    const calls: Call[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return String(input).endsWith("/responses") ? response({ status: "completed", output: [{ type: "message", content: "ok" }] }) : chatResponse();
    }) as typeof fetch;
    const adapter = staticAdapter(fetcher);
    await adapter.complete(request());
    await adapter.complete(request([{ role: "system", content: "rules" }, { role: "assistant", content: "continue" }]));
    await adapter.complete(request([{ role: "system", content: "rules" }, { role: "tool", content: "result" }]));
    await staticAdapter(fetcher, { systemRole: "system" }).complete(request());
    await staticAdapter(fetcher, { systemRole: "system", modelProfiles: { "github_copilot/claude-haiku-4.5": { id: "github_copilot/claude-haiku-4.5", wireModel: "custom", endpoint: "chat", systemRole: "assistant" } } }).complete(request());
    await adapter.complete({ model: "github_copilot/gpt-5.6-terra", messages: [{ role: "system", content: "rules" }, { role: "user", content: "hello" }] });

    expect(headers(calls[0] as Call)["X-Initiator"]).toBe("user");
    expect(headers(calls[1] as Call)["X-Initiator"]).toBe("agent");
    expect(headers(calls[2] as Call)["X-Initiator"]).toBe("agent");
    expect(body(calls[0] as Call).messages).toEqual([{ role: "assistant", content: "rules" }, { role: "user", content: "hello" }]);
    expect(body(calls[3] as Call).messages).toEqual([{ role: "system", content: "rules" }, { role: "user", content: "hello" }]);
    expect(body(calls[4] as Call).messages).toEqual([{ role: "assistant", content: "rules" }, { role: "user", content: "hello" }]);
    expect(body(calls[5] as Call).input).toEqual([{ role: "system", content: [{ type: "input_text", text: "rules" }] }, { role: "user", content: [{ type: "input_text", text: "hello" }] }]);
  });

  test("returns exact redacted adapter HTTP, network, malformed JSON, and schema errors", async () => {
    const http = await rejected(staticAdapter((async (): Promise<Response> => response({ error: { code: "upstream", message: `Bearer ${OAUTH_SECRET}; token: ${API_SECRET}; secret: ${COPILOT_SECRET}` } }, 502, { "x-github-request-id": "provider-id", "content-type": "application/json" })) as typeof fetch).complete(request()));
    expect(http).toBeInstanceOf(HttpError);
    expect(http).toMatchObject({ code: "HTTP_ERROR", status: 502, requestId: REQUEST_ID, contentType: "application/json", providerRequestId: "provider-id", providerCode: "upstream", providerMessage: "[REDACTED]; [REDACTED]; [REDACTED]" });
    expect(http.message).toBe("HTTP request failed (status 502); request synthetic-request-id; provider request provider-id; provider code upstream; provider message [REDACTED]; [REDACTED]; [REDACTED].");
    const network = await rejected(staticAdapter((async (): Promise<Response> => { throw new Error(`${OAUTH_SECRET}:${API_SECRET}:${COPILOT_SECRET}`); }) as typeof fetch).complete(request()));
    expect(network).toBeInstanceOf(NetworkError);
    expect(network).toMatchObject({ code: "NETWORK_ERROR", requestId: REQUEST_ID });
    expect(network.message).toBe("Network request failed; request synthetic-request-id.");
    expect(network).toHaveProperty("status", undefined);
    const malformedJson = await rejected(staticAdapter((async (): Promise<Response> => new Response(`{${OAUTH_SECRET}:${API_SECRET}:${COPILOT_SECRET}`, { status: 200 })) as typeof fetch).complete(request()));
    expect(malformedJson).toBeInstanceOf(MalformedResponseError);
    expect(malformedJson).toMatchObject({ code: "MALFORMED_RESPONSE", requestId: REQUEST_ID });
    expect(malformedJson.message).toBe("Provider returned a malformed response; request synthetic-request-id.");
    expect(malformedJson).toHaveProperty("status", undefined);
    const invalidSchema = await rejected(staticAdapter((async (): Promise<Response> => response({ choices: [{ message: `${OAUTH_SECRET}:${API_SECRET}:${COPILOT_SECRET}` }] })) as typeof fetch).complete(request()));
    expect(invalidSchema).toBeInstanceOf(MalformedResponseError);
    expect(invalidSchema).toMatchObject({ code: "MALFORMED_RESPONSE", requestId: REQUEST_ID });
    expect(invalidSchema.message).toBe("Provider returned a malformed response; request synthetic-request-id.");
    expect(invalidSchema).toHaveProperty("status", undefined);
  });
});

describe("Copilot configuration", () => {
  test("parses environment and GitHub OAuth modes and rejects malformed contract fields", () => {
    expect(parseGhePluginOptions({ baseUrl: API_BASE, credential: { source: "env", name: "COPILOT_TOKEN" } })).toEqual({ baseUrl: API_BASE, credential: { source: "env", name: "COPILOT_TOKEN" } });
    expect(parseGhePluginOptions({ baseUrl: API_BASE, credential: { source: "github-oauth", name: "GITHUB_TOKEN", tokenEndpoint: EXCHANGE_URL }, systemRole: "system", profiles: { custom: { id: "custom", wireModel: "custom", endpoint: "chat", systemRole: "assistant" } } })).toMatchObject({ credential: { source: "github-oauth", name: "GITHUB_TOKEN", tokenEndpoint: EXCHANGE_URL }, systemRole: "system" });
    for (const options of [
      { baseUrl: API_BASE, credential: { source: "file", name: "TOKEN" } },
      { baseUrl: API_BASE, credential: { source: "env", name: "invalid-name" } },
      { baseUrl: API_BASE, credential: { source: "github-oauth", name: "TOKEN", tokenEndpoint: "not-a-url" } },
      { baseUrl: API_BASE, credential: { source: "env", name: "TOKEN" }, systemRole: "user" },
      { baseUrl: API_BASE, credential: { source: "env", name: "TOKEN" }, profiles: { custom: { id: "custom", wireModel: "custom", endpoint: "chat", systemRole: "user" } } },
      { baseUrl: API_BASE, credential: { source: "env", name: "TOKEN" }, profiles: { custom: { id: "custom", wireModel: "custom", endpoint: "chat", unknown: true } } },
      { baseUrl: API_BASE, credential: { source: "env", name: "TOKEN" }, unknown: true },
    ]) expect((): unknown => parseGhePluginOptions(options)).toThrow(GhePluginConfigError);
  });
});
