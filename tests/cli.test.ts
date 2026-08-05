import { describe, expect, test } from "bun:test";
import { REDACTED } from "../src/contract-probe.ts";
import { HELP_TEXT, runCli, runConfig } from "../src/cli.ts";

interface ConsoleCapture {
  readonly code: number;
  readonly logs: string[];
  readonly errors: string[];
}

async function captureConsole(action: () => Promise<number>): Promise<ConsoleCapture> {
  const logs: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...values: unknown[]): void => { logs.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]): void => { errors.push(values.map(String).join(" ")); };
  try {
    return { code: await action(), logs, errors };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("CLI contract", () => {
  test("prints help", async () => {
    const result = await captureConsole((): Promise<number> => runCli(["--help"]));
    expect(result).toEqual({ code: 0, logs: [HELP_TEXT], errors: [] });
  });

  test("reports unknown, missing, and duplicate arguments", async () => {
    for (const [args, message] of [
      [["--wat"], "Unknown argument: --wat."],
      [[], "Missing required option: --model."],
      [["--model", "x", "--live", "--live"], "Duplicate flag: --live."],
    ] as const) {
      const result = await captureConsole((): Promise<number> => runCli(args));
      expect(result).toEqual({ code: 1, logs: [], errors: [message] });
    }
  });

  test("keeps tokenless probes dry-run and emits redacted fixture", async () => {
    const secret = ["unused", "token"].join("-");
    const result = await captureConsole((): Promise<number> => runCli(["--model", "other-model"], { BMW_GHE_TOKEN: secret }));
    expect(result.code).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]).toContain(`"Authorization": "${REDACTED}"`);
    expect(result.logs[0]).not.toContain(secret);
  });

  test("runConfig emits dry-run fixture", async () => {
    const result = await captureConsole((): Promise<number> => runConfig({ baseUrl: "https://ghe.example.test", model: "gpt-5.6-luna", stream: false, live: false }));
    expect(result.code).toBe(0);
    expect(result.logs[0]).toContain("/responses");
  });
});
