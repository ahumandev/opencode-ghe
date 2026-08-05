import { BUILT_IN_MODEL_PROFILES, normalizeBuiltInModelProfiles } from "./config.ts";
import { resolveCredential } from "./credentials.ts";
import { AuthenticationError, HttpError, MalformedResponseError, NetworkError } from "./errors.ts";
import { normalizeResponse } from "./normalize.ts";
import { buildBody, selectProfile, validateConfig, validateRequest } from "./request.ts";
import { parseStream } from "./sse.ts";
import type { GheProtocolAdapter, GheProtocolConfig, GheRequest, NormalizedResponse, NormalizedStreamEvent } from "./types.ts";
import { joinUrlPath } from "../url.ts";

const MAX_PROVIDER_ERROR_BODY_BYTES = 8192;
const MAX_PROVIDER_ERROR_VALUE_LENGTH = 512;

export function createGheProtocolAdapter(config: GheProtocolConfig): GheProtocolAdapter {
  validateConfig(config);
  const configuredProfiles = normalizeBuiltInModelProfiles(config.modelProfiles);
  const resolvedConfig: GheProtocolConfig = { ...config, modelProfiles: { ...BUILT_IN_MODEL_PROFILES, ...configuredProfiles } };
  const fetcher = config.fetch ?? globalThis.fetch;
  return {
    async complete(request: GheRequest, abortSignal?: AbortSignal): Promise<NormalizedResponse> {
      const operation = await prepare(resolvedConfig, fetcher, request, false, abortSignal);
      try {
        const payload = await readJson(operation.response, operation.requestId);
        throwIfAborted(abortSignal);
        return normalizeResponse(payload, operation.endpoint, operation.requestId, operation.response.headers);
      } catch (error: unknown) {
        if (abortSignal?.aborted) throw abortedError();
        throw error;
      } finally { operation.cleanup(); }
    },
    async *stream(request: GheRequest, abortSignal?: AbortSignal): AsyncGenerator<NormalizedStreamEvent> {
      const operation = await prepare(resolvedConfig, fetcher, request, true, abortSignal);
      try {
        yield* parseStream(operation.response.body, operation.endpoint, operation.requestId);
        throwIfAborted(abortSignal);
      } catch (error: unknown) {
        if (abortSignal?.aborted) throw abortedError();
        throw error;
      }
      finally { operation.cleanup(); }
    },
  };
}

interface PreparedRequest {
  readonly requestId: string;
  readonly endpoint: "chat" | "responses";
  readonly response: Response;
  cleanup(): void;
}

async function prepare(config: GheProtocolConfig, fetcher: typeof fetch, request: GheRequest, stream: boolean, abortSignal: AbortSignal | undefined): Promise<PreparedRequest> {
  validateRequest(request);
  const profile = selectProfile(config, request.model);
  const requestId = config.requestIdFactory?.() || crypto.randomUUID();
  const credential = await resolveCredential(config, requestId, fetcher);
  const baseUrl = credential.apiEndpoint ?? config.baseUrl;
  const url = new URL(joinUrlPath(baseUrl, profile.endpoint === "chat" ? "chat/completions" : "responses"));
  const initiator = request.messages.at(-1)?.role === "user" ? "user" : "agent";
  const headers: Record<string, string> = {
    ...config.copilotHeaders,
    "copilot-integration-id": "vscode-chat",
    "editor-version": "vscode/1.95.0",
    "editor-plugin-version": "copilot-chat/0.26.7",
    "user-agent": "GitHubCopilotChat/0.26.7",
    "openai-intent": "conversation-panel",
    "x-github-api-version": "2025-04-01",
    "x-request-id": requestId,
    "x-vscode-user-agent-library-version": "electron-fetch",
    "X-Initiator": initiator,
    "content-type": "application/json",
    Authorization: `Bearer ${credential.token}`,
  };
  const operation = await fetchWithTimeout(fetcher, url, headers, buildBody(profile, request, stream, profile.systemRole ?? config.systemRole ?? "assistant"), config.timeoutMs, requestId, abortSignal);
  return { requestId, endpoint: profile.endpoint, ...operation };
}
async function fetchWithTimeout(fetcher: typeof fetch, url: URL, headers: Record<string, string>, body: Record<string, unknown>, timeoutMs: number | undefined, requestId: string, abortSignal: AbortSignal | undefined): Promise<{ response: Response; cleanup(): void }> {
  const abort = composeAbortSignal(abortSignal, timeoutMs);
  let failed = true;
  try {
    const response = await fetcher(url, { method: "POST", headers, body: JSON.stringify(body), signal: abort.signal });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new AuthenticationError(requestId, response.status);
      throw new HttpError(response.status, requestId, await safeHttpErrorDetails(response));
    }
    failed = false;
    return { response, cleanup: abort.cleanup };
  } catch (error: unknown) {
    if (error instanceof AuthenticationError || error instanceof HttpError) throw error;
    if (!abort.timedOut() && abortSignal?.aborted) throw abortedError();
    throw new NetworkError(requestId);
  } finally {
    if (failed) abort.cleanup();
  }
}

