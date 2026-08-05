import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3Message,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
  SharedV3Warning,
} from "@ai-sdk/provider";
import { HttpError } from "./ghe-protocol.ts";
import type {
  FinishReason,
  GheMessage,
  GheProtocolAdapter,
  GheRequest,
  GheTool,
  NormalizedResponse,
  NormalizedStreamEvent,
  NormalizedToolCall,
  NormalizedUsage,
} from "./ghe-protocol.ts";

export class GheLanguageModelBridgeError extends Error {
  public readonly cause?: unknown;

  public constructor(message: string, options?: ErrorOptions) {
    super(message);
    this.name = "GheLanguageModelBridgeError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export type GheLanguageModelAdapter = Pick<GheProtocolAdapter, "complete" | "stream">;

export function createGheLanguageModel(adapter: GheLanguageModelAdapter, modelId: string): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "ghe",
    modelId,
    supportedUrls: {},
    doGenerate: async (options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> => {
      throwIfAborted(options.abortSignal);
      const mapped: MappedRequest = mapRequest(options, modelId);
      try {
        const response: NormalizedResponse = await adapter.complete(mapped.request, options.abortSignal);
        return mapGenerateResult(response, mapped.warnings);
      } catch (error: unknown) {
        throw bridgeHttpError(error);
      }
    },
    doStream: async (options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> => {
      throwIfAborted(options.abortSignal);
      const mapped: MappedRequest = mapRequest(options, modelId);
      const streamAbort: StreamAbort = createStreamAbort(options.abortSignal);
      try {
        const events: AsyncIterable<NormalizedStreamEvent> = adapter.stream(mapped.request, streamAbort.signal);
        return { stream: createStream(events, mapped.warnings, streamAbort) };
      } catch (error: unknown) {
        streamAbort.cleanup();
        throw bridgeHttpError(error);
      }
    },
  };
}

interface MappedRequest {
  readonly request: GheRequest;
  readonly warnings: SharedV3Warning[];
}

function mapRequest(options: LanguageModelV3CallOptions, modelId: string): MappedRequest {
  const tools: GheTool[] | undefined = options.tools === undefined ? undefined : options.tools.map(mapTool);
  const request: GheRequest = {
    model: modelId,
    messages: mapPrompt(options),
    ...(tools === undefined ? {} : { tools }),
    ...(options.toolChoice === undefined ? {} : { toolChoice: mapToolChoice(options.toolChoice) }),
    options: {
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
      ...(options.stopSequences === undefined ? {} : { stopSequences: options.stopSequences }),
    },
  };
  return { request, warnings: getWarnings(options) };
}

function mapPrompt(options: LanguageModelV3CallOptions): GheMessage[] {
  const messages: GheMessage[] = [];
  for (const message of options.prompt) {
    if (message.role === "system") {
      messages.push({ role: "system", content: message.content });
      continue;
    }
    if (message.role === "user") {
      messages.push({ role: "user", content: joinTextParts(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      messages.push({ role: "assistant", content: joinAssistantParts(message.content) });
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool-approval-response") {
        throw unsupported("tool approval responses");
      }
      messages.push({
        role: "tool",
        content: toolResultContent(part.output),
        name: part.toolName,
        toolCallId: part.toolCallId,
      });
    }
  }
  return messages;
}

function joinTextParts(parts: Extract<LanguageModelV3Message, { role: "user" }>['content']): string {
  let content = "";
  for (const part of parts) {
    if (part.type !== "text") throw unsupported("file inputs");
    content += part.text;
  }
  return content;
}

function joinAssistantParts(parts: Extract<LanguageModelV3Message, { role: "assistant" }>['content']): string {
  let content = "";
  for (const part of parts) {
    if (part.type === "text" || part.type === "reasoning") {
      content += part.text;
      continue;
    }
    throw unsupported("historical assistant tool calls, tool results, or files");
  }
  return content;
}

function toolResultContent(output: LanguageModelV3ToolResultOutput): string {
  if (output.type === "text" || output.type === "error-text") return output.value;
  if (output.type === "json" || output.type === "error-json") return stringify(output.value);
  if (output.type === "content") {
    let content = "";
    for (const part of output.value) {
      if (part.type !== "text") throw unsupported("tool result media content");
      content += part.text;
    }
    return content;
  }
  throw unsupported("tool result execution denial");
}

function mapTool(tool: NonNullable<LanguageModelV3CallOptions["tools"]>[number]): GheTool {
  if (tool.type !== "function") throw unsupported("provider tools");
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  };
}

function mapToolChoice(choice: NonNullable<LanguageModelV3CallOptions["toolChoice"]>): unknown {
  if (choice.type === "tool") return { type: "function", function: { name: choice.toolName } };
  return choice.type;
}

function getWarnings(options: LanguageModelV3CallOptions): SharedV3Warning[] {
  const warnings: SharedV3Warning[] = [];
  const unsupportedOptions: readonly [string, unknown][] = [
    ["topP", options.topP], ["topK", options.topK], ["presencePenalty", options.presencePenalty],
    ["frequencyPenalty", options.frequencyPenalty], ["seed", options.seed], ["providerOptions", options.providerOptions],
  ];
  for (const [feature, value] of unsupportedOptions) {
    if (value !== undefined) warnings.push({ type: "unsupported", feature });
  }
  if (options.responseFormat?.type === "json") warnings.push({ type: "unsupported", feature: "responseFormat" });
  if (options.headers !== undefined && Object.keys(options.headers).length > 0) {
    warnings.push({ type: "unsupported", feature: "headers", details: "Adapter owns request headers." });
  }
  return warnings;
}

function mapGenerateResult(response: NormalizedResponse, warnings: SharedV3Warning[]): LanguageModelV3GenerateResult {
  const content: LanguageModelV3Content[] = [];
  if (response.text.length > 0) content.push({ type: "text", text: response.text });
  if (response.reasoning.length > 0) content.push({ type: "reasoning", text: response.reasoning });
  for (const toolCall of response.toolCalls) content.push(mapToolCall(toolCall));
  return {
    content,
    finishReason: mapFinishReason(response.finishReason),
    usage: mapUsage(response.usage),
    warnings,
    providerMetadata: requestMetadata(response),
  };
}

function mapToolCall(toolCall: NormalizedToolCall): LanguageModelV3Content {
  return { type: "tool-call", toolCallId: toolCall.id, toolName: toolCall.name, input: stringify(toolCall.arguments) };
}

function mapUsage(usage: NormalizedUsage): LanguageModelV3Usage {
  return {
    inputTokens: { total: usage.inputTokens, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: usage.outputTokens, text: undefined, reasoning: usage.reasoningTokens },
  };
}

function mapFinishReason(reason: FinishReason): LanguageModelV3FinishReason {
  return { unified: reason === "unknown" ? "other" : reason, raw: reason };
}

function requestMetadata(response: NormalizedResponse): SharedV3ProviderMetadata {
  return {
    ghe: {
      requestId: response.requestId,
      ...(response.providerRequestId === undefined ? {} : { providerRequestId: response.providerRequestId }),
    },
  };
}

interface StreamAbort {
  readonly signal: AbortSignal;
  abort(): void;
  cleanup(): void;
}

function createStreamAbort(callerSignal: AbortSignal | undefined): StreamAbort {
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  return {
    signal: controller.signal,
    abort: (): void => controller.abort(),
    cleanup: (): void => callerSignal?.removeEventListener("abort", abortFromCaller),
  };
}

function createStream(events: AsyncIterable<NormalizedStreamEvent>, warnings: SharedV3Warning[], streamAbort: StreamAbort): ReadableStream<LanguageModelV3StreamPart> {
  const iterator: AsyncIterator<NormalizedStreamEvent> = events[Symbol.asyncIterator]();
  let consumerCancelled = false;
  let callerAborted = false;
  let returned = false;
  const returnIterator = (): void => {
    if (returned) return;
    returned = true;
    void Promise.resolve().then((): Promise<IteratorResult<NormalizedStreamEvent>> | undefined => iterator.return?.()).catch((): void => undefined);
  };
  const cleanup = (): void => {
    streamAbort.signal.removeEventListener("abort", abortFromCaller);
    streamAbort.cleanup();
  };
  const finalize = (): void => {
    streamAbort.abort();
    cleanup();
    returnIterator();
  };
  const cancel = (): void => {
    if (consumerCancelled) return;
    consumerCancelled = true;
    finalize();
  };
  const abortFromCaller = (): void => {
    callerAborted = true;
    finalize();
  };
  if (streamAbort.signal.aborted) abortFromCaller();
  else streamAbort.signal.addEventListener("abort", abortFromCaller, { once: true });
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>): void {
      if (consumerCancelled || callerAborted) return;
      controller.enqueue({ type: "stream-start", warnings });
      void pumpStream(iterator, controller, (): boolean => consumerCancelled || callerAborted, (): boolean => !consumerCancelled, cleanup);
    },
    cancel(): void {
      cancel();
    },
  });
}

