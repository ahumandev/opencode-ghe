import type { CredentialResolution, CredentialResolver, GheModelProfile, GheProtocolConfig } from "./ghe-protocol.ts";
import { CopilotTokenResolver } from "./ghe-protocol.ts";

export interface GheEnvCredential {
  readonly source: "env";
  readonly name: string;
}

export interface GheGitHubOAuthCredential {
  readonly source: "github-oauth";
  readonly name: string;
  readonly tokenEndpoint: string;
}

export interface GheOpenCodeAuthCredential {
  readonly source: "opencode-auth";
}

export type GheCredential = GheEnvCredential | GheGitHubOAuthCredential | GheOpenCodeAuthCredential;

export interface GhePluginConfig {
  readonly baseUrl: string;
  readonly credential: GheCredential;
  readonly oauthTokenLoader?: () => Promise<string | undefined>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly profiles?: Readonly<Record<string, GheModelProfile>>;
  readonly timeoutMs?: number;
  readonly systemRole?: "system" | "assistant";
}

export class GhePluginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhePluginConfigError";
  }
}

const TOP_LEVEL_FIELDS = new Set(["baseUrl", "credential", "oauthTokenLoader", "headers", "profiles", "timeoutMs", "systemRole"]);
const ENV_CREDENTIAL_FIELDS = new Set(["source", "name"]);
const OAUTH_CREDENTIAL_FIELDS = new Set(["source", "name", "tokenEndpoint"]);
const OPENCODE_AUTH_CREDENTIAL_FIELDS = new Set(["source"]);
const PROFILE_FIELDS = new Set(["id", "wireModel", "endpoint", "reasoningBudget", "systemRole"]);
const ENV_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OAUTH_TOKEN_ENDPOINT = "https://api.bmw.ghe.com/copilot_internal/v2/token";
const OPENCODE_AUTH_LOGIN_COMMAND = 'opencode auth login --provider ghe --method "BMW Copilot device login"';

export function parseGhePluginOptions(options: Readonly<Record<string, unknown>>): GhePluginConfig {
  rejectUnknownFields(options, TOP_LEVEL_FIELDS, "plugin option");

  const baseUrl = parseBaseUrl(options.baseUrl);
  const credential = parseCredential(options.credential);
  const oauthTokenLoader = options.oauthTokenLoader === undefined ? undefined : parseOAuthTokenLoader(options.oauthTokenLoader);
  const headers = options.headers === undefined ? undefined : parseHeaders(options.headers);
  const profiles = options.profiles === undefined ? undefined : parseProfiles(options.profiles);
  const timeoutMs = options.timeoutMs === undefined ? undefined : parsePositiveInteger(options.timeoutMs, "timeoutMs");
  const systemRole = options.systemRole === undefined ? undefined : parseSystemRole(options.systemRole, "systemRole");

  return {
    baseUrl,
    credential,
    ...(oauthTokenLoader === undefined ? {} : { oauthTokenLoader }),
    ...(headers === undefined ? {} : { headers }),
    ...(profiles === undefined ? {} : { profiles }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(systemRole === undefined ? {} : { systemRole }),
  };
}

export function createAdapterConfig(
  config: GhePluginConfig,
  env?: Readonly<Record<string, string | undefined>>,
): GheProtocolConfig {
  let fallbackResolver: CredentialResolver | undefined;
  if (config.credential.source === "env") {
    fallbackResolver = credentialResolver(config.baseUrl, config.credential, env ?? getProcessEnvironment());
  } else if (config.credential.source === "github-oauth") {
    fallbackResolver = credentialResolver(config.baseUrl, config.credential, env);
  }
  const credential = config.oauthTokenLoader === undefined && fallbackResolver !== undefined
    ? fallbackResolver
    : new CopilotTokenResolver({
      baseUrl: config.baseUrl,
      tokenEndpoint: config.credential.source === "github-oauth" ? config.credential.tokenEndpoint : OAUTH_TOKEN_ENDPOINT,
      ...(config.oauthTokenLoader === undefined ? {} : { oauthTokenLoader: config.oauthTokenLoader }),
      ...(fallbackResolver === undefined ? {} : { fallbackCredentialResolver: fallbackResolver }),
      ...(config.credential.source === "opencode-auth"
        ? { missingCredentialMessage: OPENCODE_AUTH_LOGIN_COMMAND }
        : {}),
    });

  return {
    baseUrl: config.baseUrl,
    copilotHeaders: config.headers ?? {},
    credentialResolver: credential,
    ...(config.profiles === undefined ? {} : { modelProfiles: config.profiles }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.systemRole === undefined ? {} : { systemRole: config.systemRole }),
  };
}

function parseBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GhePluginConfigError("baseUrl must be a non-empty absolute HTTP(S) URL.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GhePluginConfigError("baseUrl must be a non-empty absolute HTTP(S) URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname.length === 0) {
    throw new GhePluginConfigError("baseUrl must be a non-empty absolute HTTP(S) URL.");
  }
  return value;
}

function parseOAuthTokenLoader(value: unknown): () => Promise<string | undefined> {
  if (typeof value !== "function") throw new GhePluginConfigError("oauthTokenLoader must be a function.");
  return value as () => Promise<string | undefined>;
}