interface ComposedAbortSignal {
  readonly signal: AbortSignal;
  cleanup(): void;
  timedOut(): boolean;
}

function composeAbortSignal(callerSignal: AbortSignal | undefined, timeoutMs: number | undefined): ComposedAbortSignal {
  const controller = new AbortController();
  let timeoutElapsed = false;
  const abortForCaller = (): void => controller.abort();
  if (callerSignal?.aborted) abortForCaller();
  else callerSignal?.addEventListener("abort", abortForCaller, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout((): void => {
    timeoutElapsed = true;
    controller.abort();
  }, timeoutMs);
  let cleaned = false;
  return {
    signal: controller.signal,
    cleanup: (): void => {
      if (cleaned) return;
      cleaned = true;
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortForCaller);
    },
    timedOut: (): boolean => timeoutElapsed,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError();
}

function abortedError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}
async function readJson(response: Response, requestId: string): Promise<unknown> {
  try { return await response.json() as unknown; } catch { throw new MalformedResponseError(requestId); }
}

async function safeHttpErrorDetails(response: Response): Promise<{ contentType?: string; providerRequestId?: string; providerCode?: string; providerMessage?: string }> {
  try {
    const contentType = normalizeContentType(response.headers.get("content-type"));
    const providerRequestId = safeProviderRequestId(response.headers.get("x-github-request-id") ?? response.headers.get("x-request-id"));
    if (!isJsonContentType(contentType)) return { ...(contentType === undefined ? {} : { contentType }), ...(providerRequestId === undefined ? {} : { providerRequestId }) };
    const payload = await boundedJson(response);
    const providerError = providerErrorFields(payload);
    return {
      ...(contentType === undefined ? {} : { contentType }),
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      ...providerError,
    };
  } catch {
    return {};
  }
}

function normalizeContentType(value: string | null): string | undefined {
  if (value === null) return undefined;
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase();
  return normalized !== undefined && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized) ? normalized : undefined;
}

function isJsonContentType(contentType: string | undefined): boolean {
  return contentType === "application/json" || contentType?.endsWith("+json") === true;
}

function safeProviderRequestId(value: string | null): string | undefined {
  if (value === null || value.length === 0 || value.length > MAX_PROVIDER_ERROR_VALUE_LENGTH) return undefined;
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : undefined;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength > MAX_PROVIDER_ERROR_BODY_BYTES - length) return undefined;
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    await reader.cancel().catch((): undefined => undefined);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { return undefined; }
}

function providerErrorFields(value: unknown): { providerCode?: string; providerMessage?: string } {
  const root = record(value);
  const source = record(root?.error) ?? root;
  const providerCode = safeProviderCode(source?.code);
  const providerMessage = safeProviderMessage(source?.message);
  return { ...(providerCode === undefined ? {} : { providerCode }), ...(providerMessage === undefined ? {} : { providerMessage }) };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeProviderCode(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PROVIDER_ERROR_VALUE_LENGTH && /^[A-Za-z0-9._-]+$/.test(value) ? value : undefined;
}

function safeProviderMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const redacted = value.replace(/\b(?:authorization\s*(?:=|:)\s*(?:bearer\s+)?(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;]+)|bearer\s+(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;]+)|(?:token|secret|cookie|api[_ -]?key|password)\s*(?:=|:)\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;]+))/gi, "[REDACTED]").replace(/\s+/g, " ").trim();
  return redacted.length === 0 ? undefined : redacted.slice(0, MAX_PROVIDER_ERROR_VALUE_LENGTH);
}
