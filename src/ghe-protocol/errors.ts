export class GheProtocolError extends Error {
  readonly code: string;
  readonly requestId?: string;
  readonly status?: number;

  constructor(code: string, message: string, details: { requestId?: string; status?: number } = {}) {
    super(message);
    this.name = "GheProtocolError";
    this.code = code;
    if (details.requestId !== undefined) this.requestId = details.requestId;
    if (details.status !== undefined) this.status = details.status;
  }
}

export class ConfigurationError extends GheProtocolError {
  constructor(message: string) { super("CONFIGURATION_ERROR", message); this.name = "ConfigurationError"; }
}
export class AuthenticationError extends GheProtocolError {
  constructor(requestId?: string, status?: number) { super("AUTHENTICATION_ERROR", `Authentication failed${status === undefined ? "" : ` (status ${status})`}${requestId === undefined ? "" : `; request ${requestId}`}.`, details(requestId, status)); this.name = "AuthenticationError"; }
}
export class NetworkError extends GheProtocolError {
  constructor(requestId: string) { super("NETWORK_ERROR", `Network request failed; request ${requestId}.`, details(requestId)); this.name = "NetworkError"; }
}
export interface HttpErrorDetails {
  readonly contentType?: string;
  readonly providerRequestId?: string;
  readonly providerCode?: string;
  readonly providerMessage?: string;
}
export class HttpError extends GheProtocolError {
  declare readonly contentType?: string;
  declare readonly providerRequestId?: string;
  declare readonly providerCode?: string;
  declare readonly providerMessage?: string;

  constructor(status: number, requestId: string, errorDetails: HttpErrorDetails = {}) {
    super("HTTP_ERROR", httpMessage(status, requestId, errorDetails), details(requestId, status));
    this.name = "HttpError";
    if (errorDetails.contentType !== undefined) this.contentType = errorDetails.contentType;
    if (errorDetails.providerRequestId !== undefined) this.providerRequestId = errorDetails.providerRequestId;
    if (errorDetails.providerCode !== undefined) this.providerCode = errorDetails.providerCode;
    if (errorDetails.providerMessage !== undefined) this.providerMessage = errorDetails.providerMessage;
  }
}
export class MalformedResponseError extends GheProtocolError {
  constructor(requestId: string) { super("MALFORMED_RESPONSE", `Provider returned a malformed response; request ${requestId}.`, details(requestId)); this.name = "MalformedResponseError"; }
}
export class StreamTerminationError extends GheProtocolError {
  constructor(requestId: string) { super("STREAM_TERMINATION", `Stream ended before completion; request ${requestId}.`, details(requestId)); this.name = "StreamTerminationError"; }
}
export class UnsupportedOptionError extends GheProtocolError {
  constructor(option: string) { super("UNSUPPORTED_OPTION", `Unsupported request option: ${option}.`); this.name = "UnsupportedOptionError"; }
}

function details(requestId?: string, status?: number): { requestId?: string; status?: number } {
  return { ...(requestId === undefined ? {} : { requestId }), ...(status === undefined ? {} : { status }) };
}

function httpMessage(status: number, requestId: string, errorDetails: HttpErrorDetails): string {
  const evidence = [
    errorDetails.providerRequestId === undefined ? undefined : `provider request ${errorDetails.providerRequestId}`,
    errorDetails.providerCode === undefined ? undefined : `provider code ${errorDetails.providerCode}`,
    errorDetails.providerMessage === undefined ? undefined : `provider message ${errorDetails.providerMessage}`,
  ].filter((value): value is string => value !== undefined);
  return `HTTP request failed (status ${status}); request ${requestId}${evidence.length === 0 ? "" : `; ${evidence.join("; ")}`}.`;
}
