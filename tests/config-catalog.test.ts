import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GHE_AI_SDK_PACKAGE, GHE_PROVIDER_ID, registerGheCatalog } from "../src/catalog.ts";
import { GhePluginConfigError, createAdapterConfig, parseGhePluginOptions } from "../src/config.ts";
import { GhePlugin } from "../src/plugin.ts";

const BMW_PLUGIN_URL = "file:///home/me/experimental/opencode-ghe/dist/plugin.js";
const BMW_BASE_URL = "https://copilot-api.bmw.ghe.com";
const DEFAULT_MODEL_ID = "ghe/claude-sonnet-5";
const CANONICAL_MODEL_IDS: readonly string[] = [
  "gpt-5-mini",
  "gpt-5.4-mini",
  "claude-haiku-4.5",
  "claude-opus-4.8",
  "claude-sonnet-5",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];
const CHAT_MODEL_IDS: readonly string[] = CANONICAL_MODEL_IDS.slice(0, 5);
const RESPONSES_MODEL_IDS: readonly string[] = CANONICAL_MODEL_IDS.slice(5);
const FRIENDLY_MODEL_LABELS: Readonly<Record<string, string>> = {
  "gpt-5-mini": "GPT 5 Mini",
  "gpt-5.4-mini": "GPT 5.4 Mini",
  "claude-haiku-4.5": "Claude Haiku 4.5",
  "claude-opus-4.8": "Claude Opus 4.8",
  "claude-sonnet-5": "Claude Sonnet 5",
  "gpt-5.6-terra": "GPT 5.6 Terra",
  "gpt-5.6-luna": "GPT 5.6 Luna",
};
const BMW_LOGIN_COMMAND = 'opencode auth login --provider ghe --method "BMW Copilot device login"';

export function readProjectText(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

export function shellBlockAfterHeading(markdown: string, heading: string): string {
  const section: string | undefined = markdown.split(heading)[1];
  const block: RegExpMatchArray | null = section?.match(/```sh\n([\s\S]*?)```/);
  if (block?.[1] === undefined) {
    throw new Error(`Missing shell block after ${heading}`);
  }
  return block[1];
}

export function documentationUrls(markdown: string): string[] {
  return markdown.match(/https?:\/\/[^\s`"'<>]+/g) ?? [];
}

export function staleV1EndpointExamples(markdown: string): string[] {
  return markdown.match(/(?:https?:\/\/[^\s`"'<>]*\/v1(?:[/?#.][^\s`"'<>]*)?|<baseUrl>\/v1(?:\/[^\s`"'<>]*)?|\/v1\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~/-]+)*)/g) ?? [];
}

export function markdownSection(markdown: string, heading: string): string {
  const headingIndex: number = markdown.indexOf(heading);
  if (headingIndex === -1) {
    throw new Error(`Missing section ${heading}`);
  }
  const nextHeadingIndex: number = markdown.indexOf("\n## ", headingIndex + heading.length);
  return markdown.slice(headingIndex, nextHeadingIndex === -1 ? undefined : nextHeadingIndex);
}

export function configurationCodeBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```(?:json|jsonc)\n([\s\S]*?)```/g)].map((match: RegExpMatchArray): string => match[1] ?? "");
}

export function modelTableRow(markdown: string, modelId: string): string[] {
  const row: string | undefined = markdown.split("\n").find((line: string): boolean => line.split("|")[2]?.trim() === `\`ghe/${modelId}\``);
  if (row === undefined) {
    throw new Error(`Missing model table row for ${modelId}`);
  }
  return row.split("|").slice(1, -1).map((cell: string): string => cell.trim().replaceAll("`", ""));
}

const options = {
  baseUrl: "https://ghe.example.test/api",
  credential: { source: "env", name: "GHE_TOKEN" },
  headers: { "X-Copilot-Feature": "test" },
  timeoutMs: 1000,
  profiles: { custom: { id: "custom", wireModel: "wire-custom", endpoint: "responses", reasoningBudget: 7 } },
} as const;

