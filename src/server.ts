import { loadEnvFile } from "node:process";
import { DeterministicMemoryProvider } from "./adapters/deterministic-memory.js";
import { LettaMemoryProvider } from "./adapters/letta-memory.js";
import type { MemoryProvider } from "./domain.js";
import { buildApp } from "./http-app.js";

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

  return new LettaMemoryProvider({
    url: process.env.LETTA_APP_SERVER_URL ?? "http://127.0.0.1:4500",
    ...(process.env.LETTA_APP_SERVER_TOKEN
      ? { authToken: process.env.LETTA_APP_SERVER_TOKEN }
      : {}),
    ...(process.env.LETTA_MODEL ? { model: process.env.LETTA_MODEL } : {}),
  });
}

const app = buildApp({ memory: memoryProviderFromEnvironment(), logger: true });
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
