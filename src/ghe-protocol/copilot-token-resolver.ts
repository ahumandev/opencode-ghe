import type { CredentialResolution, CredentialResolver } from "./types.ts";

const EXPIRY_SAFETY_MS = 30_000;

export interface CopilotTokenResolverOptions {
  readonly baseUrl: string;
  readonly tokenEndpoint: string;
  readonly oauthToken?: string;
  readonly oauthTokenLoader?: () => Promise<string | undefined>;
  readonly fallbackCredentialResolver?: CredentialResolver;
  readonly missingCredentialMessage?: string;
}

export class CopilotTokenExchangeError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly requestId?: string;

  constructor(code: string, message: string, details: { readonly status?: number; readonly requestId?: string } = {}) {
    super(message);
    this.name = "CopilotTokenExchangeError";
    this.code = code;
    if (details.status !== undefined) this.status = details.status;
    if (details.requestId !== undefined) this.requestId = details.requestId;
  }
}

interface CachedToken {
  readonly resolution: CredentialResolution;
  readonly sourceToken: string;
  readonly refreshAt: number;
}

export class CopilotTokenResolver {
  private cached?: CachedToken;
  private inFlight: { readonly sourceToken: string; readonly exchange: Promise<CredentialResolution> } | undefined;

  constructor(private readonly options: CopilotTokenResolverOptions) {}

  async resolve(fetcher: typeof fetch = globalThis.fetch): Promise<CredentialResolution> {
    const sourceToken = await this.resolveSourceToken();
    if (sourceToken === undefined) return this.resolveFallbackCredential(fetcher);
    if (this.cached !== undefined && this.cached.sourceToken === sourceToken && Date.now() < this.cached.refreshAt) return this.cached.resolution;
    if (this.inFlight !== undefined && this.inFlight.sourceToken === sourceToken) return this.inFlight.exchange;
    const exchange = this.exchange(fetcher, sourceToken);
    this.inFlight = { sourceToken, exchange };
    void exchange.then(
      (): void => {
        if (this.inFlight?.exchange === exchange) this.inFlight = undefined;
      },
      (): void => {
        if (this.inFlight?.exchange === exchange) this.inFlight = undefined;
      },
    );
    return exchange;
  }

  private async resolveSourceToken(): Promise<string | undefined> {
    let loadedToken: string | undefined;
    try {
      loadedToken = await this.options.oauthTokenLoader?.();
    } catch {
      throw this.unavailableCredentialError();
    }
    return usableToken(loadedToken) ?? usableToken(this.options.oauthToken);
  }

  private async resolveFallbackCredential(fetcher: typeof fetch): Promise<CredentialResolution> {
    if (this.options.fallbackCredentialResolver === undefined) {
      throw this.unavailableCredentialError();
    }
    let credential: string | CredentialResolution;
    try {
      credential = await this.options.fallbackCredentialResolver.resolve(fetcher);
    } catch {
      throw new CopilotTokenExchangeError("TOKEN_EXCHANGE_CREDENTIAL", "Copilot OAuth token is unavailable.");
    }
    const resolved = typeof credential === "string" ? { token: credential } : credential;
    const token = usableToken(resolved.token);
    if (token === undefined) throw new CopilotTokenExchangeError("TOKEN_EXCHANGE_CREDENTIAL", "Copilot OAuth token is unavailable.");
    return { token, ...(resolved.apiEndpoint === undefined ? {} : { apiEndpoint: resolved.apiEndpoint }) };
  }

  private unavailableCredentialError(): CopilotTokenExchangeError {
    return new CopilotTokenExchangeError(
      "TOKEN_EXCHANGE_CREDENTIAL",
      this.options.missingCredentialMessage ?? "Copilot OAuth token is unavailable.",
    );
  }

  private async exchange(fetcher: typeof fetch, sourceToken: string): Promise<CredentialResolution> {
    let response: Response;
    try {
      response = await fetcher(this.options.tokenEndpoint, {
        method: "GET",
        headers: {
          authorization: `token ${sourceToken}`,
          accept: "application/json",
          "content-type": "application/json",
          "editor-version": "vscode/1.85.1",
          "editor-plugin-version": "copilot/1.155.0",
          "user-agent": "GithubCopilot/1.155.0",
          "accept-encoding": "gzip,deflate,br",
        },
      });
    } catch {
      throw new CopilotTokenExchangeError("TOKEN_EXCHANGE_NETWORK", "Copilot token exchange failed.");
    }
    if (!response.ok) throw new CopilotTokenExchangeError("TOKEN_EXCHANGE_HTTP", "Copilot token exchange was rejected.", exchangeDetails(response));
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new CopilotTokenExchangeError("TOKEN_EXCHANGE_PARSE", "Copilot token exchange returned invalid JSON."); }
    const now = Date.now();
    const parsed = parseExchangePayload(payload, now, this.options.baseUrl, this.options.tokenEndpoint);
    const refreshAt = refreshAtFor(parsed, now);
    const resolution: CredentialResolution = { token: parsed.token, ...(parsed.apiEndpoint === undefined ? {} : { apiEndpoint: parsed.apiEndpoint }) };
    const cached: CachedToken = { resolution, sourceToken, refreshAt };
    this.cached = cached;
    return resolution;
  }
}