describe("GHE plugin configuration", () => {
  test("parses complete valid options and resolves environment credentials lazily", () => {
    const config = parseGhePluginOptions(options);
    const env: Record<string, string | undefined> = { GHE_TOKEN: "first" };
    const adapter = createAdapterConfig(config, env);
    expect(config).toEqual(options);
    expect(adapter.credentialResolver?.resolve()).toBe("first");
    env.GHE_TOKEN = "second";
    expect(adapter.credentialResolver?.resolve()).toBe("second");
    expect(adapter).toMatchObject({ baseUrl: options.baseUrl, copilotHeaders: options.headers, timeoutMs: 1000, modelProfiles: options.profiles });
  });

  test("defaults omitted credentials to OpenCode auth without reading GHE environment values", async () => {
    const config = parseGhePluginOptions({ baseUrl: options.baseUrl });
    const adapter = createAdapterConfig(config, { GHE_COPILOT_TOKEN: "sentinel-ghe-token", GHE_TOKEN: "sentinel-token" });
    const hooks = await GhePlugin.server({}, { baseUrl: options.baseUrl });
    const rootConfig: Record<string, unknown> = {};

    expect(config).toEqual({ baseUrl: options.baseUrl, credential: { source: "opencode-auth" } });
    await expect(adapter.credentialResolver!.resolve()).rejects.toThrow('opencode auth login --provider ghe --method "BMW Copilot device login"');
    await hooks.config(rootConfig);
    expect(rootConfig).toMatchObject({ provider: { ghe: { options: { baseURL: options.baseUrl, credential: { source: "opencode-auth" } } } } });
  });

  test("rejects missing, empty, unknown, malformed, and unsafe configuration fields", () => {
    const secret = "never-report-this-secret";
    for (const value of [undefined, ""]) {
      const config = parseGhePluginOptions({ baseUrl: options.baseUrl, credential: options.credential });
      const error = expect((): string => createAdapterConfig(config, { GHE_TOKEN: value }).credentialResolver?.resolve() ?? "").toThrow(GhePluginConfigError);
      expect(String(error)).not.toContain(secret);
    }
    for (const value of ["bad-url", "ftp://ghe.example.test", ""] as const) {
      expect((): unknown => parseGhePluginOptions({ ...options, baseUrl: value })).toThrow(GhePluginConfigError);
    }
    expect((): unknown => parseGhePluginOptions({ ...options, extra: true })).toThrow("Unknown plugin option: extra.");
    expect((): unknown => parseGhePluginOptions({ baseUrl: options.baseUrl, credential: { source: "file", name: "GHE_TOKEN" } })).toThrow('credential.source must be "env", "github-oauth", or "opencode-auth".');
    expect((): unknown => parseGhePluginOptions({ baseUrl: options.baseUrl, credential: { source: "env", name: "not-valid" } })).toThrow(GhePluginConfigError);
    expect((): unknown => parseGhePluginOptions({ ...options, headers: { "": "x" } })).toThrow(GhePluginConfigError);
    expect((): unknown => parseGhePluginOptions({ ...options, timeoutMs: 0 })).toThrow(GhePluginConfigError);
    expect((): unknown => parseGhePluginOptions({ ...options, timeoutMs: 1.5 })).toThrow(GhePluginConfigError);
    expect((): unknown => parseGhePluginOptions({ ...options, profiles: { wrong: { id: "other", wireModel: "wire", endpoint: "chat" } } })).toThrow("Each profile key must match profile.id.");
    expect((): unknown => parseGhePluginOptions({ ...options, profiles: { custom: { id: "custom", wireModel: "wire", endpoint: "chat", extra: true } } })).toThrow(GhePluginConfigError);
    expect((): unknown => parseGhePluginOptions({ ...options, profiles: { custom: { id: "custom", wireModel: "wire", endpoint: "invalid" } } })).toThrow(GhePluginConfigError);
    expect((): unknown => parseGhePluginOptions({ ...options, profiles: { custom: { id: "custom", wireModel: "wire", endpoint: "chat", reasoningBudget: 0 } } })).toThrow(GhePluginConfigError);
  });
});

