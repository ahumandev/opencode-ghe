import type { GheModelProfile } from "./types.ts";

export const BUILT_IN_MODEL_PROFILES: Readonly<Record<string, GheModelProfile>> = Object.freeze({
  "claude-haiku-4.5": Object.freeze({ id: "claude-haiku-4.5", wireModel: "claude-haiku-4.5", endpoint: "chat", reasoningBudget: 16000 }),
  "claude-sonnet-5": Object.freeze({ id: "claude-sonnet-5", wireModel: "claude-sonnet-5", endpoint: "chat", reasoningBudget: 16000 }),
  "claude-opus-4.8": Object.freeze({ id: "claude-opus-4.8", wireModel: "claude-opus-4.8", endpoint: "chat", reasoningBudget: 16000 }),
  "gpt-5-mini": Object.freeze({ id: "gpt-5-mini", wireModel: "gpt-5-mini", endpoint: "chat", reasoningBudget: 16000 }),
  "gpt-5.4-mini": Object.freeze({ id: "gpt-5.4-mini", wireModel: "gpt-5.4-mini", endpoint: "chat", reasoningBudget: 16000 }),
  "gpt-5.6-terra": Object.freeze({ id: "gpt-5.6-terra", wireModel: "gpt-5.6-terra", endpoint: "responses", systemRole: "system" }),
  "gpt-5.6-luna": Object.freeze({ id: "gpt-5.6-luna", wireModel: "gpt-5.6-luna", endpoint: "responses", systemRole: "system" }),
});

const LEGACY_MODEL_PREFIX = "github_copilot/";

export function normalizeBuiltInModelID(modelID: string): string {
  if (!modelID.startsWith(LEGACY_MODEL_PREFIX)) return modelID;
  const canonicalID = modelID.slice(LEGACY_MODEL_PREFIX.length);
  return Object.hasOwn(BUILT_IN_MODEL_PROFILES, canonicalID) ? canonicalID : modelID;
}

export function normalizeBuiltInModelProfiles(
  profiles: Readonly<Record<string, GheModelProfile>> | undefined,
): Readonly<Record<string, GheModelProfile>> | undefined {
  if (profiles === undefined) return undefined;
  const normalizedProfiles: Record<string, GheModelProfile> = {};
  for (const [modelID, profile] of Object.entries(profiles)) {
    if (normalizeBuiltInModelID(modelID) === modelID) normalizedProfiles[modelID] = profile;
  }
  for (const [modelID, profile] of Object.entries(profiles)) {
    const canonicalID = normalizeBuiltInModelID(modelID);
    if (canonicalID !== modelID && !Object.hasOwn(profiles, canonicalID)) normalizedProfiles[canonicalID] = profile;
  }
  return normalizedProfiles;
}