async function pumpStream(iterator: AsyncIterator<NormalizedStreamEvent>, controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>, isStopped: () => boolean, shouldReportError: () => boolean, cleanup: () => void): Promise<void> {
  let textOpen = false;
  let reasoningOpen = false;
  let finishReason: FinishReason = "unknown";
  let usage: NormalizedUsage = {};
  const tools = new Map<string, StreamTool>();
  try {
    for (;;) {
      const next: IteratorResult<NormalizedStreamEvent> = await iterator.next();
      if (isStopped()) return;
      if (next.done) break;
      const event: NormalizedStreamEvent = next.value;
      if (event.type === "text-delta") {
        if (!textOpen) { controller.enqueue({ type: "text-start", id: "text-0" }); textOpen = true; }
        controller.enqueue({ type: "text-delta", id: "text-0", delta: event.text });
      } else if (event.type === "reasoning-delta") {
        if (!reasoningOpen) { controller.enqueue({ type: "reasoning-start", id: "reasoning-0" }); reasoningOpen = true; }
        controller.enqueue({ type: "reasoning-delta", id: "reasoning-0", delta: event.reasoning });
      } else if (event.type === "tool-call-delta") {
        const tool: StreamTool = tools.get(event.id) ?? { id: event.id, buffered: "", emitted: "", ended: false };
        if (event.name !== undefined) tool.name = event.name;
        tool.buffered += event.arguments;
        tools.set(event.id, tool);
        startTool(tool, controller);
      } else if (event.type === "tool-call") {
        const tool: StreamTool = tools.get(event.toolCall.id) ?? { id: event.toolCall.id, buffered: "", emitted: "", ended: false };
        tool.name = event.toolCall.name;
        tools.set(tool.id, tool);
        startTool(tool, controller);
        emitFinalToolArguments(tool, stringify(event.toolCall.arguments), controller);
        endTool(tool, controller);
      } else if (event.type === "usage") {
        usage = event.usage;
      } else {
        finishReason = event.finishReason;
      }
    }
    if (isStopped()) return;
    if (textOpen) controller.enqueue({ type: "text-end", id: "text-0" });
    if (reasoningOpen) controller.enqueue({ type: "reasoning-end", id: "reasoning-0" });
    for (const tool of tools.values()) endTool(tool, controller);
    controller.enqueue({ type: "finish", usage: mapUsage(usage), finishReason: mapFinishReason(finishReason) });
    controller.close();
  } catch (error: unknown) {
    if (shouldReportError()) controller.error(bridgeHttpError(error));
  } finally {
    cleanup();
  }
}

