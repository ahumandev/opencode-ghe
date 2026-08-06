import { joinUrlPath } from "./url.ts";

export const DEFAULT_BASE_URL = "https://ghe.example.test";
export const FIXED_PROMPT = "Reply with OK.";
export const RESPONSES_MODELS = new Set<string>(["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"]);
export const REDACTED = "<redacted>";

export type EndpointKind = "chat" | "responses";
export type ProbeMethod = "dry-run" | "live";
export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

export interface ProbeConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly stream: boolean;
  readonly live: boolean;
  readonly output?: string;
  readonly token?: string;
}

export interface ProbeRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Record<string, string>;
  readonly body: JsonValue;
  readonly endpoint: EndpointKind;
}

export interface ProbeFixture {
  readonly request: {
    readonly method: "POST";
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: JsonValue;
  };
  readonly response?: SanitizedResponse;
  readonly error?: SanitizedError;
}

export interface SanitizedResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly body: JsonValue;
}

export interface SanitizedError {
  readonly name: string;
  readonly message: string;
}

export interface ExecutionResult {
  readonly method: ProbeMethod;
  readonly fixture: ProbeFixture;
  readonly ok: boolean;
}

export type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

interface ParsedArguments {
  readonly help: boolean;
  readonly values: Record<"baseUrl" | "model" | "output", string | undefined>;
  readonly flags: Record<"stream" | "live", boolean>;
}

export function selectEndpoint(model: string): EndpointKind {
  return RESPONSES_MODELS.has(model) ? "responses" : "chat";
}

export function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("Invalid --base-url: must be an absolute HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new ConfigError("Invalid --base-url: use an HTTPS URL without credentials, query, or fragment.");
  }
  return value;
}

export function parseArguments(args: readonly string[]): ParsedArguments {
  const values: Record<"baseUrl" | "model" | "output", string | undefined> = { baseUrl: undefined, model: undefined, output: undefined };
  const flags: Record<"stream" | "live", boolean> = { stream: false, live: false };
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help") {
      if (help) throw new ConfigError("Duplicate flag: --help.");
      help = true;
      continue;
    }
    if (argument === "--stream" || argument === "--live") {
      const key = argument === "--stream" ? "stream" : "live";
      if (flags[key]) throw new ConfigError(`Duplicate flag: ${argument}.`);
      flags[key] = true;
      continue;
    }
    const key = argument === "--base-url" ? "baseUrl" : argument === "--model" ? "model" : argument === "--output" ? "output" : undefined;
    if (key === undefined) throw new ConfigError(`Unknown argument: ${argument ?? ""}.`);
    if (values[key] !== undefined) throw new ConfigError(`Duplicate option: ${argument}.`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim() === "") throw new ConfigError(`Missing value for ${argument}.`);
    values[key] = value;
    index += 1;
  }
  return { help, values, flags };
}

export function parseConfig(args: readonly string[], token: string | undefined): ProbeConfig | { readonly help: true } {
  const parsed = parseArguments(args);
  if (parsed.help) return { help: true };
  const model = parsed.values.model;
  if (model === undefined) throw new ConfigError("Missing required option: --model.");
  const normalizedToken = token?.trim() || undefined;
  if (parsed.flags.live && normalizedToken === undefined) throw new ConfigError("--live requires nonblank BMW_GHE_TOKEN.");
  return {
    baseUrl: validateBaseUrl(parsed.values.baseUrl ?? DEFAULT_BASE_URL),
    model,
    stream: parsed.flags.stream,
    live: parsed.flags.live,
    ...(parsed.values.output === undefined ? {} : { output: parsed.values.output }),
    ...(normalizedToken === undefined ? {} : { token: normalizedToken }),
  };
}

