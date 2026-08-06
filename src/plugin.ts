import type { LanguageModelV3 } from "@ai-sdk/provider";
import {
  define,
  type CatalogDraft,
  type Plugin as PromisePlugin,
  type PluginContext,
} from "@opencode-ai/plugin/v2/promise";
import type { Hooks, Plugin as RootPlugin, PluginModule } from "@opencode-ai/plugin";
import { createGheLanguageModel } from "./ai-sdk-bridge.ts";
import { createBmwDeviceOAuthMethod } from "./auth.ts";
import {
  GHE_AI_SDK_PACKAGE,
  GHE_CATALOG_METADATA,
  GHE_PROVIDER_ID,
  getGheCatalogModelName,
  registerGheCatalog,
  type GheCatalogDraft,
  type GheCatalogModel,
  type GheCatalogProvider,
} from "./catalog.ts";
import { createAdapterConfig, parseGhePluginOptions, type GheCredential } from "./config.ts";
import { normalizeBuiltInModelID } from "./ghe-protocol/config.ts";
import { createGheProtocolAdapter, type GheProtocolAdapter, type GheProtocolConfig } from "./ghe-protocol.ts";

export type GheAdapterFactory = (config: GheProtocolConfig) => GheProtocolAdapter;

export interface GhePluginDependencies {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly createAdapter?: GheAdapterFactory;
}

export interface GheOptions {
  readonly baseURL: string;
  readonly apiKey?: string;
  readonly oauthTokenLoader?: () => Promise<string | undefined>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly credentialEnv?: string;
  readonly credential?: GheCredential;
  readonly profiles?: Readonly<Record<string, import("./ghe-protocol.ts").GheModelProfile>>;
  readonly timeoutMs?: number;
  readonly systemRole?: "system" | "assistant";
  readonly name?: string;
}

export interface GheSdk {
  readonly languageModel: (modelId: string) => LanguageModelV3;
}

export type GhePromisePlugin = PromisePlugin;

export function createGhePlugin(dependencies: GhePluginDependencies = {}): GhePromisePlugin {
  const adapterFactory: GheAdapterFactory = dependencies.createAdapter ?? createGheProtocolAdapter;

  return define({
    id: GHE_PROVIDER_ID,
    async setup(context: PluginContext): Promise<void> {
      const config = parseGhePluginOptions(context.options);
      const adapter: GheProtocolAdapter = adapterFactory(createAdapterConfig(config, dependencies.env));
      const configuredProfiles = config.profiles ?? {};
      const supportedModelIds: ReadonlySet<string> = new Set([
        ...GHE_CATALOG_METADATA.profileIDs,
        ...Object.keys(configuredProfiles),
      ]);
      const models = new Map<string, LanguageModelV3>();
      const languageModel = (modelId: string): LanguageModelV3 => {
        if (!supportedModelIds.has(normalizeBuiltInModelID(modelId))) throw new Error("Unsupported GHE model ID.");
        const cached: LanguageModelV3 | undefined = models.get(modelId);
        if (cached !== undefined) return cached;
        const model: LanguageModelV3 = createGheLanguageModel(adapter, modelId);
        models.set(modelId, model);
        return model;
      };
      const sdk: GheSdk = { languageModel };

      await context.catalog.transform((draft: CatalogDraft): Promise<void> => {
        return registerGheCatalog(createCatalogAdapter(draft), configuredProfiles);
      });
      await context.aisdk.sdk((event): void => {
        if (event.model.providerID !== GHE_PROVIDER_ID || event.package !== GHE_AI_SDK_PACKAGE) return;
        Object.assign(event, { sdk });
      });
      await context.aisdk.language((event): void => {
        if (event.model.providerID !== GHE_PROVIDER_ID || !supportedModelIds.has(normalizeBuiltInModelID(event.model.id))) return;
        Object.assign(event, { language: languageModel(event.model.id) });
      });
    },
  });
}

