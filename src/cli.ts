import { ConfigError, executeProbe, parseConfig, type ProbeConfig } from "./contract-probe.ts";

interface RuntimeBun {
  write(path: string, data: string): Promise<number>;
}

interface RuntimeProcess {
  readonly argv: string[];
  readonly env: Record<string, string | undefined>;
  exitCode?: number;
}

export const HELP_TEXT = "Usage: bun run src/cli.ts --model MODEL [--base-url URL] [--stream] [--live] [--output PATH] [--help]";

export function getEnvironment(): Record<string, string | undefined> {
  return (globalThis as { process?: RuntimeProcess }).process?.env ?? {};
}

export async function runCli(args: readonly string[], environment: Record<string, string | undefined> = getEnvironment()): Promise<number> {
  try {
    const parsed = parseConfig(args, environment.BMW_GHE_TOKEN);
    if ("help" in parsed) {
      console.log(HELP_TEXT);
      return 0;
    }
    return await runConfig(parsed);
  } catch (error: unknown) {
    const message = error instanceof ConfigError ? error.message : "Probe failed.";
    console.error(message);
    return 1;
  }
}

export async function runConfig(config: ProbeConfig): Promise<number> {
  const result = await executeProbe(config);
  const fixtureJson = JSON.stringify(result.fixture, null, 2);
  if (!config.live) {
    console.log(fixtureJson);
    return 0;
  }
  if (config.output === undefined) {
    console.log(fixtureJson);
  } else {
    const runtimeBun = (globalThis as unknown as { readonly Bun: RuntimeBun }).Bun;
    await runtimeBun.write(config.output, fixtureJson);
    console.log(JSON.stringify({ output: config.output, status: result.fixture.response?.status ?? "error" }));
  }
  return result.ok ? 0 : 1;
}

if ((import.meta as { main?: boolean }).main) {
  const runtimeProcess = (globalThis as { process?: RuntimeProcess }).process;
  const args = runtimeProcess?.argv.slice(2) ?? [];
  const exitCode = await runCli(args);
  if (runtimeProcess !== undefined) runtimeProcess.exitCode = exitCode;
}