function parseCredential(value: unknown): GheCredential {
  if (value === undefined) return { source: "opencode-auth" };
  const credential = asRecord(value, "credential must be an object.");
  if (credential.source === "env") {
    rejectUnknownFields(credential, ENV_CREDENTIAL_FIELDS, "credential option");
    return { source: "env", name: credentialName(credential) };
  }
  if (credential.source === "opencode-auth") {
    rejectUnknownFields(credential, OPENCODE_AUTH_CREDENTIAL_FIELDS, "credential option");
    return { source: "opencode-auth" };
  }
  if (credential.source !== "github-oauth") throw new GhePluginConfigError('credential.source must be "env", "github-oauth", or "opencode-auth".');
  rejectUnknownFields(credential, OAUTH_CREDENTIAL_FIELDS, "credential option");
  const name = credentialName(credential);
  const tokenEndpoint = parseUrl(credential.tokenEndpoint, "credential.tokenEndpoint");
  return { source: "github-oauth", name, tokenEndpoint };
}

function credentialName(credential: Readonly<Record<string, unknown>>): string {
  if (typeof credential.name !== "string" || !ENV_IDENTIFIER.test(credential.name)) {
    throw new GhePluginConfigError("credential.name must be a portable environment identifier.");
  }
  return credential.name;
}

function parseHeaders(value: unknown): Readonly<Record<string, string>> {
  const headers = asRecord(value, "headers must be a record.");
  const entries: Array<readonly [string, string]> = [];
  for (const [name, headerValue] of Object.entries(headers)) {
    if (name.trim().length === 0 || typeof headerValue !== "string") {
      throw new GhePluginConfigError("headers must contain non-empty names with string values.");
    }
    entries.push([name, headerValue]);
  }
  return Object.fromEntries(entries);
}

function parseProfiles(value: unknown): Readonly<Record<string, GheModelProfile>> {
  const profiles = asRecord(value, "profiles must be a record.");
  const entries: Array<readonly [string, GheModelProfile]> = [];
  for (const [id, profileValue] of Object.entries(profiles)) {
    const profile = asRecord(profileValue, "Each profile must be an object.");
    rejectUnknownFields(profile, PROFILE_FIELDS, "profile field");
    if (profile.id !== id) throw new GhePluginConfigError("Each profile key must match profile.id.");
    if (typeof profile.wireModel !== "string" || profile.wireModel.trim().length === 0) {
      throw new GhePluginConfigError("profile.wireModel must be non-empty.");
    }
    if (profile.endpoint !== "chat" && profile.endpoint !== "responses") {
      throw new GhePluginConfigError('profile.endpoint must be "chat" or "responses".');
    }
    const reasoningBudget = profile.reasoningBudget === undefined
      ? undefined
      : parsePositiveInteger(profile.reasoningBudget, "profile.reasoningBudget");
    const systemRole = profile.systemRole === undefined ? undefined : parseSystemRole(profile.systemRole, "profile.systemRole");
    entries.push([
      id,
      {
        id,
        wireModel: profile.wireModel,
        endpoint: profile.endpoint,
        ...(reasoningBudget === undefined ? {} : { reasoningBudget }),
        ...(systemRole === undefined ? {} : { systemRole }),
      },
    ]);
  }
  return Object.fromEntries(entries);
}

function parseSystemRole(value: unknown, field: string): "system" | "assistant" {
  if (value !== "system" && value !== "assistant") throw new GhePluginConfigError(`${field} must be "system" or "assistant".`);
  return value;
}

function parseUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new GhePluginConfigError(`${field} must be a non-empty absolute HTTP(S) URL.`);
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname.length === 0) throw new Error();
  } catch {
    throw new GhePluginConfigError(`${field} must be a non-empty absolute HTTP(S) URL.`);
  }
  return value;
}

function credentialResolver(
  baseUrl: string,
  credential: Exclude<GheCredential, GheOpenCodeAuthCredential>,
  env?: Readonly<Record<string, string | undefined>>,
): CredentialResolver {
  if (credential.source === "env") {
    const environment = env ?? getProcessEnvironment();
    return {
      resolve(): string {
        const value = credentialValue(credential.name, environment);
        return value;
      },
    };
  }
  let resolver: CopilotTokenResolver | undefined;
  return {
    resolve(fetcher?: typeof fetch): Promise<CredentialResolution> {
      if (resolver === undefined) {
        resolver = new CopilotTokenResolver({
          baseUrl,
          tokenEndpoint: credential.tokenEndpoint,
          oauthToken: credentialValue(credential.name, env ?? getProcessEnvironment()),
        });
      }
      return resolver.resolve(fetcher);
    },
  };
}

function credentialValue(name: string, env: Readonly<Record<string, string | undefined>>): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) throw new GhePluginConfigError("Credential environment value is missing or empty.");
  return value;
}

function parsePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new GhePluginConfigError(`${field} must be a positive finite integer.`);
  }
  return value;
}

function asRecord(value: unknown, message: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GhePluginConfigError(message);
  return value as Readonly<Record<string, unknown>>;
}

function rejectUnknownFields(value: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>, label: string): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new GhePluginConfigError(`Unknown ${label}: ${field}.`);
  }
}

function getProcessEnvironment(): Readonly<Record<string, string | undefined>> {
  return (globalThis as { readonly process?: { readonly env: Record<string, string | undefined> } }).process?.env ?? {};
}