interface StreamTool {
  readonly id: string;
  name?: string;
  buffered: string;
  emitted: string;
  started?: boolean;
  ended: boolean;
}

function startTool(tool: StreamTool, controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>): void {
  if (tool.started || tool.name === undefined) return;
  controller.enqueue({ type: "tool-input-start", id: tool.id, toolName: tool.name });
  tool.started = true;
  if (tool.buffered.length > 0) {
    controller.enqueue({ type: "tool-input-delta", id: tool.id, delta: tool.buffered });
    tool.emitted += tool.buffered;
    tool.buffered = "";
  }
}

function emitFinalToolArguments(tool: StreamTool, input: string, controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>): void {
  if (!tool.started) throw new GheLanguageModelBridgeError("Tool call ended without a name.");
  const delta: string = input.startsWith(tool.emitted) ? input.slice(tool.emitted.length) : tool.emitted.length === 0 ? input : "";
  if (delta.length > 0) {
    controller.enqueue({ type: "tool-input-delta", id: tool.id, delta });
    tool.emitted += delta;
  }
}

function endTool(tool: StreamTool, controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>): void {
  if (tool.ended || !tool.started) return;
  controller.enqueue({ type: "tool-input-end", id: tool.id });
  tool.ended = true;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized: string | undefined = JSON.stringify(value);
  return serialized ?? "null";
}

function unsupported(feature: string): GheLanguageModelBridgeError {
  return new GheLanguageModelBridgeError(`GHE language model bridge does not support ${feature}.`);
}

function bridgeHttpError(error: unknown): unknown {
  if (!(error instanceof HttpError)) return error;
  const evidence: string[] = ["HTTP_ERROR", `status ${error.status}`, `request ${error.requestId}`];
  if (error.contentType !== undefined) evidence.push(`content-type ${error.contentType}`);
  if (error.providerRequestId !== undefined) evidence.push(`provider request ${error.providerRequestId}`);
  if (error.providerCode !== undefined) evidence.push(`provider code ${error.providerCode}`);
  if (error.providerMessage !== undefined) evidence.push(`provider message ${error.providerMessage}`);
  return new GheLanguageModelBridgeError(`GHE request failed: ${evidence.join("; ")}.`, { cause: error });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
}
