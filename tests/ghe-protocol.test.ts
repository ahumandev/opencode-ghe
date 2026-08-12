import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConfigurationError,
  HttpError,
  InvalidRequestError,
  MalformedResponseError,
  NetworkError,
  StreamTerminationError,
  UnsupportedOptionError,
  createGheProtocolAdapter,
  type GheProtocolAdapter,
  type GheProtocolConfig,
  type GheRequest,
  type NormalizedStreamEvent,
} from "../src/ghe-protocol.ts";

const BASE_URL = "https://ghe.example.test";
const SECRET = ["fake", "credential", "value"].join("-");
const SENSITIVE = ["sensitive", "fixture", "value"].join("-");
const REQUEST_ID = "client-request-id";
const CHAT_MODEL = "claude-haiku-4.5";
const RESPONSES_MODEL = "gpt-5.6-terra";

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function request(model: string = CHAT_MODEL): GheRequest {
  return { model, messages: [{ role: "system", content: "Rules" }, { role: "user", content: "Hello" }] };
}

function adapter(fetcher: typeof fetch, overrides: Partial<GheProtocolConfig> = {}): GheProtocolAdapter {
  return createGheProtocolAdapter({
    baseUrl: BASE_URL,
    copilotHeaders: { "X-Copilot-Feature": "synthetic" },
    credential: SECRET,
    fetch: fetcher,
    requestIdFactory: (): string => REQUEST_ID,
    ...overrides,
  });
}

function capture(response: Response, calls: CapturedRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return response;
  }) as typeof fetch;
}

function body(call: CapturedRequest): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function json(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers });
}

function stream(chunks: readonly Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function encoded(text: string): Uint8Array[] {
  return [new TextEncoder().encode(text)];
}

async function events(value: AsyncIterable<NormalizedStreamEvent>): Promise<NormalizedStreamEvent[]> {
  const result: NormalizedStreamEvent[] = [];
  for await (const event of value) result.push(event);
  return result;
}

async function safeError(value: Promise<unknown>): Promise<Error> {
  try {
    await value;
    throw new Error("Expected rejection.");
  } catch (error: unknown) {
    const result = error instanceof Error ? error : new Error(String(error));
    expect(String(result)).not.toContain(SECRET);
    expect(String(result)).not.toContain(SENSITIVE);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SENSITIVE);
    return result;
  }
}

