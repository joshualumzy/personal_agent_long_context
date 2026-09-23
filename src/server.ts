import { loadEnvFile } from "node:process";
import { DeterministicMemoryProvider } from "./adapters/deterministic-memory.js";
import { LettaMemoryProvider } from "./adapters/letta-memory.js";
import type { MemoryProvider } from "./domain.js";
import { buildApp } from "./http-app.js";
import { lettaOptionsFromEnvironment } from "./letta-config.js";
import { recruitingFromEnvironment } from "./recruiting/config.js";

try {
  loadEnvFile();
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
    throw error;
  }
}

function memoryProviderFromEnvironment(): MemoryProvider {
  if (process.env.MEMORY_ADAPTER === "deterministic") {
    return new DeterministicMemoryProvider();
  }

  return new LettaMemoryProvider(lettaOptionsFromEnvironment(process.env));
}

const memory = memoryProviderFromEnvironment();
let logRecruitingFailure: (context: string, error: unknown) => void = () => {};
const recruiting = recruitingFromEnvironment(process.env, memory, (context, error) =>
  logRecruitingFailure(context, error),
);
const app = buildApp({
  memory,
  logger: true,
  ...(recruiting ? { recruiting } : {}),
});
logRecruitingFailure = (context, error) =>
  app.log.error(
    { context, reason: error instanceof Error ? error.message : String(error) },
    "Recruiting failure",
  );
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