interface ParsedExchangePayload {
  readonly token: string;
  readonly apiEndpoint?: string;
  readonly expiresAt: number;
  readonly refreshInMs?: number;
}

function parseExchangePayload(value: unknown, now: number, baseUrl: string, tokenEndpoint: string): ParsedExchangePayload {
  const payload = asRecord(value);
  const tokenValue = payload?.token;
  const token = typeof tokenValue === "string" ? usableToken(tokenValue) : undefined;
  const expiresAt = epochMilliseconds(payload?.expires_at);
  const refreshInMs = payload?.refresh_in === undefined ? undefined : refreshMilliseconds(payload.refresh_in, now);
  const apiEndpoint = apiEndpointFrom(payload?.endpoints, baseUrl, tokenEndpoint);
  if (token === undefined || expiresAt === undefined || expiresAt <= now || (payload?.refresh_in !== undefined && refreshInMs === undefined)) {
    throw new CopilotTokenExchangeError("TOKEN_EXCHANGE_SCHEMA", "Copilot token exchange returned invalid token metadata.");
  }
  return { token, expiresAt, ...(refreshInMs === undefined ? {} : { refreshInMs }), ...(apiEndpoint === undefined ? {} : { apiEndpoint }) };
}

function refreshAtFor(payload: ParsedExchangePayload, now: number): number {
  const expiryRefreshAt = Math.max(now, payload.expiresAt - EXPIRY_SAFETY_MS);
  return payload.refreshInMs === undefined ? expiryRefreshAt : Math.min(now + payload.refreshInMs, expiryRefreshAt);
}

function usableToken(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return token.length === 0 ? undefined : token;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function epochMilliseconds(value: unknown): number | undefined {
  const epoch = numeric(value);
  if (epoch === undefined) return undefined;
  if (Math.abs(epoch) < 1_000_000_000_000) {
    if (Math.abs(epoch) > Number.MAX_SAFE_INTEGER / 1000) return undefined;
    const milliseconds = epoch * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  return Number.isSafeInteger(epoch) ? epoch : undefined;
}

function refreshMilliseconds(value: unknown, now: number): number | undefined {
  const result = numeric(value);
  if (result === undefined || result <= 0 || !Number.isSafeInteger(now) || result > (Number.MAX_SAFE_INTEGER - now) / 1000) return undefined;
  const milliseconds = result * 1000;
  return Number.isSafeInteger(milliseconds) && Number.isSafeInteger(now + milliseconds) ? milliseconds : undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function apiEndpointFrom(value: unknown, baseUrl: string, tokenEndpoint: string): string | undefined {
  const api = asRecord(value)?.api;
  if (api === undefined) return undefined;
  if (typeof api !== "string" || api.trim().length === 0) throw new CopilotTokenExchangeError("TOKEN_EXCHANGE_SCHEMA", "Copilot token exchange returned invalid token metadata.");
  try {
    const endpoint = new URL(api);
    const trustedOrigins = new Set([new URL(baseUrl).origin, new URL(tokenEndpoint).origin]);
    if (endpoint.protocol !== "https:" || endpoint.username.length > 0 || endpoint.password.length > 0 || endpoint.search.length > 0 || endpoint.hash.length > 0 || !trustedOrigins.has(endpoint.origin)) throw new Error();
    return endpoint.toString().replace(/\/+$/, "");
  } catch {
    throw new CopilotTokenExchangeError("TOKEN_EXCHANGE_SCHEMA", "Copilot token exchange returned invalid token metadata.");
  }
}

function exchangeDetails(response: Response): { readonly status: number; readonly requestId?: string } {
  const value = response.headers.get("x-github-request-id") ?? response.headers.get("x-request-id");
  const requestId = value !== null && /^[A-Za-z0-9._-]{1,512}$/.test(value) ? value : undefined;
  return { status: response.status, ...(requestId === undefined ? {} : { requestId }) };
}