export function buildRequest(config: ProbeConfig): ProbeRequest {
  const endpoint = selectEndpoint(config.model);
  const body: JsonValue = endpoint === "responses"
    ? { model: config.model, input: FIXED_PROMPT, stream: config.stream }
    : { model: config.model, messages: [{ role: "user", content: FIXED_PROMPT }], stream: config.stream };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.live ? config.token ?? "" : REDACTED}`,
    "Content-Type": "application/json",
    Accept: config.stream ? "text/event-stream" : "application/json",
  };
  return { url: joinUrlPath(config.baseUrl, endpoint === "responses" ? "responses" : "chat/completions"), method: "POST", headers, body, endpoint };
}

export function redactUrl(value: string): string {
  const url = new URL(value);
  if (url.username !== "" || url.password !== "") {
    url.username = REDACTED;
    url.password = REDACTED;
  }
  for (const key of Array.from(url.searchParams.keys())) url.searchParams.set(key, REDACTED);
  return url.toString();
}

export function sanitizeHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  const entries = headers instanceof Headers ? Array.from(headers.entries()) : Object.entries(headers);
  for (const [name, value] of entries) output[name] = isSensitiveKey(name) ? REDACTED : value;
  return output;
}

export function sanitizeValue(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return REDACTED;
  if (Array.isArray(value)) return value.map((item: unknown): JsonValue => sanitizeValue(item));
  if (typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) output[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(nested);
    return output;
  }
  return REDACTED;
}

export function sanitizeRequest(request: ProbeRequest): ProbeFixture["request"] {
  return { method: request.method, url: redactUrl(request.url), headers: sanitizeHeaders(request.headers), body: sanitizeValue(request.body) };
}

export async function executeProbe(config: ProbeConfig, fetchFunction: FetchFunction = fetch): Promise<ExecutionResult> {
  if (config.live && !config.token?.trim()) throw new ConfigError("--live requires nonblank BMW_GHE_TOKEN.");
  const request = buildRequest(config);
  const fixtureRequest = sanitizeRequest(request);
  if (!config.live) return { method: "dry-run", fixture: { request: fixtureRequest }, ok: true };
  try {
    const response = await fetchFunction(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(request.body) });
    const sanitized = await sanitizeResponse(response, config.stream);
    return { method: "live", fixture: { request: fixtureRequest, response: sanitized }, ok: response.ok };
  } catch (error: unknown) {
    return { method: "live", fixture: { request: fixtureRequest, error: sanitizeError(error) }, ok: false };
  }
}

export async function sanitizeResponse(response: Response, stream: boolean): Promise<SanitizedResponse> {
  const body = stream ? await sanitizeSseBody(response.body) : await sanitizeNonStreamBody(response);
  return { status: response.status, statusText: response.statusText, headers: sanitizeHeaders(response.headers), body };
}

export async function sanitizeNonStreamBody(response: Response): Promise<JsonValue> {
  const text = await response.text();
  if (text === "") return null;
  try {
    return sanitizeValue(JSON.parse(text) as unknown);
  } catch {
    return REDACTED;
  }
}

export async function sanitizeSseBody(body: ReadableStream<Uint8Array> | null): Promise<JsonValue> {
  if (body === null) return { type: "sse", events: [] };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: JsonValue[] = [];
  let pending = "";
  while (true) {
    const result = await reader.read();
    pending += decoder.decode(result.value, { stream: !result.done });
    const lines = pending.split(/\r?\n/);
    pending = result.done ? "" : lines.pop() ?? "";
    for (const line of lines) addSanitizedSseLine(events, line);
    if (result.done) break;
  }
  if (pending !== "") addSanitizedSseLine(events, pending);
  return { type: "sse", events };
}

export function addSanitizedSseLine(events: JsonValue[], line: string): void {
  if (line === "") return;
  const separator = line.indexOf(":");
  const field = separator < 0 ? line : line.slice(0, separator);
  const rawValue = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
  if (field === "data") {
    if (rawValue === "[DONE]") {
      events.push({ field, done: true });
      return;
    }
    try {
      events.push({ field, json: sanitizeValue(JSON.parse(rawValue) as unknown) });
    } catch {
      events.push({ field, text: REDACTED });
    }
    return;
  }
  events.push({ field, value: REDACTED });
}

export function sanitizeError(error: unknown): SanitizedError {
  const name = error instanceof Error ? error.name : "Error";
  return { name, message: REDACTED };
}

export function isSensitiveKey(key: string): boolean {
  return /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i.test(key) || /(token|secret|password|credential|api[_-]?key|session)/i.test(key);
}
