import { expect, test } from "bun:test";
import { createGhe } from "../src/plugin.ts";

test("creates cached GHE language models without protocol requests", () => {
  let fetchCalls = 0;
  const sdk = createGhe({
    baseURL: "https://ghe.example.test",
    apiKey: "test-key",
    fetch: async (): Promise<Response> => {
      fetchCalls += 1;
      throw new Error("unexpected request");
    },
  });
  const model = sdk.languageModel("github_copilot/claude-sonnet-5");
  expect(model).toMatchObject({ provider: "ghe", modelId: "github_copilot/claude-sonnet-5" });
  expect(sdk.languageModel("github_copilot/claude-sonnet-5")).toBe(model);
  expect(fetchCalls).toBe(0);
});

test("rejects unsupported GHE model IDs", () => {
  const sdk = createGhe({ baseURL: "https://ghe.example.test" });
  expect((): unknown => sdk.languageModel("unsupported")).toThrow("Unsupported GHE model ID.");
});
