import { describe, expect, test } from "bun:test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { GheLanguageModelBridgeError, createGheLanguageModel } from "../src/ai-sdk-bridge.ts";
import { HttpError } from "../src/ghe-protocol.ts";
import type { GheRequest, NormalizedResponse, NormalizedStreamEvent } from "../src/ghe-protocol.ts";

function call(overrides: Record<string, unknown> = {}): LanguageModelV3CallOptions {
  return {
    prompt: [
      { role: "system", content: "Rules" },
      { role: "user", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "Think" }, { type: "text", text: "Answer" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "weather", output: { type: "json", value: { city: "Paris" } } }] },
    ],
    temperature: 0.5, maxOutputTokens: 9, stopSequences: ["END"],
    tools: [{ type: "function", name: "weather", description: "Forecast", inputSchema: { type: "object" } }],
    toolChoice: { type: "tool", toolName: "weather" },
    topP: 0.9, topK: 2, presencePenalty: 1, frequencyPenalty: 1, seed: 3, providerOptions: { test: {} }, responseFormat: { type: "json", schema: {} }, headers: { "X-Test": "value" },
    ...overrides,
  } as unknown as LanguageModelV3CallOptions;
}

async function parts(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const reader = stream.getReader();
  const result: LanguageModelV3StreamPart[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) return result;
    result.push(next.value);
  }
}

