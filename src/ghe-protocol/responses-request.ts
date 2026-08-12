import { InvalidRequestError } from "./errors.ts";
import type { GheModelProfile, GheMessage, GheRequest, GheTool, SystemRoleMode } from "./types.ts";

type ResponsesInputItem = ResponsesMessageItem | ResponsesFunctionCallItem | ResponsesFunctionCallOutputItem;

interface ResponsesMessageItem {
  readonly role: "system" | "developer" | "user" | "assistant";
  readonly content: readonly (ResponsesInputTextPart | ResponsesOutputTextPart)[];
}

interface ResponsesInputTextPart {
  readonly type: "input_text";
  readonly text: string;
}

interface ResponsesOutputTextPart {
  readonly type: "output_text";
  readonly text: string;
}

interface ResponsesFunctionCallItem {
  readonly type: "function_call";
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}

interface ResponsesFunctionCallOutputItem {
  readonly type: "function_call_output";
  readonly call_id: string;
  readonly output: readonly ResponsesInputTextPart[];
}

export function buildResponsesBody(profile: GheModelProfile, request: GheRequest, stream: boolean, systemRole: SystemRoleMode): Record<string, unknown> {
  if (!Array.isArray(request.messages)) throw invalid("messages");
  const input: ResponsesInputItem[] = [];
  for (const message of request.messages) addMessageItems(input, message, systemRole);
  const body: Record<string, unknown> = { model: profile.wireModel, input, stream };
  if (request.options?.maxOutputTokens !== undefined) body.max_output_tokens = request.options.maxOutputTokens;
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools)) throw invalid("tools");
    body.tools = request.tools.map(responseTool);
  }
  if (request.toolChoice !== undefined) body.tool_choice = responseToolChoice(request.toolChoice);
  return body;
}

function addMessageItems(input: ResponsesInputItem[], message: GheMessage, systemRole: SystemRoleMode): void {
  if (!isRecord(message) || !isMessageRole(message.role) || typeof message.content !== "string") throw invalid("message content");
  if (message.role === "tool") {
    input.push({ type: "function_call_output", call_id: requiredString(message.toolCallId, "tool result call ID"), output: [{ type: "input_text", text: message.content }] });
    return;
  }
  const role = message.role === "system" ? systemRole : message.role;
  if (message.role !== "assistant") {
    input.push({ role, content: [{ type: "input_text", text: message.content }] });
    return;
  }
  if (message.toolCalls === undefined) {
    input.push({ role, content: [{ type: "output_text", text: message.content }] });
    return;
  }
  if (!Array.isArray(message.toolCalls)) throw invalid("assistant tool calls");
  if (message.content !== "" || message.toolCalls.length === 0) input.push({ role, content: [{ type: "output_text", text: message.content }] });
  for (const toolCall of message.toolCalls) {
    if (!isRecord(toolCall)) throw invalid("assistant tool call");
    input.push({
      type: "function_call",
      call_id: requiredString(toolCall.id, "assistant tool call ID"),
      name: requiredString(toolCall.name, "assistant tool call name"),
      arguments: serializeArguments(toolCall.arguments),
    });
  }
}

function responseTool(tool: GheTool): Record<string, unknown> {
  if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) throw invalid("tool");
  const name = requiredString(tool.function.name, "tool name");
  if (tool.function.description !== undefined && typeof tool.function.description !== "string") throw invalid("tool description");
  if (tool.function.parameters !== undefined && !isRecord(tool.function.parameters)) throw invalid("tool parameters");
  return {
    type: "function",
    name,
    ...(tool.function.description === undefined ? {} : { description: tool.function.description }),
    ...(tool.function.parameters === undefined ? {} : { parameters: tool.function.parameters }),
  };
}

function responseToolChoice(choice: unknown): "auto" | "none" | "required" | Record<string, string> {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (!isRecord(choice) || choice.type !== "function" || !isRecord(choice.function)) throw invalid("tool choice");
  return { type: "function", name: requiredString(choice.function.name, "tool choice name") };
}

function serializeArguments(argumentsValue: unknown): string {
  if (typeof argumentsValue === "string") {
    try {
      JSON.parse(argumentsValue);
      return argumentsValue;
    } catch {
      throw invalid("assistant tool call arguments");
    }
  }
  try {
    const serialized = JSON.stringify(argumentsValue);
    if (serialized === undefined) throw invalid("assistant tool call arguments");
    return serialized;
  } catch (error: unknown) {
    if (error instanceof InvalidRequestError) throw error;
    throw invalid("assistant tool call arguments");
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw invalid(field);
  return value;
}

function isMessageRole(value: unknown): value is GheMessage["role"] {
  return value === "system" || value === "developer" || value === "user" || value === "assistant" || value === "tool";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(field: string): InvalidRequestError {
  return new InvalidRequestError(`Invalid Responses request ${field}.`);
}
