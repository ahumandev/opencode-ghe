import { AuthenticationError } from "./errors.ts";
import { CopilotTokenExchangeError } from "./copilot-token-resolver.ts";
import type { CredentialResolution, GheProtocolConfig } from "./types.ts";

export async function resolveCredential(config: GheProtocolConfig, requestId: string, fetcher: typeof fetch): Promise<CredentialResolution> {
  let value: string | CredentialResolution | undefined;
  try {
    value = config.credentialResolver === undefined ? config.credential : await config.credentialResolver.resolve(fetcher);
  } catch (error: unknown) {
    if (error instanceof CopilotTokenExchangeError) throw error;
    throw new AuthenticationError(requestId);
  }
  if (typeof value === "string") {
    if (value.trim() === "") throw new AuthenticationError(requestId);
    return { token: value };
  }
  if (value === undefined || typeof value.token !== "string" || value.token.trim() === "") throw new AuthenticationError(requestId);
  return value;
}
