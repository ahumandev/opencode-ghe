import { BUILT_IN_MODEL_PROFILES, normalizeBuiltInModelProfiles } from "./ghe-protocol/config.ts";
import type { GheModelProfile } from "./ghe-protocol/types.ts";

export const GHE_PROVIDER_ID = "ghe";
export const GHE_AI_SDK_PACKAGE = "opencode-ghe";

const GHE_CATALOG_MODEL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "claude-haiku-4.5": "Claude Haiku 4.5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-opus-4.8": "Claude Opus 4.8",
  "gpt-5-mini": "GPT 5 Mini",
  "gpt-5.4-mini": "GPT 5.4 Mini",
  "gpt-5.6-terra": "GPT 5.6 Terra",
  "gpt-5.6-luna": "GPT 5.6 Luna",
});

export interface GheCatalogApi {
  readonly type: "aisdk";
  readonly package: string;
  readonly id?: string;
}

export interface GheCatalogCapabilities {
  readonly toolcall: true;
  readonly input: Readonly<{ text: true }>;
  readonly output: Readonly<{ text: true }>;
}

export interface GheCatalogProvider {
  readonly name: string;
  readonly active: true;
  readonly enabled: true;
  readonly api: GheCatalogApi;
}

export interface GheCatalogModel {
  readonly name: string;
  readonly active: true;
  readonly enabled: true;
  readonly api: Required<GheCatalogApi>;
  readonly capabilities: GheCatalogCapabilities;
}

export interface GheCatalogDraft {
  readonly provider: {
    update(id: string, provider: GheCatalogProvider): Promise<unknown>;
  };
  readonly model: {
    update(providerID: string, modelID: string, model: GheCatalogModel): Promise<unknown>;
  };
}

export type GheCatalogTransform = (draft: GheCatalogDraft) => Promise<void>;

export const GHE_CATALOG_METADATA: Readonly<{
  provider: Readonly<{ id: typeof GHE_PROVIDER_ID; name: string }>;
  profileIDs: readonly string[];
}> = Object.freeze({
  provider: Object.freeze({ id: GHE_PROVIDER_ID, name: "GitHub Enterprise" }),
  profileIDs: Object.freeze(Object.keys(BUILT_IN_MODEL_PROFILES)),
});

export function getGheCatalogModelName(profileID: string): string {
  return GHE_CATALOG_MODEL_NAMES[profileID] ?? "GitHub Copilot";
}

export async function registerGheCatalog(
  draft: GheCatalogDraft,
  configuredProfiles: Readonly<Record<string, GheModelProfile>> = {},
): Promise<void> {
  await draft.provider.update(GHE_PROVIDER_ID, {
    name: GHE_CATALOG_METADATA.provider.name,
    active: true,
    enabled: true,
    api: {
      type: "aisdk",
      package: GHE_AI_SDK_PACKAGE,
    },
  });

  const normalizedConfiguredProfiles: Readonly<Record<string, GheModelProfile>> = normalizeBuiltInModelProfiles(configuredProfiles) ?? {};
  const profiles: Readonly<Record<string, GheModelProfile>> = {
    ...BUILT_IN_MODEL_PROFILES,
    ...normalizedConfiguredProfiles,
  };

  for (const profileID of Object.keys(profiles)) {
    await draft.model.update(GHE_PROVIDER_ID, profileID, {
      name: getGheCatalogModelName(profileID),
      active: true,
      enabled: true,
      api: {
        type: "aisdk",
        package: GHE_AI_SDK_PACKAGE,
        id: profileID,
      },
      capabilities: {
        toolcall: true,
        input: { text: true },
        output: { text: true },
      },
    });
  }
}
