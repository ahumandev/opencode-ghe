export type EndpointKind = "chat" | "responses";

export interface GheModelProfile {
  readonly id: string;
  readonly wireModel: string;
  readonly endpoint: EndpointKind;
  readonly reasoningBudget?: number;
  readonly systemRole?: SystemRoleMode;
}

export type SystemRoleMode = "system" | "assistant";

export interface CredentialResolution {
  readonly token: string;
  readonly apiEndpoint?: string;
}

export interface CredentialResolver {
  resolve(fetcher?: typeof globalThis.fetch): Promise<string | CredentialResolution> | string | CredentialResolution;
}

export interface GheProtocolConfig {
  readonly baseUrl: string;
  readonly copilotHeaders: Readonly<Record<string, string>>;
  readonly credential?: string;
  readonly credentialResolver?: CredentialResolver;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestIdFactory?: () => string;
  readonly timeoutMs?: number;
  readonly modelProfiles?: Readonly<Record<string, GheModelProfile>>;
  readonly systemRole?: SystemRoleMode;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface GheMessage {
  readonly role: MessageRole;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
}

export interface GheTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: Record<string, unknown>;
  };
}

export interface GheRequestOptions {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly stopSequences?: readonly string[];
}

export interface GheRequest {
  readonly model: string;
  readonly messages: readonly GheMessage[];
  readonly tools?: readonly GheTool[];
  readonly toolChoice?: unknown;
  readonly options?: GheRequestOptions;
}

export interface NormalizedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export type FinishReason = "stop" | "length" | "tool-calls" | "content-filter" | "error" | "unknown";

export interface NormalizedUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly reasoningTokens?: number;
}

export interface NormalizedResponse {
  readonly requestId: string;
  readonly providerRequestId?: string;
  readonly model?: string;
  readonly text: string;
  readonly reasoning: string;
  readonly toolCalls: readonly NormalizedToolCall[];
  readonly finishReason: FinishReason;
  readonly usage: NormalizedUsage;
}

export type NormalizedStreamEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly reasoning: string }
  | { readonly type: "tool-call-delta"; readonly id: string; readonly name?: string; readonly arguments: string }
  | { readonly type: "tool-call"; readonly toolCall: NormalizedToolCall }
  | { readonly type: "finish"; readonly finishReason: FinishReason }
  | { readonly type: "usage"; readonly usage: NormalizedUsage };

export interface GheProtocolAdapter {
  complete(request: GheRequest, abortSignal?: AbortSignal): Promise<NormalizedResponse>;
  stream(request: GheRequest, abortSignal?: AbortSignal): AsyncIterable<NormalizedStreamEvent>;
}