describe("GHE catalog", () => {
  test("seeds Claude Sonnet 5 resolver configuration while cataloging it through AISDK", async () => {
    const hooks = await GhePlugin.server({}, options);
    const rootConfig: Record<string, unknown> = {};
    await hooks.config(rootConfig);
    expect(rootConfig).toEqual({
      provider: {
        ghe: {
          options: {
            baseURL: options.baseUrl,
            credentialEnv: options.credential.name,
            headers: options.headers,
            profiles: options.profiles,
            timeoutMs: options.timeoutMs,
          },
          models: expect.objectContaining({
            "claude-sonnet-5": {
              id: "claude-sonnet-5",
              provider: { npm: new URL("../src/plugin.ts", import.meta.url).href },
            },
          }),
        },
      },
    });
    expect(rootConfig).not.toHaveProperty("provider.ghe.models.claude-sonnet-5.provider.npm", "opencode-ghe");

    const models: Array<[string, string, Record<string, unknown>]> = [];
    await registerGheCatalog({
      provider: { update: async (): Promise<void> => undefined },
      model: { update: async (provider, id, value): Promise<void> => { models.push([provider, id, value]); } },
    });
    expect(models).toContainEqual([
      "ghe",
      "claude-sonnet-5",
      expect.objectContaining({
        api: { type: "aisdk", package: GHE_AI_SDK_PACKAGE, id: "claude-sonnet-5" },
      }),
    ]);
  });

  test("registers provider and seven canonical built-ins with AISDK IDs", async () => {
    const providers: Array<[string, unknown]> = [];
    const models: Array<[string, string, Record<string, unknown>]> = [];
    await registerGheCatalog({
      provider: { update: async (id, value): Promise<void> => { providers.push([id, value]); } },
      model: { update: async (provider, id, value): Promise<void> => { models.push([provider, id, value]); } },
    });
    expect(providers).toEqual([[GHE_PROVIDER_ID, expect.objectContaining({ api: { type: "aisdk", package: GHE_AI_SDK_PACKAGE } })]]);
    expect(models.map(([, id]) => id)).toEqual([
      "claude-haiku-4.5",
      "claude-sonnet-5",
      "claude-opus-4.8",
      "gpt-5-mini",
      "gpt-5.4-mini",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    for (const [provider, id, model] of models) {
      expect(provider).toBe("ghe");
      expect(model).toMatchObject({ active: true, enabled: true, api: { type: "aisdk", package: "opencode-ghe", id } });
    }
  });

  test("adds profiles and overrides built-ins without removing remaining built-ins", async () => {
    const models: Array<[string, Record<string, unknown>]> = [];
    await registerGheCatalog({ provider: { update: async (): Promise<void> => undefined }, model: { update: async (_, id, value): Promise<void> => { models.push([id, value]); } } }, {
      "github_copilot/claude-sonnet-5": { id: "github_copilot/claude-sonnet-5", wireModel: "override", endpoint: "chat" },
      custom: { id: "custom", wireModel: "custom", endpoint: "responses" },
    });
    expect(models).toHaveLength(8);
    expect(models.map(([id]): string => id)).toEqual(expect.arrayContaining(["claude-sonnet-5", "gpt-5.6-terra", "custom"]));
    expect(models.map(([id]): string => id)).not.toContain("github_copilot/claude-sonnet-5");
    expect(models.find(([id]): boolean => id === "claude-sonnet-5")?.[1]).toMatchObject({ api: { id: "claude-sonnet-5" } });
  });
});

describe("published configuration contract", () => {
  test("ships strict JSON default configs with native auth and Sonnet selection", (): void => {
    const exampleText: string = readProjectText("examples/opencode.jsonc");
    const projectConfigText: string = readProjectText(".opencode/opencode.jsonc");
    const example: unknown = JSON.parse(exampleText);
    const projectConfig: unknown = JSON.parse(projectConfigText);

    expect(example).toEqual({
      plugin: [[
        BMW_PLUGIN_URL,
        {
          baseUrl: BMW_BASE_URL,
        },
      ]],
      model: DEFAULT_MODEL_ID,
    });
    expect(projectConfig).toEqual({
      $schema: "https://opencode.ai/config.json",
      plugin: [[
        BMW_PLUGIN_URL,
        {
          baseUrl: BMW_BASE_URL,
        },
      ]],
      model: DEFAULT_MODEL_ID,
    });
    expect(example).not.toHaveProperty("plugins");
    expect(example).not.toHaveProperty("plugin.0.1.credential");
    expect(projectConfig).not.toHaveProperty("plugin.0.1.credential");
    expect(exampleText).not.toContain("ghe/github_copilot/");
    expect(projectConfigText).not.toContain("ghe/github_copilot/");
    expect(exampleText).not.toMatch(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/);
  });

  test("documents install, credential modes, exact model routing, migration, and safety", (): void => {
    const readme: string = readProjectText("README.md");
    const install: string = markdownSection(readme, "## Prerequisites, install, build, and test");
    const localSetup: string = markdownSection(readme, "## Local checkout/file install (BMW setup)");
    const verification: string = markdownSection(readme, "## Verification");
    const migration: string = markdownSection(readme, "## LiteLLM migration");
    const rollback: string = markdownSection(readme, "## Rollback");
    const troubleshooting: string = markdownSection(readme, "## Troubleshooting");
    const secretPolicy: string = markdownSection(readme, "## Secret and log policy");
    const defaultConfigExamples: unknown[] = [
      JSON.parse(configurationCodeBlocks(install)[0] ?? ""),
      JSON.parse(configurationCodeBlocks(localSetup)[0] ?? ""),
    ];
    const safeProbe: string = shellBlockAfterHeading(readme, "## Verification");

    expect(install).toContain("bun install");
    expect(install).toContain("bun run build");
    expect(install).toContain("bun run typecheck");
    expect(install).toContain("bun run test");
    expect(install).toContain(`\`\`\`sh\n${BMW_LOGIN_COMMAND}\n\`\`\``);
    expect(shellBlockAfterHeading(readme, "## Local checkout/file install (BMW setup)").trim()).toBe(BMW_LOGIN_COMMAND);
    expect(readme).toContain("Native login is default. As an optional advanced fallback, for an already-exchanged Copilot token set `GHE_COPILOT_TOKEN` in the environment and use this tuple options object:");
    expect(readme).toContain("GHE_COPILOT_TOKEN");
    expect(JSON.parse(configurationCodeBlocks(markdownSection(readme, "## Advanced explicit credential fallbacks"))[0] ?? "")).toMatchObject({ credential: { source: "env", name: "GHE_COPILOT_TOKEN" } });
    expect(readme).toContain(BMW_PLUGIN_URL);
    expect(readme).toContain(BMW_BASE_URL);
    expect(readme).toContain(DEFAULT_MODEL_ID);
    expect(defaultConfigExamples).toEqual([
      ["opencode-ghe", { baseUrl: BMW_BASE_URL }],
      { plugin: [[BMW_PLUGIN_URL, { baseUrl: BMW_BASE_URL }]], model: DEFAULT_MODEL_ID },
    ]);
    expect(defaultConfigExamples).not.toHaveProperty("0.1.credential");
    expect(defaultConfigExamples).not.toHaveProperty("1.plugin.0.1.credential");
    expect(install).not.toContain("ghe/github_copilot/");
    expect(localSetup).not.toContain("ghe/github_copilot/");
    expect(CANONICAL_MODEL_IDS).toEqual([
      "gpt-5-mini",
      "gpt-5.4-mini",
      "claude-haiku-4.5",
      "claude-opus-4.8",
      "claude-sonnet-5",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    for (const modelId of CHAT_MODEL_IDS) {
      expect(modelTableRow(readme, modelId)).toEqual([
        FRIENDLY_MODEL_LABELS[modelId],
        `ghe/${modelId}`,
        "chat — POST<baseUrl>/chat/completions",
        "16000",
      ]);
    }
    for (const modelId of RESPONSES_MODEL_IDS) {
      expect(modelTableRow(readme, modelId)).toEqual([
        FRIENDLY_MODEL_LABELS[modelId],
        `ghe/${modelId}`,
        "responses — POST<baseUrl>/responses",
        "No built-in budget",
      ]);
    }
    expect(readme).toContain("BMW LiteLLM reference also lists `gpt-5`, `gpt-5.4`, and `gpt-5.5`; plugin does not expose them because capabilities and routes are unverified.");
    expect(readme).toContain("Old `ghe/github_copilot/<model>` requests are compatibility-only, not catalog IDs.");
    expect(documentationUrls(readme)).not.toContainEqual(expect.stringMatching(/\/v1(?:[/?#. ]|$)/));
    expect(staleV1EndpointExamples(readme)).toEqual([]);
    expect(readme).toContain("do not use `/v1`");
    expect(configurationCodeBlocks(readme).join("\n")).not.toMatch(/^\s*"plugins"\s*:/m);
    expect(safeProbe).not.toContain("--live");
    expect(verification).toContain("For an opt-in live contract probe, set `BMW_GHE_TOKEN`");
    expect(verification).toContain("--base-url https://copilot-api.bmw.ghe.com --live");
    expect(migration).toContain("Back up current config before editing:");
    expect(migration).toContain("opencode.jsonc.litellm-backup");
    expect(migration).toContain("provider.litellm");
    expect(rollback).toContain("Restore the backup:");
    expect(rollback).toContain("opencode.jsonc.litellm-backup ~/.config/opencode/opencode.jsonc");
    for (const status of ["401", "403", "404", "429", "5xx"] as const) {
      expect(troubleshooting).toContain(status);
    }
    expect(secretPolicy).toContain("Never place tokens, cookies, or cache contents in documentation, config, logs, or fixtures.");
    expect(secretPolicy).toContain("Use environment variables for values.");
    expect(readme).not.toMatch(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/);
  });
});
