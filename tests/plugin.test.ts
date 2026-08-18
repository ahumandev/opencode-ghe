import { describe, expect, test } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createGhePlugin, GhePlugin } from "../src/plugin.ts";
import type { GheProtocolAdapter, GheProtocolConfig } from "../src/ghe-protocol.ts";

interface RegisteredHooks {
  sdk?: (event: Record<string, unknown>) => void;
  language?: (event: Record<string, unknown>) => void;
}

const BUILT_IN_MODEL_IDS = [
  "claude-haiku-4.5",
  "claude-sonnet-5",
  "claude-opus-4.8",
  "gpt-5-mini",
  "gpt-5.4-mini",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

describe("GHE plugin V2 registration", () => {
  test("discovers BMW Copilot device login before OAuth loader resolution", async () => {
    let loaderCalls = 0;
    const hooks = await GhePlugin.server({}, {
      baseUrl: "https://ghe.example.test",
      oauthTokenLoader: async (): Promise<never> => {
        loaderCalls += 1;
        throw new Error("OAuth loader must not run during method discovery.");
      },
    });

    expect(hooks.auth?.methods).toHaveLength(1);
    expect(hooks.auth?.methods[0]).toMatchObject({ type: "oauth", label: "BMW Copilot device login" });
    expect(loaderCalls).toBe(0);
  });

  test("discovers BMW OAuth auth hook, loads OAuth records, and omits loader from runtime config", async () => {
    const hooks = await GhePlugin.server({}, { baseUrl: "https://ghe.example.test", credential: { source: "env", name: "GHE_TOKEN" }, oauthTokenLoader: async (): Promise<string | undefined> => "do-not-serialize" });
    expect(hooks.auth).toMatchObject({ provider: "ghe", methods: [{ type: "oauth", label: "BMW Copilot device login" }] });
    const loaded = await hooks.auth!.loader(async (): Promise<unknown> => ({ type: "oauth", access: " stored-oauth-token ", refresh: "ignore" }), "ghe");
    expect(await (loaded.oauthTokenLoader as () => Promise<string | undefined>)()).toBe("stored-oauth-token");
    expect(JSON.stringify(loaded)).not.toContain("stored-oauth-token");
    expect(await hooks.auth!.loader(async (): Promise<unknown> => ({ type: "api", access: "stored-oauth-token" }), "ghe")).toMatchObject({ oauthTokenLoader: expect.any(Function) });
    const rootConfig: Record<string, unknown> = {};
    await hooks.config(rootConfig);
    const serialized = JSON.stringify(rootConfig);
    expect(serialized).not.toContain("do-not-serialize");
    expect(serialized).not.toContain("oauthTokenLoader");
    expect(serialized).not.toContain("stored-oauth-token");
  });

  test("discovers BMW device login, loads stored OAuth token, and uses default runtime credentials", async () => {
    const hooks = await GhePlugin.server({}, { baseUrl: "https://ghe.example.test" });

    expect(hooks.auth).toMatchObject({ provider: "ghe", methods: [{ type: "oauth", label: "BMW Copilot device login" }] });
    const loaded = await hooks.auth!.loader(async (): Promise<unknown> => ({ type: "oauth", access: " stored-oauth-token " }), "ghe");
    expect(loaded.oauthTokenLoader).toEqual(expect.any(Function));
    expect(await (loaded.oauthTokenLoader as () => Promise<string | undefined>)()).toBe("stored-oauth-token");
    const rootConfig: Record<string, unknown> = {};
    await hooks.config(rootConfig);
    expect(rootConfig).toMatchObject({ provider: { ghe: { options: { credential: { source: "opencode-auth" } } } } });
  });

  test("registers catalog and gated SDK/language selectors with one lazy adapter", async () => {
    const env: Record<string, string | undefined> = { GHE_TOKEN: "first" };
    const configs: GheProtocolConfig[] = [];
    const hooks: RegisteredHooks = {};
    const providers: Record<string, unknown>[] = [];
    const models: Record<string, unknown>[] = [];
    const adapter = {
      complete: async (): Promise<never> => { throw new Error("unused"); },
      stream: (): AsyncIterable<never> => ({ [Symbol.asyncIterator]: async function* (): AsyncIterableIterator<never> {} }),
    } as unknown as GheProtocolAdapter;
    const plugin = createGhePlugin({ env, createAdapter: (config): GheProtocolAdapter => { configs.push(config); return adapter; } });
    await plugin.setup({
      options: {
        baseUrl: "https://ghe.example.test",
        credential: { source: "env", name: "GHE_TOKEN" },
        profiles: {
          "claude-sonnet-4.6": { id: "claude-sonnet-4.6", wireModel: "claude-sonnet-4.6", endpoint: "chat" },
          "gpt-5.4": { id: "gpt-5.4", wireModel: "gpt-5.4", endpoint: "responses" },
          "gpt-5.3-codex": { id: "gpt-5.3-codex", wireModel: "gpt-5.3-codex", endpoint: "responses" },
          auto: { id: "auto", wireModel: "auto", endpoint: "chat" },
          unknown: { id: "unknown", wireModel: "unknown", endpoint: "chat" },
        },
      },
      catalog: { transform: async (callback: (draft: unknown) => Promise<void>): Promise<void> => callback({
        provider: { update: (_: string, update: (target: Record<string, unknown>) => void): void => { const target: Record<string, unknown> = {}; update(target); providers.push(target); } },
        model: { update: (_: string, __: string, update: (target: Record<string, unknown>) => void): void => { const target: Record<string, unknown> = {}; update(target); models.push(target); } },
      }) },
      aisdk: { sdk: async (hook: (event: Record<string, unknown>) => void): Promise<void> => { hooks.sdk = hook; }, language: async (hook: (event: Record<string, unknown>) => void): Promise<void> => { hooks.language = hook; } },
    } as never);
    expect(plugin.id).toBe("ghe");
    expect(configs).toHaveLength(1);
    expect(configs[0]?.credentialResolver?.resolve()).toBe("first");
    env.GHE_TOKEN = "second";
    expect(configs[0]?.credentialResolver?.resolve()).toBe("second");
    expect(providers).toHaveLength(1);
    expect(models.map((model): unknown => model.id)).toEqual([
      ...BUILT_IN_MODEL_IDS,
      "claude-sonnet-4.6",
      "gpt-5.4",
      "gpt-5.3-codex",
      "auto",
      "unknown",
    ]);
    const catalogLimits = new Map(models.map((model): [string, unknown] => [String(model.id), model.limit]));
    expect(catalogLimits.get("auto")).toEqual({ context: 0, output: 0 });
    expect(catalogLimits.get("unknown")).toEqual({ context: 0, output: 0 });
    const selected: Record<string, unknown> = { model: { providerID: "ghe", id: "claude-sonnet-5" }, package: "opencode-ghe" };
    const language: Record<string, unknown> = { model: { providerID: "ghe", id: "claude-sonnet-5" } };
    for (const id of BUILT_IN_MODEL_IDS) {
      const sdkEvent: Record<string, unknown> = { model: { providerID: "ghe", id }, package: "opencode-ghe" };
      const languageEvent: Record<string, unknown> = { model: { providerID: "ghe", id } };
      hooks.sdk?.(sdkEvent);
      hooks.language?.(languageEvent);
      expect(sdkEvent.sdk).toBeDefined();
      expect(languageEvent.language).toMatchObject({ specificationVersion: "v3", provider: "ghe", modelId: id });
      if (id === "claude-sonnet-5") {
        Object.assign(selected, sdkEvent);
        Object.assign(language, languageEvent);
      }
    }
    const wrongPackage: Record<string, unknown> = { model: { providerID: "ghe", id: "claude-sonnet-5" }, package: "other" };
    const wrongProvider: Record<string, unknown> = { model: { providerID: "other", id: "claude-sonnet-5" }, package: "opencode-ghe" };
    hooks.sdk?.(wrongPackage); hooks.sdk?.(wrongProvider);
    expect(wrongPackage.sdk).toBeUndefined(); expect(wrongProvider.sdk).toBeUndefined();
    const first = language.language as LanguageModelV3;
    const again: Record<string, unknown> = { model: { providerID: "ghe", id: "claude-sonnet-5" } };
    hooks.language?.(again);
    expect(first).toBe(again.language);
    expect(first).toMatchObject({ specificationVersion: "v3", provider: "ghe", modelId: "claude-sonnet-5" });
    const unknown: Record<string, unknown> = { model: { providerID: "ghe", id: "unknown" } };
    const nonGhe: Record<string, unknown> = { model: { providerID: "other", id: "claude-sonnet-5" } };
    hooks.language?.(unknown); hooks.language?.(nonGhe);
    expect(unknown.language).toMatchObject({ specificationVersion: "v3", provider: "ghe", modelId: "unknown" }); expect(nonGhe.language).toBeUndefined();
    expect((selected.sdk as { languageModel: (id: string) => LanguageModelV3 }).languageModel("unknown")).toMatchObject({ specificationVersion: "v3", provider: "ghe", modelId: "unknown" });
  });
});
