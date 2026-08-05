import { expect, test } from "bun:test";
import packageManifest from "../package.json" with { type: "json" };

test("publishes installable external package metadata", () => {
  expect(packageManifest.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/);
  expect(packageManifest.files).toContain("dist");
  expect(packageManifest.exports).toMatchObject({
    ".": {
      types: "./dist/plugin.d.ts",
      default: "./dist/plugin.js",
    },
  });
});

test("documents external package installation and package-name loader", async () => {
  const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();

  expect(readme).toMatch(/\b(?:bun|npm|pnpm|yarn)\s+(?:add|install|i)\s+opencode-ghe@0\.1\.0\b/);
  expect(readme).toMatch(/\[\s*"opencode-ghe"\s*,/);
});

test("loads external built plugin", async () => {
  const pluginModule = await import("../dist/plugin.js");
  expect(pluginModule.default.id).toBe("ghe");
  expect(typeof pluginModule.default.server).toBe("function");
  expect(pluginModule.GhePlugin).toBe(pluginModule.default);
  expect(pluginModule.createGhe).toBeInstanceOf(Function);
  const { server } = pluginModule.default;
  const hooks = await server({}, {
    baseUrl: "https://ghe.example.test",
    credential: { source: "env", name: "GHE_TOKEN" },
  });
  const config: Record<string, unknown> = {};
  await hooks.config(config);
  expect(config).toMatchObject({
    provider: {
      ghe: {
        options: {
          baseURL: "https://ghe.example.test",
          credentialEnv: "GHE_TOKEN",
        },
        models: {
          "claude-sonnet-5": {
            id: "claude-sonnet-5",
            provider: { npm: new URL("../dist/plugin.js", import.meta.url).href },
          },
        },
      },
    },
  });
  const model = (config.provider as { ghe: { models: Record<string, { id: string; provider: { npm: string } }> } }).ghe.models["claude-sonnet-5"];
  expect(model).toEqual({
    id: "claude-sonnet-5",
    provider: { npm: new URL("../dist/plugin.js", import.meta.url).href },
  });
  expect(model?.provider.npm).toStartWith("file:");
  expect(model?.provider.npm).not.toBe("opencode-ghe");
  const sdkModule = await import(model?.provider.npm ?? "");
  expect(sdkModule.createGhe).toBeInstanceOf(Function);
  const sdk = sdkModule.createGhe({
    baseURL: "https://ghe.example.test",
    credentialEnv: "GHE_TOKEN",
  });
  expect(sdk.languageModel("github_copilot/claude-sonnet-5")).toMatchObject({
    specificationVersion: "v3",
    provider: "ghe",
    modelId: "github_copilot/claude-sonnet-5",
  });
});
