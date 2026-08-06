export { createGheProtocolAdapter } from "./ghe-protocol/adapter.ts";
export { CopilotTokenExchangeError, CopilotTokenResolver } from "./ghe-protocol/copilot-token-resolver.ts";
export type { CopilotTokenResolverOptions } from "./ghe-protocol/copilot-token-resolver.ts";
export { BUILT_IN_MODEL_PROFILES } from "./ghe-protocol/config.ts";
export { AuthenticationError, ConfigurationError, GheProtocolError, HttpError, InvalidRequestError, MalformedResponseError, NetworkError, StreamTerminationError, UnsupportedOptionError } from "./ghe-protocol/errors.ts";
export type { CredentialResolution, CredentialResolver, EndpointKind, FinishReason, GheAssistantToolCall, GheMessage, GheModelProfile, GheProtocolAdapter, GheProtocolConfig, GheRequest, GheRequestOptions, GheTool, NormalizedResponse, NormalizedStreamEvent, NormalizedToolCall, NormalizedUsage, SystemRoleMode } from "./ghe-protocol/types.ts";