describe("GHE public protocol seam", () => {
  test("routes every built-in profile with its wire model, system role, and thinking budget", async () => {
    const profiles = [
      ["claude-haiku-4.5", "claude-haiku-4.5", "chat", "assistant"],
      ["claude-sonnet-5", "claude-sonnet-5", "chat", "assistant"],
      ["claude-opus-4.8", "claude-opus-4.8", "chat", "assistant"],
      ["gpt-5-mini", "gpt-5-mini", "chat", "assistant"],
       ["gpt-5.4-mini", "gpt-5.4-mini", "responses", "system"],
      ["gpt-5.6-terra", "gpt-5.6-terra", "responses", "system"],
      ["gpt-5.6-luna", "gpt-5.6-luna", "responses", "system"],
    ] as const;
    for (const [model, wireModel, endpoint, systemRole] of profiles) {
      const calls: CapturedRequest[] = [];
      const response = endpoint === "chat"
        ? json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] })
        : json({ status: "completed", output: [{ type: "message", content: "ok" }] });
      await adapter(capture(response, calls)).complete(request(model));
      expect(calls[0]?.url).toBe(`${BASE_URL}/${endpoint === "chat" ? "chat/completions" : "responses"}`);
      expect(body(calls[0] as CapturedRequest).model).toBe(wireModel);
      expect((body(calls[0] as CapturedRequest)[endpoint === "chat" ? "messages" : "input"] as { role: string }[])[0]?.role).toBe(systemRole);
      expect(body(calls[0] as CapturedRequest).thinking).toEqual(endpoint === "chat" ? { type: "enabled", budget_tokens: 16000 } : undefined);
    }
    const canonicalCalls: CapturedRequest[] = [];
    const legacyCalls: CapturedRequest[] = [];
    await adapter(capture(json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), canonicalCalls)).complete(request("claude-sonnet-5"));
    await adapter(capture(json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), legacyCalls)).complete(request("github_copilot/claude-sonnet-5"));
    expect(canonicalCalls[0]?.url).toBe(`${BASE_URL}/chat/completions`);
    expect(legacyCalls[0]?.url).toBe(`${BASE_URL}/chat/completions`);
    expect(body(canonicalCalls[0] as CapturedRequest)).toEqual(body(legacyCalls[0] as CapturedRequest));
    expect(body(legacyCalls[0] as CapturedRequest).model).toBe("claude-sonnet-5");
  });

  test("uses custom profile, normalized base URL, static and async credentials", async () => {
    const staticCalls: CapturedRequest[] = [];
    const staticAdapter = adapter(capture(json({ status: "completed", output: [{ type: "message", content: "ok" }] }), staticCalls), {
      baseUrl: `${BASE_URL}/`,
      modelProfiles: { custom: { id: "custom", wireModel: "wire-custom", endpoint: "responses" } },
    });
    await staticAdapter.complete(request("custom"));
    expect(staticCalls[0]?.url).toBe(`${BASE_URL}/responses`);
    expect(staticCalls[0]?.url).not.toContain("bmw");
    expect(staticCalls[0]?.url).not.toContain(":443");
    expect(staticCalls[0]?.init?.headers).toEqual({
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
      Authorization: `Bearer ${SECRET}`,
    });
    const asyncCalls: CapturedRequest[] = [];
    await adapter(capture(json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), asyncCalls), {
      credentialResolver: { resolve: async (): Promise<string> => SECRET },
    }).complete(request());
    expect(asyncCalls[0]?.init?.headers).toMatchObject({ Authorization: `Bearer ${SECRET}`, "x-request-id": REQUEST_ID });
  });

  test("preserves configured base paths for chat and responses endpoints", async () => {
    const calls: CapturedRequest[] = [];
    const protocol = adapter(capture(json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), calls), {
      baseUrl: "https://host/custom/v1/",
    });
    await protocol.complete(request());
    await adapter(capture(json({ status: "completed", output: [{ type: "message", content: "ok" }] }), calls), {
      baseUrl: "https://host/custom/v1///",
    }).complete(request(RESPONSES_MODEL));
    expect(calls[0]?.url).toBe("https://host/custom/v1/chat/completions");
    expect(calls[1]?.url).toBe("https://host/custom/v1/responses");
    expect(calls.map((call: CapturedRequest): string => new URL(call.url).pathname)).not.toContain("//");
  });

  test("serializes chat and responses messages, options, tools, and tool choice", async () => {
    const calls: CapturedRequest[] = [];
    const fetcher = capture(json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), calls);
    const tools = [{ type: "function" as const, function: { name: "weather", description: "Forecast", parameters: { type: "object" } } }];
    const chatRequest: GheRequest = {
      ...request(),
      messages: [...request().messages, { role: "tool", content: "sunny", name: "weather", toolCallId: "call-1" }],
      tools,
      toolChoice: { type: "function", function: { name: "weather" } },
      options: { temperature: 2, maxOutputTokens: 7, stopSequences: ["END"] },
    };
    await adapter(fetcher).complete(chatRequest);
    expect(body(calls[0] as CapturedRequest)).toEqual({
      model: "claude-haiku-4.5",
       messages: [{ role: "assistant", content: "Rules" }, { role: "user", content: "Hello" }, { role: "tool", content: "sunny", name: "weather", tool_call_id: "call-1" }],
      stream: false,
      temperature: 2,
      max_tokens: 7,
      stop: ["END"],
      tools,
      tool_choice: { type: "function", function: { name: "weather" } },
      thinking: { type: "enabled", budget_tokens: 16000 },
    });
    const responseCalls: CapturedRequest[] = [];
    await adapter(capture(json({ status: "completed", output: [{ type: "message", content: "ok" }] }), responseCalls)).complete({ ...chatRequest, model: RESPONSES_MODEL, options: { temperature: 0, maxOutputTokens: 1, stopSequences: [] } });
    expect(body(responseCalls[0] as CapturedRequest)).toEqual({ model: "gpt-5.6-terra", input: [{ role: "system", content: [{ type: "input_text", text: "Rules" }] }, { role: "user", content: [{ type: "input_text", text: "Hello" }] }, { type: "function_call_output", call_id: "call-1", output: [{ type: "input_text", text: "sunny" }] }], stream: false, max_output_tokens: 1, tools: [{ type: "function", name: "weather", description: "Forecast", parameters: { type: "object" } }], tool_choice: { type: "function", name: "weather" } });
    expect(body(responseCalls[0] as CapturedRequest).thinking).toBeUndefined();
    const configuredResponseCalls: CapturedRequest[] = [];
    await adapter(capture(json({ status: "completed", output: [{ type: "message", content: "ok" }] }), configuredResponseCalls), {
      systemRole: "system",
      modelProfiles: { custom: { id: "custom", wireModel: "custom", endpoint: "responses", systemRole: "assistant" } },
    }).complete({ ...chatRequest, model: "custom" });
    expect((body(configuredResponseCalls[0] as CapturedRequest).input as { role: string }[])[0]?.role).toBe("assistant");
  });

  test("serializes gpt-5.4-mini Responses body exactly", async () => {
    const calls: CapturedRequest[] = [];
    await adapter(capture(json({ status: "completed", output: [{ type: "message", content: "ok" }] }), calls)).complete({
      ...request("gpt-5.4-mini"),
      options: { temperature: 0, maxOutputTokens: 7, stopSequences: ["END"] },
    });
    expect(calls[0]).toMatchObject({ url: `${BASE_URL}/responses` });
    expect(body(calls[0] as CapturedRequest)).toEqual({
      model: "gpt-5.4-mini",
      input: [{ role: "system", content: [{ type: "input_text", text: "Rules" }] }, { role: "user", content: [{ type: "input_text", text: "Hello" }] }],
      stream: false,
      max_output_tokens: 7,
    });
  });

  test("serializes Luna and Terra Responses tools, calls, outputs, choices, and stream flags", async () => {
    const requestWithCalls: GheRequest = {
      model: RESPONSES_MODEL,
      messages: [
        { role: "system", content: "Rules" },
        { role: "assistant", content: "First", toolCalls: [{ id: "call-a", name: "weather", arguments: { city: "Paris" } }, { id: "call-b", name: "time", arguments: "{\"zone\":\"UTC\"}" }] },
        { role: "tool", content: "sunny", name: "weather", toolCallId: "call-a" },
        { role: "tool", content: "noon", name: "time", toolCallId: "call-b" },
      ],
      tools: [{ type: "function", function: { name: "weather", description: "Forecast", parameters: { type: "object" } } }],
    };
    for (const [model, choice, streamEnabled] of [["gpt-5.6-terra", "auto", false], ["gpt-5.6-luna", "none", true], ["gpt-5.6-terra", "required", false], ["gpt-5.6-luna", { type: "function", function: { name: "weather" } }, true]] as const) {
      const calls: CapturedRequest[] = [];
      const protocol = adapter(capture(streamEnabled ? stream(encoded("event: response.completed\ndata: {\"response\":{}}")) : json({ status: "completed", output: [{ type: "message", content: "ok" }] }), calls));
      if (streamEnabled) await events(protocol.stream({ ...requestWithCalls, model, toolChoice: choice }));
      else await protocol.complete({ ...requestWithCalls, model, toolChoice: choice });
      expect(body(calls[0] as CapturedRequest)).toEqual({
        model,
        input: [
          { role: "system", content: [{ type: "input_text", text: "Rules" }] },
          { role: "assistant", content: [{ type: "output_text", text: "First" }] },
          { type: "function_call", call_id: "call-a", name: "weather", arguments: "{\"city\":\"Paris\"}" },
          { type: "function_call", call_id: "call-b", name: "time", arguments: "{\"zone\":\"UTC\"}" },
          { type: "function_call_output", call_id: "call-a", output: [{ type: "input_text", text: "sunny" }] },
          { type: "function_call_output", call_id: "call-b", output: [{ type: "input_text", text: "noon" }] },
        ],
        stream: streamEnabled,
        tools: [{ type: "function", name: "weather", description: "Forecast", parameters: { type: "object" } }],
        tool_choice: choice === "auto" || choice === "none" || choice === "required" ? choice : { type: "function", name: "weather" },
      });
    }
  });

  test("preserves tool-only Chat and Responses history with matching result IDs", async () => {
    const toolHistory: GheRequest["messages"] = [
      { role: "user", content: "Check weather" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-weather", name: "weather", arguments: { city: "Paris" } }, { id: "call-time", name: "time", arguments: "{\"zone\":\"UTC\"}" }] },
      { role: "tool", content: "sunny", toolCallId: "call-weather" },
      { role: "tool", content: "noon", toolCallId: "call-time" },
    ];
    const chatCalls: CapturedRequest[] = [];
    await adapter(capture(json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), chatCalls)).complete({ model: CHAT_MODEL, messages: toolHistory });
    expect(body(chatCalls[0] as CapturedRequest).messages).toEqual([
      { role: "user", content: "Check weather" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-weather", type: "function", function: { name: "weather", arguments: "{\"city\":\"Paris\"}" } }, { id: "call-time", type: "function", function: { name: "time", arguments: "{\"zone\":\"UTC\"}" } }] },
      { role: "tool", content: "sunny", tool_call_id: "call-weather" },
      { role: "tool", content: "noon", tool_call_id: "call-time" },
    ]);
    const responseCalls: CapturedRequest[] = [];
    await adapter(capture(json({ status: "completed", output: [{ type: "message", content: "ok" }] }), responseCalls)).complete({ model: RESPONSES_MODEL, messages: toolHistory });
    expect(body(responseCalls[0] as CapturedRequest).input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Check weather" }] },
      { type: "function_call", call_id: "call-weather", name: "weather", arguments: "{\"city\":\"Paris\"}" },
      { type: "function_call", call_id: "call-time", name: "time", arguments: "{\"zone\":\"UTC\"}" },
      { type: "function_call_output", call_id: "call-weather", output: [{ type: "input_text", text: "sunny" }] },
      { type: "function_call_output", call_id: "call-time", output: [{ type: "input_text", text: "noon" }] },
    ]);
  });

  test("serializes Responses continuation history with assistant output text", async () => {
    const calls: CapturedRequest[] = [];
    await adapter(capture(json({ status: "completed", output: [{ type: "message", content: "ok" }] }), calls)).complete({
      model: RESPONSES_MODEL,
      messages: [
        { role: "user", content: "Find weather" },
        { role: "assistant", content: "Checking now.", toolCalls: [{ id: "call-weather", name: "weather", arguments: { city: "Paris" } }] },
        { role: "tool", content: "Sunny", toolCallId: "call-weather" },
        { role: "user", content: "What should I wear?" },
      ],
    });
    expect(body(calls[0] as CapturedRequest).input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Find weather" }] },
      { role: "assistant", content: [{ type: "output_text", text: "Checking now." }] },
      { type: "function_call", call_id: "call-weather", name: "weather", arguments: "{\"city\":\"Paris\"}" },
      { type: "function_call_output", call_id: "call-weather", output: [{ type: "input_text", text: "Sunny" }] },
      { role: "user", content: [{ type: "input_text", text: "What should I wear?" }] },
    ]);
  });

  test("rejects malformed Chat assistant tool calls before HTTP", async () => {
    let fetched = 0;
    const protocol = adapter((async (): Promise<Response> => { fetched += 1; return json({}); }) as typeof fetch);
    const malformed = [
      { id: " ", name: "weather", arguments: {} },
      { id: "call", name: " ", arguments: {} },
      { id: "call", name: "weather", arguments: "not-json" },
      { id: "call", name: "weather", arguments: undefined },
    ];
    for (const toolCall of malformed) {
      await expect(protocol.complete({ model: CHAT_MODEL, messages: [{ role: "assistant", content: "", toolCalls: [toolCall] }] })).rejects.toBeInstanceOf(InvalidRequestError);
    }
    expect(fetched).toBe(0);
  });

  test("rejects invalid Responses data before credential resolution or fetch", async () => {
    let resolved = 0;
    let fetched = 0;
    const protocol = adapter((async (): Promise<Response> => { fetched += 1; return json({}); }) as typeof fetch, {
      credentialResolver: { resolve: (): string => { resolved += 1; return SECRET; } },
    });
    const invalidRequests: GheRequest[] = [
      { ...request(RESPONSES_MODEL), messages: [{ role: "assistant", content: "", toolCalls: [{ id: " ", name: "weather", arguments: {} }] }] },
      { ...request(RESPONSES_MODEL), messages: [{ role: "assistant", content: "", toolCalls: [{ id: "call", name: " ", arguments: {} }] }] },
      { ...request(RESPONSES_MODEL), messages: [{ role: "tool", content: "result", toolCallId: " " }] },
      { ...request(RESPONSES_MODEL), messages: [{ role: "tool", content: 1, toolCallId: "call" } as unknown as GheRequest["messages"][number]] },
      { ...request(RESPONSES_MODEL), messages: [{ role: "assistant", content: "", toolCalls: [{ id: "call", name: "weather", arguments: "not-json" }] }] },
      { ...request(RESPONSES_MODEL), toolChoice: { type: "function", function: { name: " " } } },
      { ...request(RESPONSES_MODEL), toolChoice: { type: "invalid" } },
      { ...request(RESPONSES_MODEL), tools: [{ type: "provider" } as unknown as NonNullable<GheRequest["tools"]>[number]] },
    ];
    for (const invalidRequest of invalidRequests) await expect(protocol.complete(invalidRequest)).rejects.toBeInstanceOf(InvalidRequestError);
    expect({ resolved, fetched }).toEqual({ resolved: 0, fetched: 0 });
  });

  test("keeps gpt-5-mini Chat request and SSE contract unchanged", async () => {
    const calls: CapturedRequest[] = [];
    const protocol = adapter(capture(stream(encoded("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")), calls));
    await events(protocol.stream({ ...request("gpt-5-mini"), options: { temperature: 1, maxOutputTokens: 8, stopSequences: ["END"] } }));
    expect(calls[0]).toEqual({
      url: `${BASE_URL}/chat/completions`,
      init: expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: `Bearer ${SECRET}`, "x-request-id": REQUEST_ID, "content-type": "application/json" }),
        body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "assistant", content: "Rules" }, { role: "user", content: "Hello" }], stream: true, temperature: 1, max_tokens: 8, stop: ["END"], thinking: { type: "enabled", budget_tokens: 16000 } }),
      }),
    });
  });

  test("serializes supported option boundaries and calls fetch", async () => {
    const cases = [
      { options: { temperature: 0 }, expected: { temperature: 0 } },
      { options: { temperature: 2 }, expected: { temperature: 2 } },
      { options: { maxOutputTokens: 1 }, expected: { max_tokens: 1 } },
      { options: { stopSequences: ["END"] }, expected: { stop: ["END"] } },
    ] as const;
    for (const { options, expected } of cases) {
      const calls: CapturedRequest[] = [];
      await adapter(capture(json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), calls)).complete({ ...request(), options });
      expect(calls).toHaveLength(1);
      expect(body(calls[0] as CapturedRequest)).toMatchObject(expected);
    }
  });

  test("rejects unsupported option boundaries before fetch", async () => {
    let calls = 0;
    const fetcher = (async (): Promise<Response> => { calls += 1; return json({}); }) as typeof fetch;
    const protocol = adapter(fetcher);
    for (const temperature of [-Number.EPSILON, 2 + Number.EPSILON * 2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(protocol.complete({ ...request(), options: { temperature } })).rejects.toBeInstanceOf(UnsupportedOptionError);
    }
    for (const maxOutputTokens of [0, 1.5]) {
      await expect(protocol.complete({ ...request(), options: { maxOutputTokens } })).rejects.toBeInstanceOf(UnsupportedOptionError);
    }
    await expect(protocol.complete({ ...request(), options: { stopSequences: [1] as unknown as readonly string[] } })).rejects.toThrow("Unsupported request option: stopSequences.");
    expect(calls).toBe(0);
  });

  test("rejects protected headers, invalid options, and profile budget overrides before fetch", async () => {
    let calls = 0;
    const fetcher = (async (): Promise<Response> => { calls += 1; return json({}); }) as typeof fetch;
    expect((): GheProtocolAdapter => adapter(fetcher, { copilotHeaders: { Authorization: `Bearer ${SECRET}` } })).toThrow(ConfigurationError);
    const protocol = adapter(fetcher);
    await expect(protocol.complete({ ...request(), options: { temperature: -0.1 } })).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(protocol.complete({ ...request(), options: { reasoningBudget: 1 } as unknown as GheRequest["options"] })).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(protocol.complete({ ...request(), options: { maxOutputTokens: 0 } })).rejects.toBeInstanceOf(UnsupportedOptionError);
    expect(calls).toBe(0);
  });

  test("normalizes chat, responses, and tool-only completions", async () => {
    const chatCalls: CapturedRequest[] = [];
    const chat = await adapter(capture(json({
      model: "wire-chat",
      choices: [{ message: { content: [{ text: "Hello " }, { content: "world" }], reasoning_content: "because", tool_calls: [{ id: "call-1", function: { name: "weather", arguments: "{\"city\":\"Paris\"}" } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, completion_tokens_details: { reasoning_tokens: 1 } },
    }, { "x-github-request-id": "provider-chat" }), chatCalls)).complete(request());
    expect(chat).toEqual({ requestId: REQUEST_ID, providerRequestId: "provider-chat", model: "wire-chat", text: "Hello world", reasoning: "because", toolCalls: [{ id: "call-1", name: "weather", arguments: { city: "Paris" } }], finishReason: "tool-calls", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, reasoningTokens: 1 } });
    const response = await adapter(capture(json({
      model: "wire-response", status: "incomplete", incomplete_details: { reason: "max_tokens" },
      output: [{ type: "message", content: [{ text: "Answer" }] }, { type: "reasoning", summary: [{ text: "Think" }] }, { type: "function_call", call_id: "call-2", name: "lookup", arguments: "{\"id\":2}" }],
      usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9, output_tokens_details: { reasoning_tokens: 2 } },
    }, { "x-request-id": "provider-response" }), [])).complete(request(RESPONSES_MODEL));
    expect(response).toEqual({ requestId: REQUEST_ID, providerRequestId: "provider-response", model: "wire-response", text: "Answer", reasoning: "Think", toolCalls: [{ id: "call-2", name: "lookup", arguments: { id: 2 } }], finishReason: "length", usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9, reasoningTokens: 2 } });
    const toolOnly = await adapter(capture(json({ status: "completed", output: [{ type: "function_call", call_id: "only-call", name: "only", arguments: "raw" }] }), [])).complete(request(RESPONSES_MODEL));
    expect(toolOnly).toMatchObject({ text: "", reasoning: "", toolCalls: [{ id: "only-call", name: "only", arguments: "raw" }], finishReason: "stop" });
  });

  test("parses fragmented chat SSE with CRLF, comments, multiline data, stable tool IDs, and DONE", async () => {
    const source = ": keepalive\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"hé\"\r\ndata: },\"finish_reason\":null}]}\r\n\r\ndata: {\"choices\":[{\"delta\":{\"reasoning\":\"why\",\"tool_calls\":[{\"index\":0,\"id\":\"provider-call\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"city\\\":\"}}]}}]}\r\n\r\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"Paris\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2}}\r\n\r\ndata: [DONE]";
    const bytes = new TextEncoder().encode(source);
    const split = bytes.indexOf(0xc3) + 1;
    const result = await events(adapter(capture(stream([bytes.slice(0, split), bytes.slice(split)]), [])).stream(request()));
    expect(result).toEqual([
      { type: "text-delta", text: "hé" },
      { type: "finish", finishReason: "unknown" },
      { type: "reasoning-delta", reasoning: "why" },
       { type: "tool-call-delta", id: "provider-call", name: "weather", arguments: "{\"city\":" },
       { type: "tool-call-delta", id: "provider-call", arguments: "\"Paris\"}" },
       { type: "tool-call", toolCall: { id: "provider-call", name: "weather", arguments: { city: "Paris" } } },
       { type: "finish", finishReason: "tool-calls" },
       { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
     ]);
   });

  test("retains Chat tool arguments when terminal metadata is empty", async () => {
    const source = [
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"claude-call\",\"function\":{\"name\":\"schedule\",\"arguments\":\"{\\\"date\\\":\"}}]}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"2026-08-12\\\"}\"}}]}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: [DONE]",
    ].join("");
    const result = await events(adapter(capture(stream(encoded(source)), [])).stream(request()));
    expect(result).toEqual([
      { type: "tool-call-delta", id: "claude-call", name: "schedule", arguments: "{\"date\":" },
      { type: "tool-call-delta", id: "claude-call", arguments: "\"2026-08-12\"}" },
      { type: "tool-call", toolCall: { id: "claude-call", name: "schedule", arguments: { date: "2026-08-12" } } },
      { type: "finish", finishReason: "tool-calls" },
    ]);
  });

  test("emits standalone terminal Chat empty-object arguments", async () => {
    const source = [
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"claude-call\",\"function\":{\"name\":\"schedule\"}}]}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: [DONE]",
    ].join("");
    const result = await events(adapter(capture(stream(encoded(source)), [])).stream(request()));
    expect(result).toEqual([
      { type: "tool-call-delta", id: "claude-call", name: "schedule", arguments: "" },
      { type: "tool-call-delta", id: "claude-call", arguments: "{}" },
      { type: "tool-call", toolCall: { id: "claude-call", name: "schedule", arguments: {} } },
      { type: "finish", finishReason: "tool-calls" },
    ]);
  });

  test("normalizes explicit empty Chat arguments once across repeated finishes", async () => {
    const source = [
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"empty-call\",\"function\":{\"name\":\"empty\",\"arguments\":\"\"}},{\"index\":1,\"id\":\"object-call\",\"function\":{\"name\":\"object\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: [DONE]",
    ].join("");
    const result = await events(adapter(capture(stream(encoded(source)), [])).stream(request()));
    expect(result).toEqual([
      { type: "tool-call-delta", id: "empty-call", name: "empty", arguments: "" },
      { type: "tool-call-delta", id: "object-call", name: "object", arguments: "{}" },
      { type: "tool-call", toolCall: { id: "empty-call", name: "empty", arguments: "" } },
      { type: "tool-call", toolCall: { id: "object-call", name: "object", arguments: {} } },
      { type: "finish", finishReason: "tool-calls" },
      { type: "finish", finishReason: "tool-calls" },
    ]);
  });

  test("preserves malformed Chat tool argument fragments", async () => {
    const source = [
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"raw-call\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"city\\\":\"}}]}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"Paris\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: [DONE]",
    ].join("");
    const result = await events(adapter(capture(stream(encoded(source)), [])).stream(request()));
    expect(result).toEqual([
      { type: "tool-call-delta", id: "raw-call", name: "weather", arguments: "{\"city\":" },
      { type: "tool-call-delta", id: "raw-call", arguments: "Paris\"}" },
      { type: "tool-call", toolCall: { id: "raw-call", name: "weather", arguments: "{\"city\":Paris\"}" } },
      { type: "finish", finishReason: "tool-calls" },
    ]);
  });

  test("maps responses SSE events and accepts response.completed without final newline", async () => {
    const source = [
       "event: response.output_text.delta\ndata: {\"delta\":\"Hi\"}\n\n",
       "event: response.reasoning.delta\ndata: {\"delta\":\"Think\"}\n\n",
       "event: response.output_item.added\ndata: {\"item\":{\"type\":\"function_call\",\"id\":\"item-3\",\"call_id\":\"call-3\",\"name\":\"lookup\",\"arguments\":\"\"}}\n\n",
       "event: response.function_call_arguments.delta\ndata: {\"item_id\":\"item-3\",\"delta\":\"{}\"}\n\n",
       "event: response.output_item.done\ndata: {\"item\":{\"type\":\"function_call\",\"id\":\"item-3\",\"call_id\":\"call-3\",\"name\":\"lookup\",\"arguments\":\"{}\"}}\n\n",
      "event: response.completed\ndata: {\"response\":{\"usage\":{\"input_tokens\":2,\"output_tokens\":3}}}",
    ].join("");
    const result = await events(adapter(capture(stream(encoded(source)), [])).stream(request(RESPONSES_MODEL)));
    expect(result).toEqual([
      { type: "text-delta", text: "Hi" },
      { type: "reasoning-delta", reasoning: "Think" },
      { type: "tool-call-delta", id: "call-3", name: "lookup", arguments: "{}" },
      { type: "tool-call", toolCall: { id: "call-3", name: "lookup", arguments: {} } },
       { type: "finish", finishReason: "tool-calls" },
      { type: "usage", usage: { inputTokens: 2, outputTokens: 3 } },
    ]);
  });

  test("waits for output item metadata before completing Responses function calls", async () => {
    const source = [
      "event: response.function_call_arguments.delta\ndata: {\"item_id\":\"item-4\",\"delta\":\"{\\\"city\\\":\\\"Paris\\\"}\"}\n\n",
      "event: response.function_call_arguments.done\ndata: {\"item_id\":\"item-4\",\"arguments\":\"{\\\"city\\\":\\\"Paris\\\"}\"}\n\n",
      "event: response.output_item.done\ndata: {\"item\":{\"type\":\"function_call\",\"id\":\"item-4\",\"call_id\":\"call-weather\",\"name\":\"weather\",\"arguments\":\"{\\\"city\\\":\\\"Paris\\\"}\"}}\n\n",
      "event: response.completed\ndata: {\"response\":{}}",
    ].join("");
    const result = await events(adapter(capture(stream(encoded(source)), [])).stream(request(RESPONSES_MODEL)));
    expect(result).toEqual([
      { type: "tool-call", toolCall: { id: "call-weather", name: "weather", arguments: { city: "Paris" } } },
       { type: "finish", finishReason: "tool-calls" },
    ]);
  });

  test("replays early Responses argument deltas after tool metadata arrives", async () => {
    const argumentsJson = '{"task":"deploy","env":"production"}';
    const earlyDeltas = [...argumentsJson].map((delta: string): string => `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ item_id: "item-early", delta })}\n\n`);
    const source = [
      ...earlyDeltas,
      "event: response.output_item.added\ndata: {\"item\":{\"type\":\"function_call\",\"id\":\"item-early\",\"call_id\":\"call-early\",\"name\":\"deploy\",\"arguments\":\"\"}}\n\n",
      `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ item_id: "item-early", arguments: argumentsJson })}\n\n`,
      "event: response.output_item.done\ndata: {\"item\":{\"type\":\"function_call\",\"id\":\"item-early\",\"call_id\":\"call-early\",\"name\":\"deploy\",\"arguments\":\"{}\"}}\n\n",
      "event: response.completed\ndata: {\"response\":{}}",
    ].join("");
    const result = await events(adapter(capture(stream(encoded(source)), [])).stream(request(RESPONSES_MODEL)));
    expect(earlyDeltas).toHaveLength(36);
    expect(result).toEqual([
      { type: "tool-call-delta", id: "call-early", name: "deploy", arguments: argumentsJson },
      { type: "tool-call", toolCall: { id: "call-early", name: "deploy", arguments: { task: "deploy", env: "production" } } },
      { type: "finish", finishReason: "tool-calls" },
    ]);
  });

  test("prefers finalized Responses arguments over terminal placeholder arguments", async () => {
    const source = [
      "event: response.function_call_arguments.done\ndata: {\"item_id\":\"item-5\",\"arguments\":\"{\\\"task\\\":\\\"deploy\\\",\\\"environment\\\":\\\"prod\\\"}\"}\n\n",
      "event: response.output_item.done\ndata: {\"item\":{\"type\":\"function_call\",\"id\":\"item-5\",\"call_id\":\"call-task\",\"name\":\"run_task\",\"arguments\":\"{}\"}}\n\n",
      "event: response.completed\ndata: {\"response\":{}}",
    ].join("");
    const result = await events(adapter(capture(stream(encoded(source)), [])).stream(request(RESPONSES_MODEL)));
    expect(result).toEqual([
      { type: "tool-call", toolCall: { id: "call-task", name: "run_task", arguments: { task: "deploy", environment: "prod" } } },
      { type: "finish", finishReason: "tool-calls" },
    ]);
  });

  test("correlates Responses function calls by output index when event item IDs differ", async () => {
    const source = [
      "event: response.output_item.added\ndata: {\"output_index\":7,\"item\":{\"type\":\"function_call\",\"id\":\"added-item\",\"call_id\":\"call-task\",\"name\":\"run_task\",\"arguments\":\"\"}}\n\n",
      "event: response.function_call_arguments.delta\ndata: {\"output_index\":7,\"item_id\":\"delta-item\",\"delta\":\"{\\\"task\\\":\"}\n\n",
      "event: response.function_call_arguments.done\ndata: {\"output_index\":7,\"item_id\":\"done-item\",\"arguments\":\"{\\\"task\\\":\\\"deploy\\\",\\\"environment\\\":\\\"prod\\\"}\"}\n\n",
      "event: response.output_item.done\ndata: {\"output_index\":7,\"item\":{\"type\":\"function_call\",\"id\":\"terminal-item\",\"call_id\":\"call-task\",\"name\":\"run_task\",\"arguments\":\"{}\"}}\n\n",
      "event: response.completed\ndata: {\"response\":{}}",
    ].join("");
    const result = await events(adapter(capture(stream(encoded(source)), [])).stream(request(RESPONSES_MODEL)));
    expect(result).toEqual([
      { type: "tool-call-delta", id: "call-task", name: "run_task", arguments: "{\"task\":" },
      { type: "tool-call", toolCall: { id: "call-task", name: "run_task", arguments: { task: "deploy", environment: "prod" } } },
      { type: "finish", finishReason: "tool-calls" },
    ]);
  });

  test("cancels SSE body when consumer exits stream early", async () => {
    let cancellations = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n"));
      },
      cancel(): void { cancellations += 1; },
    });
    const iterator = adapter(capture(new Response(source, { status: 200, headers: { "Content-Type": "text/event-stream" } }), [])).stream(request())[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { type: "text-delta", text: "Hi" } });
    await iterator.return?.();
    expect(cancellations).toBe(1);
  });

  test("reports config, auth, network, HTTP, malformed, stream, and timeout errors without secrets", async () => {
    let calls = 0;
    const countingFetch = (async (): Promise<Response> => { calls += 1; return json({ detail: SENSITIVE }); }) as typeof fetch;
    expect((): GheProtocolAdapter => adapter(countingFetch, { baseUrl: "not a URL" })).toThrow(ConfigurationError);
    const unauthenticated = adapter(countingFetch, { credentialResolver: { resolve: (): string => { throw new Error(`${SECRET}:${SENSITIVE}`); } } });
    expect(await safeError(unauthenticated.complete(request()))).toBeInstanceOf(AuthenticationError);
    expect(calls).toBe(0);
    expect(await safeError(adapter((async (): Promise<Response> => Promise.reject(new Error(`${SECRET}:${SENSITIVE}`))) as typeof fetch).complete(request()))).toBeInstanceOf(NetworkError);
    expect(await safeError(adapter(capture(new Response(JSON.stringify({ detail: `${SECRET}:${SENSITIVE}` }), { status: 500 }), [])).complete(request()))).toBeInstanceOf(HttpError);
    expect(await safeError(adapter(capture(json({ secret: `${SECRET}:${SENSITIVE}` }), [])).complete(request()))).toBeInstanceOf(MalformedResponseError);
    expect(await safeError(events(adapter(capture(stream(encoded("data: {\"choices\":[]}")), [])).stream(request())))).toBeInstanceOf(StreamTerminationError);
    const timeoutFetch = ((_: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise<Response>((_, reject: (reason?: unknown) => void): void => {
      init?.signal?.addEventListener("abort", (): void => reject(new Error(`${SECRET}:${SENSITIVE}`)));
    })) as typeof fetch;
    expect(await safeError(adapter(timeoutFetch, { timeoutMs: 1 }).complete(request()))).toBeInstanceOf(NetworkError);
  });

  test("retains bounded safe JSON HTTP diagnostics without response secrets", async () => {
    const error = await safeError(adapter(capture(new Response(JSON.stringify({
      error: {
        code: "rate_limit_exceeded",
        message: `Provider limit reached; Bearer ${SECRET}; token: ${SENSITIVE}`,
        authorization: `Bearer ${SECRET}`,
        cookie: SENSITIVE,
        nested: { body: SENSITIVE },
      },
      body: SENSITIVE,
    }), {
      status: 429,
      headers: { "Content-Type": "Application/JSON; charset=utf-8", "X-GitHub-Request-Id": "provider-request-id", Authorization: `Bearer ${SECRET}`, Cookie: SENSITIVE },
    }), [])).complete(request()));
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      status: 429,
      requestId: REQUEST_ID,
      contentType: "application/json",
      providerRequestId: "provider-request-id",
      providerCode: "rate_limit_exceeded",
      providerMessage: "Provider limit reached; [REDACTED]; [REDACTED]",
    });
    expect(error.message).toBe("HTTP request failed (status 429); request client-request-id; provider request provider-request-id; provider code rate_limit_exceeded; provider message Provider limit reached; [REDACTED]; [REDACTED].");
  });

  test("applies plain-text safety policy and token redaction to JSON provider messages", async () => {
    const safe = await safeError(adapter(capture(new Response(JSON.stringify({
      error: { message: `Retry later; "access_token":"${SECRET}"; "REFRESH_TOKEN"="${SENSITIVE}".` },
    }), { status: 502, headers: { "Content-Type": "application/json" } }), [])).complete(request()));
    expect(safe).toMatchObject({ providerMessage: "Retry later; [REDACTED]; [REDACTED]." });
    expect(safe.message).toContain("provider message Retry later; [REDACTED]; [REDACTED].");

    for (const unsafeMessage of [`<html>${SENSITIVE}</html>`, `control\u0001${SENSITIVE}`, `\u001B[31m${SENSITIVE}\u001B[0m`]) {
      const error = await safeError(adapter(capture(new Response(JSON.stringify({ error: { message: unsafeMessage } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }), [])).complete(request()));
      expect(error).not.toHaveProperty("providerMessage");
      expect(error.message).toBe("HTTP request failed (status 502); request client-request-id.");
      expect(error.message).not.toContain(unsafeMessage);
    }
  });

  test("retains bounded redacted plain-text diagnostics and suppresses HTML and binary bodies", async () => {
    const plain = await safeError(adapter(capture(new Response(`  Retry\n\t later; Bearer ${SECRET}; token: ${SENSITIVE}.  `, {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }), [])).complete(request()));
    expect(plain).toMatchObject({ contentType: "text/plain", providerMessage: "Retry later; [REDACTED]; [REDACTED]" });
    expect(plain.message).toContain("provider message Retry later; [REDACTED]; [REDACTED]");
    const oversized = "x".repeat(8193);
    for (const response of [
      new Response(`<html>${SECRET}</html>`, { status: 500, headers: { "Content-Type": "text/html" } }),
      new Response(new Uint8Array([0, 255, 1]), { status: 500, headers: { "Content-Type": "application/octet-stream" } }),
      new Response(oversized, { status: 500, headers: { "Content-Type": "text/plain" } }),
    ]) {
      const error = await safeError(adapter(capture(response, [])).complete(request()));
      expect(error).not.toHaveProperty("providerMessage");
    }
  });

  test("redacts complete Authorization bearer values in HTTP diagnostics", async () => {
    const authorizationValues = [
      `Authorization: Bearer ${SECRET}`,
      `authorization="Bearer ${SECRET}"`,
      `AUTHORIZATION:\nBearer "${SECRET}"`,
      `Authorization:\n"Bearer ${SECRET}"`,
    ];
    for (const authorization of authorizationValues) {
      const error = await safeError(adapter(capture(new Response(JSON.stringify({
        error: { code: "upstream_failure", message: `Provider failed; ${authorization}` },
      }), { status: 502, headers: { "Content-Type": "application/json" } }), [])).complete(request()));
      expect(error).toMatchObject({ providerCode: "upstream_failure", providerMessage: "Provider failed; [REDACTED]" });
      expect(error.message).not.toContain(SECRET);
      expect(JSON.stringify(error)).not.toContain(SECRET);
    }
  });

  test("drops malformed and oversized HTTP error bodies", async () => {
    const oversized = JSON.stringify({ error: { code: "should_not_appear", message: SENSITIVE }, body: "x".repeat(9000) });
    for (const response of [
      new Response(`{${SECRET}`, { status: 500, headers: { "Content-Type": "application/json", "X-Request-Id": "provider-malformed" } }),
      new Response(oversized, { status: 500, headers: { "Content-Type": "application/json", "X-Request-Id": "provider-oversized" } }),
    ]) {
      const error = await safeError(adapter(capture(response, [])).complete(request()));
      expect(error).toMatchObject({ status: 500, requestId: REQUEST_ID, contentType: "application/json" });
      expect(error).not.toHaveProperty("providerCode");
      expect(error).not.toHaveProperty("providerMessage");
    }
  });

  test("keeps timeout active while reading an SSE response body", async () => {
    const rawAbortText = `stream body timeout: ${SECRET}`;
    let responseReturned = false;
    let signalAbortedAfterHeaders = false;
    let signal: AbortSignal | undefined;
    const pendingStreamFetch = ((_: RequestInfo | URL, init?: RequestInit): Response => {
      signal = init?.signal ?? undefined;
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller): void {
          init?.signal?.addEventListener("abort", (): void => {
            signalAbortedAfterHeaders = responseReturned;
            controller.error(new Error(rawAbortText));
          });
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      responseReturned = true;
      return response;
    }) as typeof fetch;
    let guard: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<Error>((resolve): void => {
      guard = setTimeout((): void => resolve(new Error("Stream body timeout test exceeded 500ms.")), 500);
    });
    const error = await Promise.race([
      safeError(events(adapter(pendingStreamFetch, { timeoutMs: 10 }).stream(request()))),
      timedOut,
    ]);
    if (guard !== undefined) clearTimeout(guard);
    expect(error).toBeInstanceOf(NetworkError);
    expect(String(error)).not.toContain(rawAbortText);
    expect(signal?.aborted).toBe(true);
    expect(signalAbortedAfterHeaders).toBe(true);
  });
});