describe("GHE AI SDK bridge", () => {
  test("maps generate inputs and returns exact V3 content, metadata, usage, and warnings", async () => {
    let request: GheRequest | undefined;
    const response: NormalizedResponse = { requestId: "client", providerRequestId: "server", text: "Done", reasoning: "Why", toolCalls: [{ id: "call-2", name: "lookup", arguments: { id: 2 } }], finishReason: "tool-calls", usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 1 } };
    const model = createGheLanguageModel({ complete: async (value): Promise<NormalizedResponse> => { request = value; return response; }, stream: (): AsyncIterable<NormalizedStreamEvent> => empty() }, "github_copilot/claude-sonnet-5");
    const result = await model.doGenerate(call());
    expect(request).toEqual({ model: "github_copilot/claude-sonnet-5", messages: [{ role: "system", content: "Rules" }, { role: "user", content: "Hello world" }, { role: "assistant", content: "ThinkAnswer" }, { role: "tool", content: '{"city":"Paris"}', name: "weather", toolCallId: "call-1" }], tools: [{ type: "function", function: { name: "weather", description: "Forecast", parameters: { type: "object" } } }], toolChoice: { type: "function", function: { name: "weather" } }, options: { temperature: 0.5, maxOutputTokens: 9, stopSequences: ["END"] } });
    expect(result).toEqual({ content: [{ type: "text", text: "Done" }, { type: "reasoning", text: "Why" }, { type: "tool-call", toolCallId: "call-2", toolName: "lookup", input: '{"id":2}' }], finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: { inputTokens: { total: 2, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 3, text: undefined, reasoning: 1 } }, warnings: expect.arrayContaining([{ type: "unsupported", feature: "topP" }, { type: "unsupported", feature: "responseFormat" }, { type: "unsupported", feature: "headers", details: "Adapter owns request headers." }]), providerMetadata: { ghe: { requestId: "client", providerRequestId: "server" } } });
  });

  test("rejects unsupported inputs before adapter call and preserves adapter errors", async () => {
    let calls = 0;
    const raw = new Error("adapter failed");
    const model = createGheLanguageModel({ complete: async (): Promise<NormalizedResponse> => { calls += 1; throw raw; }, stream: (): AsyncIterable<NormalizedStreamEvent> => empty() }, "model");
    await expect(model.doGenerate(call({ prompt: [{ role: "user", content: [{ type: "file" }] }] }))).rejects.toBeInstanceOf(GheLanguageModelBridgeError);
    await expect(model.doGenerate(call({ tools: [{ type: "provider-defined" }] }))).rejects.toBeInstanceOf(GheLanguageModelBridgeError);
    await expect(model.doGenerate(call({ prompt: [{ role: "assistant", content: [{ type: "tool-call" }] }] }))).rejects.toBeInstanceOf(GheLanguageModelBridgeError);
    const controller = new AbortController(); controller.abort();
    await expect(model.doGenerate(call({ abortSignal: controller.signal }))).rejects.toThrow("aborted");
    expect(calls).toBe(0);
    await expect(model.doGenerate(call({ tools: undefined }))).rejects.toBe(raw);
  });

  test("forwards post-start caller cancellation to adapter", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const model = createGheLanguageModel({
      complete: (_request, abortSignal): Promise<NormalizedResponse> => {
        receivedSignal = abortSignal;
        return new Promise<NormalizedResponse>((_resolve, reject): void => {
          abortSignal?.addEventListener("abort", (): void => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
        });
      },
      stream: (): AsyncIterable<NormalizedStreamEvent> => empty(),
    }, "model");
    const result = model.doGenerate(call({ tools: undefined, abortSignal: controller.signal }));
    expect(receivedSignal).toBe(controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow("aborted");
  });

  test("exposes only safe HttpError diagnostics and retains HttpError causes", async () => {
    const httpError = new HttpError(502, "client-123", {
      contentType: "application/json",
      providerRequestId: "provider-456",
      providerCode: "upstream_error",
      providerMessage: "Retry later [REDACTED]",
    });
    httpError.message = 'Authorization: Bearer fake-secret {"raw":"body"}';
    const generate = createGheLanguageModel({ complete: (): Promise<NormalizedResponse> => { throw httpError; }, stream: (): AsyncIterable<NormalizedStreamEvent> => empty() }, "model");
    const generateError: unknown = await generate.doGenerate(call({ tools: undefined })).then(
      (): never => { throw new Error("Expected generate to reject."); },
      (error: unknown): unknown => error,
    );
    expect(generateError).toBeInstanceOf(GheLanguageModelBridgeError);
    expect((generateError as Error).cause).toBe(httpError);
    expect((generateError as Error).message).toContain("HTTP_ERROR; status 502; request client-123; content-type application/json; provider request provider-456; provider code upstream_error; provider message Retry later [REDACTED]");
    expect((generateError as Error).message).not.toContain("fake-secret");
    expect((generateError as Error).message).not.toContain('{"raw":"body"}');

    const stream = createGheLanguageModel({ complete: async (): Promise<NormalizedResponse> => { throw new Error("unused"); }, stream: (): AsyncIterable<NormalizedStreamEvent> => failingIterator(httpError) }, "model");
    const reader = (await stream.doStream(call({ tools: undefined }))).stream.getReader();
    await reader.read();
    const streamError: unknown = await reader.read().then(
      (): never => { throw new Error("Expected stream to reject."); },
      (error: unknown): unknown => error,
    );
    expect((streamError as Error).cause).toBe(httpError);
    expect((streamError as Error).message).toContain("HTTP_ERROR; status 502; request client-123; content-type application/json; provider request provider-456; provider code upstream_error; provider message Retry later [REDACTED]");
    expect((streamError as Error).message).not.toContain("fake-secret");
    expect((streamError as Error).message).not.toContain('{"raw":"body"}');

    const unrelated = new Error("stream failed");
    const unrelatedStream = createGheLanguageModel({ complete: async (): Promise<NormalizedResponse> => { throw new Error("unused"); }, stream: (): AsyncIterable<NormalizedStreamEvent> => failingIterator(unrelated) }, "model");
    const unrelatedReader = (await unrelatedStream.doStream(call({ tools: undefined }))).stream.getReader();
    await unrelatedReader.read();
    await expect(unrelatedReader.read()).rejects.toBe(unrelated);
  });

  test("streams ordered V3 parts, avoids duplicate final tool arguments, maps unknown finish, and errors", async () => {
    const events: NormalizedStreamEvent[] = [
      { type: "text-delta", text: "Hi" }, { type: "reasoning-delta", reasoning: "Why" },
      { type: "tool-call-delta", id: "call", name: "lookup", arguments: '{"id":' }, { type: "tool-call-delta", id: "call", arguments: "2}" },
      { type: "tool-call", toolCall: { id: "call", name: "lookup", arguments: { id: 2 } } }, { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } }, { type: "finish", finishReason: "unknown" },
    ];
    const model = createGheLanguageModel({ complete: async (): Promise<NormalizedResponse> => { throw new Error("unused"); }, stream: (): AsyncIterable<NormalizedStreamEvent> => iterator(events, (): void => undefined) }, "model");
    const streamed = await model.doStream(call({ tools: undefined }));
    expect(await parts(streamed.stream)).toEqual([{ type: "stream-start", warnings: [{ type: "unsupported", feature: "topP" }, { type: "unsupported", feature: "topK" }, { type: "unsupported", feature: "presencePenalty" }, { type: "unsupported", feature: "frequencyPenalty" }, { type: "unsupported", feature: "seed" }, { type: "unsupported", feature: "providerOptions" }, { type: "unsupported", feature: "responseFormat" }, { type: "unsupported", feature: "headers", details: "Adapter owns request headers." }] }, { type: "text-start", id: "text-0" }, { type: "text-delta", id: "text-0", delta: "Hi" }, { type: "reasoning-start", id: "reasoning-0" }, { type: "reasoning-delta", id: "reasoning-0", delta: "Why" }, { type: "tool-input-start", id: "call", toolName: "lookup" }, { type: "tool-input-delta", id: "call", delta: '{"id":' }, { type: "tool-input-delta", id: "call", delta: "2}" }, { type: "tool-input-end", id: "call" }, { type: "text-end", id: "text-0" }, { type: "reasoning-end", id: "reasoning-0" }, { type: "finish", usage: { inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 2, text: undefined, reasoning: undefined } }, finishReason: { unified: "other", raw: "unknown" } }]);
    const failing = createGheLanguageModel({ complete: async (): Promise<NormalizedResponse> => { throw new Error("unused"); }, stream: (): AsyncIterable<NormalizedStreamEvent> => failingIterator() }, "model");
    const reader = (await failing.doStream(call({ tools: undefined }))).stream.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow("stream failed");
  });

  test("consumer cancellation settles before pending next, aborts adapter, and safely releases iterator", async () => {
    let receivedSignal: AbortSignal | undefined;
    let returnCalls = 0;
    let releaseNext: ((value: IteratorResult<NormalizedStreamEvent>) => void) | undefined;
    let rejectReturn: ((reason: unknown) => void) | undefined;
    const pendingNext = new Promise<IteratorResult<NormalizedStreamEvent>>((resolve): void => { releaseNext = resolve; });
    const pendingReturn = new Promise<IteratorResult<NormalizedStreamEvent>>((_resolve, reject): void => { rejectReturn = reject; });
    const model = createGheLanguageModel({
      complete: async (): Promise<NormalizedResponse> => { throw new Error("unused"); },
      stream: (_request, abortSignal): AsyncIterable<NormalizedStreamEvent> => {
        receivedSignal = abortSignal;
        return { [Symbol.asyncIterator](): AsyncIterator<NormalizedStreamEvent> { return {
          next: (): Promise<IteratorResult<NormalizedStreamEvent>> => pendingNext,
          return: (): Promise<IteratorResult<NormalizedStreamEvent>> => { returnCalls += 1; return pendingReturn; },
        }; } };
      },
    }, "model");
    const streamed = await model.doStream(call({ tools: undefined }));
    await streamed.stream.cancel();
    expect(receivedSignal?.aborted).toBe(true);
    expect(returnCalls).toBe(1);
    await streamed.stream.cancel();
    expect(returnCalls).toBe(1);
    releaseNext?.({ done: true, value: undefined });
    rejectReturn?.(new Error("deferred return failed"));
    await Promise.resolve();
  });

  test("caller cancellation returns a signal-ignoring pending iterator without post-abort work", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let returnCalls = 0;
    let releaseNext: ((value: IteratorResult<NormalizedStreamEvent>) => void) | undefined;
    const pendingNext = new Promise<IteratorResult<NormalizedStreamEvent>>((resolve): void => { releaseNext = resolve; });
    const model = createGheLanguageModel({
      complete: async (): Promise<NormalizedResponse> => { throw new Error("unused"); },
      stream: (_request, abortSignal): AsyncIterable<NormalizedStreamEvent> => {
        receivedSignal = abortSignal;
        return { [Symbol.asyncIterator](): AsyncIterator<NormalizedStreamEvent> { return {
          next: (): Promise<IteratorResult<NormalizedStreamEvent>> => pendingNext,
          return: (): Promise<IteratorResult<NormalizedStreamEvent>> => { returnCalls += 1; return Promise.reject(new Error("deferred return failed")); },
        }; } };
      },
    }, "model");
    const reader = (await model.doStream(call({ tools: undefined, abortSignal: controller.signal }))).stream.getReader();
    await reader.read();
    controller.abort();
    await Promise.resolve();
    expect(receivedSignal?.aborted).toBe(true);
    expect(returnCalls).toBe(1);
    const nextRead = reader.read();
    let nextReadSettled = false;
    void nextRead.then((): void => { nextReadSettled = true; });
    releaseNext?.({ done: false, value: { type: "text-delta", text: "ignored" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(nextReadSettled).toBe(false);
    await reader.cancel();
    expect(returnCalls).toBe(1);
  });
});

async function* empty(): AsyncIterable<NormalizedStreamEvent> {}

function iterator(events: readonly NormalizedStreamEvent[], onReturn: () => void): AsyncIterable<NormalizedStreamEvent> {
  return { [Symbol.asyncIterator](): AsyncIterator<NormalizedStreamEvent> { let index = 0; return { next: async (): Promise<IteratorResult<NormalizedStreamEvent>> => index < events.length ? { done: false, value: events[index++] as NormalizedStreamEvent } : { done: true, value: undefined }, return: async (): Promise<IteratorResult<NormalizedStreamEvent>> => { onReturn(); return { done: true, value: undefined }; } }; } };
}

function failingIterator(error: Error = new Error("stream failed")): AsyncIterable<NormalizedStreamEvent> {
  return { [Symbol.asyncIterator](): AsyncIterator<NormalizedStreamEvent> { return { next: async (): Promise<IteratorResult<NormalizedStreamEvent>> => Promise.reject(error) }; } };
}