export function createGhe(options: GheOptions): GheSdk {
  const apiKey = options.apiKey;
  const config = parseGhePluginOptions({
    baseUrl: options.baseURL,
    credential: options.credential ?? (options.credentialEnv === undefined
      ? { source: "opencode-auth" }
      : { source: "env", name: options.credentialEnv }),
    ...(options.oauthTokenLoader === undefined ? {} : { oauthTokenLoader: options.oauthTokenLoader }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.systemRole === undefined ? {} : { systemRole: options.systemRole }),
  });
  const adapterConfig: GheProtocolConfig = {
    ...createAdapterConfig(config),
    ...(apiKey === undefined || apiKey.length === 0
      ? {}
      : { credentialResolver: { resolve: (): string => apiKey } }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
  const adapter = createGheProtocolAdapter(adapterConfig);
  return createGheSdk(adapter, config.profiles ?? {});
}

function createGheSdk(
  adapter: GheProtocolAdapter,
  configuredProfiles: Readonly<Record<string, import("./ghe-protocol.ts").GheModelProfile>>,
): GheSdk {
  const supportedModelIds: ReadonlySet<string> = new Set([
    ...GHE_CATALOG_METADATA.profileIDs,
    ...Object.keys(configuredProfiles),
  ]);
  const models = new Map<string, LanguageModelV3>();
  const languageModel = (modelId: string): LanguageModelV3 => {
    if (!supportedModelIds.has(normalizeBuiltInModelID(modelId))) throw new Error("Unsupported GHE model ID.");
    const cached: LanguageModelV3 | undefined = models.get(modelId);
    if (cached !== undefined) return cached;
    const model: LanguageModelV3 = createGheLanguageModel(adapter, modelId);
    models.set(modelId, model);
    return model;
  };
  return { languageModel };
}

type RootConfig = Parameters<NonNullable<Hooks["config"]>>[0];
type GheRuntimeOptions = Record<string, unknown>;
type GheRootModel = {
  id: string;
  name: string;
  provider: { npm: string };
};
type GheRootProvider = {
  options?: GheRuntimeOptions;
  models?: Record<string, GheRootModel>;
};

function createRuntimeOptions(config: ReturnType<typeof parseGhePluginOptions>): GheRuntimeOptions {
  const { oauthTokenLoader: _oauthTokenLoader, ...serializableConfig } = config;
  return {
    baseURL: serializableConfig.baseUrl,
    ...(serializableConfig.credential.source === "env"
      ? { credentialEnv: serializableConfig.credential.name }
      : { credential: serializableConfig.credential }),
    ...(serializableConfig.headers === undefined ? {} : { headers: serializableConfig.headers }),
    ...(serializableConfig.profiles === undefined ? {} : { profiles: serializableConfig.profiles }),
    ...(serializableConfig.timeoutMs === undefined ? {} : { timeoutMs: serializableConfig.timeoutMs }),
    ...(serializableConfig.systemRole === undefined ? {} : { systemRole: serializableConfig.systemRole }),
  };
}

function createLegacyModels(
  configuredProfiles: Readonly<Record<string, import("./ghe-protocol.ts").GheModelProfile>>,
): Record<string, GheRootModel> {
  return Object.fromEntries(
    [...GHE_CATALOG_METADATA.profileIDs, ...Object.keys(configuredProfiles)].map((modelID): [string, GheRootModel] => [
      modelID,
      { id: modelID, name: getGheCatalogModelName(modelID), provider: { npm: import.meta.url } },
    ]),
  );
}

function seedRootConfig(config: RootConfig, pluginConfig: ReturnType<typeof parseGhePluginOptions>): void {
  const target = config as unknown as { provider?: Record<string, GheRootProvider> };
  const providers = target.provider ?? (target.provider = {});
  const provider = providers[GHE_PROVIDER_ID] ?? (providers[GHE_PROVIDER_ID] = {});
  provider.options = { ...createRuntimeOptions(pluginConfig), ...provider.options };
  provider.models = { ...provider.models, ...createLegacyModels(pluginConfig.profiles ?? {}) };
}

export const GhePlugin: PluginModule = {
  id: GHE_PROVIDER_ID,
  async server(_input: Parameters<RootPlugin>[0], rawOptions: Parameters<RootPlugin>[1] = {}): Promise<Hooks> {
    return {
      auth: {
        provider: GHE_PROVIDER_ID,
        methods: [createBmwDeviceOAuthMethod()],
        async loader(auth, _provider): Promise<Record<string, unknown>> {
          return {
            async oauthTokenLoader(): Promise<string | undefined> {
              return oauthAccess(await auth());
            },
          };
        },
      },
      async config(rootConfig: RootConfig): Promise<void> {
        const config = parseGhePluginOptions(rawOptions ?? {});
        seedRootConfig(rootConfig, config);
      },
    };
  },
};

function createCatalogAdapter(draft: CatalogDraft): GheCatalogDraft {
  return {
    provider: {
      async update(id: string, provider: GheCatalogProvider): Promise<void> {
        draft.provider.update(id, (target): void => {
          Object.assign(target, {
            id,
            name: provider.name,
            disabled: !provider.enabled,
            api: { type: provider.api.type, package: provider.api.package },
            request: { headers: {}, body: {} },
          });
        });
      },
    },
    model: {
      async update(providerID: string, modelID: string, model: GheCatalogModel): Promise<void> {
        draft.model.update(providerID, modelID, (target): void => {
          Object.assign(target, {
            id: modelID,
            providerID,
            name: model.name,
            api: { type: model.api.type, package: model.api.package, id: model.api.id },
            capabilities: {
              tools: model.capabilities.toolcall,
              input: Object.keys(model.capabilities.input),
              output: Object.keys(model.capabilities.output),
            },
            request: { headers: {}, body: {} },
            variants: [],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: model.enabled,
            limit: { context: 0, output: 0 },
          });
        });
      },
    },
  };
}

function oauthAccess(auth: unknown): string | undefined {
  if (typeof auth !== "object" || auth === null || Array.isArray(auth)) return undefined;
  const record = auth as Readonly<Record<string, unknown>>;
  if (record.type !== "oauth" || typeof record.access !== "string") return undefined;
  const access = record.access.trim();
  return access.length === 0 ? undefined : access;
}

export const GhePromisePlugin: GhePromisePlugin = createGhePlugin();

// Required by OpenCode's external plugin loader.
export default GhePlugin;
