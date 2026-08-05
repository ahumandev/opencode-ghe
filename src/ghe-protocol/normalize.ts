import { MalformedResponseError } from "./errors.ts";
import type { FinishReason, NormalizedResponse, NormalizedStreamEvent, NormalizedToolCall, NormalizedUsage } from "./types.ts";

type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}
export function asArray(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
export function asString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
export function text(value: unknown): string {
  if (typeof value === "string") return value;
  return asArray(value).map((part: unknown) => asString(asObject(part)?.text) ?? asString(asObject(part)?.content) ?? "").join("");
}
export function finish(value: unknown): FinishReason {
  if (value === "stop" || value === "completed") return "stop";
  if (value === "length" || value === "max_tokens" || value === "incomplete") return "length";
  if (value === "tool_calls" || value === "function_call") return "tool-calls";
  if (value === "content_filter") return "content-filter";
  if (value === "error" || value === "failed") return "error";
  return "unknown";
}
export function argumentsValue(value: unknown): unknown {
  if (typeof value !== "string") return value ?? "";
  try { return JSON.parse(value) as unknown; } catch { return value; }
}
export function usage(value: unknown): NormalizedUsage {
  const object = asObject(value);
  if (object === undefined) return {};
  const details = asObject(object.completion_tokens_details) ?? asObject(object.output_tokens_details);
  const inputTokens = numberValue(object.prompt_tokens) ?? numberValue(object.input_tokens);
  const outputTokens = numberValue(object.completion_tokens) ?? numberValue(object.output_tokens);
  const totalTokens = numberValue(object.total_tokens);
  const reasoningTokens = numberValue(details?.reasoning_tokens);
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(totalTokens === undefined ? {} : { totalTokens }), ...(reasoningTokens === undefined ? {} : { reasoningTokens }) };
}
function numberValue(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }
function providerId(headers: Headers): string | undefined { return headers.get("x-request-id") ?? headers.get("x-github-request-id") ?? undefined; }

export function normalizeResponse(payload: unknown, endpoint: "chat" | "responses", requestId: string, headers: Headers): NormalizedResponse {
  const object = asObject(payload);
  if (object === undefined) throw new MalformedResponseError(requestId);
  if (endpoint === "chat") return normalizeChat(object, requestId, headers);
  return normalizeResponses(object, requestId, headers);
}
function normalizeChat(payload: JsonObject, requestId: string, headers: Headers): NormalizedResponse {
  const choice = asObject(asArray(payload.choices)[0]);
  const message = asObject(choice?.message);
  if (choice === undefined || message === undefined) throw new MalformedResponseError(requestId);
  const calls = asArray(message.tool_calls).map(toolCall);
  return response(requestId, headers, asString(payload.model), text(message.content), text(message.reasoning) || text(message.reasoning_content), calls, finish(choice.finish_reason), usage(payload.usage));
}
function normalizeResponses(payload: JsonObject, requestId: string, headers: Headers): NormalizedResponse {
  const output = asArray(payload.output);
  const messages = output.filter((item: unknown) => asObject(item)?.type === "message");
  const textValue = messages.map((item: unknown) => text(asObject(item)?.content) || text(asObject(item)?.output_text)).join("");
  const reasoning = output.filter((item: unknown) => asObject(item)?.type === "reasoning").map((item: unknown) => text(asObject(item)?.summary) || text(asObject(item)?.content)).join("");
  const calls = output.filter((item: unknown) => asObject(item)?.type === "function_call").map(toolCall);
  const status = asString(payload.status);
  const incomplete = asObject(payload.incomplete_details);
  if (textValue === "" && reasoning === "" && calls.length === 0 && status === undefined && incomplete === undefined) throw new MalformedResponseError(requestId);
  return response(requestId, headers, asString(payload.model), textValue, reasoning, calls, finish(payload.status) === "unknown" ? finish(incomplete?.reason) : finish(payload.status), usage(payload.usage));
}
function response(requestId: string, headers: Headers, model: string | undefined, textValue: string, reasoning: string, toolCalls: readonly NormalizedToolCall[], finishReason: FinishReason, usageValue: NormalizedUsage): NormalizedResponse {
  const request = providerId(headers);
  return { requestId, ...(request === undefined ? {} : { providerRequestId: request }), ...(model === undefined ? {} : { model }), text: textValue, reasoning, toolCalls, finishReason, usage: usageValue };
}
function toolCall(value: unknown): NormalizedToolCall {
  const item = asObject(value) ?? {};
  const functionValue = asObject(item.function);
  return { id: asString(item.id) ?? asString(item.call_id) ?? "", name: asString(functionValue?.name) ?? asString(item.name) ?? "", arguments: argumentsValue(functionValue?.arguments ?? item.arguments) };
}

export function normalizeChatEvent(payload: JsonObject, toolIds: Map<number, string>): readonly NormalizedStreamEvent[] {
  const choice = asObject(asArray(payload.choices)[0]);
  if (choice === undefined) return usageEvent(payload);
  const delta = asObject(choice.delta) ?? {};
  const events: NormalizedStreamEvent[] = [];
  const content = text(delta.content); if (content) events.push({ type: "text-delta", text: content });
  const reasoning = text(delta.reasoning) || text(delta.reasoning_content); if (reasoning) events.push({ type: "reasoning-delta", reasoning });
  let fallbackIndex = 0;
  for (const call of asArray(delta.tool_calls)) {
    const item = asObject(call) ?? {}; const fn = asObject(item.function);
    const args = asString(fn?.arguments) ?? "";
    const index = typeof item.index === "number" && Number.isInteger(item.index) ? item.index : fallbackIndex;
    fallbackIndex += 1;
    const providerId = asString(item.id);
    const id = toolIds.get(index) ?? providerId ?? `tool-call-${index}`;
    toolIds.set(index, id);
    const name = asString(fn?.name);
    events.push({ type: "tool-call-delta", id, ...(name === undefined ? {} : { name }), arguments: args });
  }
  if (choice.finish_reason !== undefined) events.push({ type: "finish", finishReason: finish(choice.finish_reason) });
  return [...events, ...usageEvent(payload)];
}
export function normalizeResponsesEvent(type: string, payload: JsonObject): readonly NormalizedStreamEvent[] {
  const events: NormalizedStreamEvent[] = [];
  const delta = text(payload.delta);
  if (type.includes("output_text") && delta) events.push({ type: "text-delta", text: delta });
  if (type.includes("reasoning") && delta) events.push({ type: "reasoning-delta", reasoning: delta });
  if (type.includes("function_call_arguments") && delta) events.push({ type: "tool-call-delta", id: asString(payload.item_id) ?? asString(payload.call_id) ?? "", arguments: delta });
  if (type.includes("function_call") && (type.endsWith("done") || type.endsWith("completed"))) events.push({ type: "tool-call", toolCall: toolCall(payload.item ?? payload) });
  if (type.endsWith("completed")) events.push({ type: "finish", finishReason: "stop" });
  if (type.endsWith("failed")) events.push({ type: "finish", finishReason: "error" });
  return [...events, ...usageEvent(asObject(payload.response) ?? payload)];
}
function usageEvent(payload: JsonObject): readonly NormalizedStreamEvent[] { const value = usage(payload.usage); return Object.keys(value).length === 0 ? [] : [{ type: "usage", usage: value }]; }
