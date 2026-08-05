import { ConfigurationError, UnsupportedOptionError } from "./errors.ts";
import { normalizeBuiltInModelID } from "./config.ts";
import type { GheModelProfile, GheProtocolConfig, GheRequest } from "./types.ts";

const RESERVED_HEADERS = new Set([
  "authorization", "content-type", "copilot-integration-id", "editor-version", "editor-plugin-version",
  "user-agent", "openai-intent", "x-github-api-version", "x-request-id", "x-vscode-user-agent-library-version", "x-initiator",
]);

export function validateConfig(config: GheProtocolConfig): void {
  try { new URL(config.baseUrl); } catch { throw new ConfigurationError("baseUrl must be a valid URL."); }
  for (const name of Object.keys(config.copilotHeaders)) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) throw new ConfigurationError(`copilotHeaders cannot override ${name}.`);
  }
  if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)) throw new ConfigurationError("timeoutMs must be positive.");
}

export function selectProfile(config: GheProtocolConfig, model: string): GheModelProfile {
  const profiles = { ...config.modelProfiles };
  const profile = profiles[normalizeBuiltInModelID(model)];
  if (profile === undefined) throw new ConfigurationError(`Unsupported model: ${model}.`);
  return profile;
}

export function validateRequest(request: GheRequest): void {
  const options = request.options;
  if (options === undefined) return;
  for (const key of Object.keys(options)) {
    if (key !== "temperature" && key !== "maxOutputTokens" && key !== "stopSequences") throw new UnsupportedOptionError(key);
  }
  if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) throw new UnsupportedOptionError("temperature");
  if (options.maxOutputTokens !== undefined && (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0)) throw new UnsupportedOptionError("maxOutputTokens");
  if (options.stopSequences !== undefined && options.stopSequences.some((value: string) => typeof value !== "string" || value === "")) throw new UnsupportedOptionError("stopSequences");
}

export function buildBody(profile: GheModelProfile, request: GheRequest, stream: boolean, systemRole: "system" | "assistant" = "system"): Record<string, unknown> {
  const options = request.options;
  const messages = request.messages.map((message) => ({ role: message.role === "system" ? systemRole : message.role, content: message.content, ...(message.name === undefined ? {} : { name: message.name }), ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }) }));
  const body: Record<string, unknown> = profile.endpoint === "chat"
    ? { model: profile.wireModel, messages, stream }
    : { model: profile.wireModel, input: messages, stream };
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.maxOutputTokens !== undefined) body[profile.endpoint === "chat" ? "max_tokens" : "max_output_tokens"] = options.maxOutputTokens;
  if (options?.stopSequences !== undefined) body.stop = options.stopSequences;
  if (request.tools !== undefined) body.tools = request.tools;
  if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  if (profile.endpoint === "chat" && profile.reasoningBudget !== undefined) body.thinking = { type: "enabled", budget_tokens: profile.reasoningBudget };
  return body;
}
