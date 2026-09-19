import type { LettaMemoryOptions } from "./adapters/letta-memory.js";

type Environment = Readonly<Record<string, string | undefined>>;

export function lettaOptionsFromEnvironment(
  environment: Environment,
): LettaMemoryOptions {
  const timeout = environment.LETTA_APP_SERVER_TIMEOUT_MS;
  let requestTimeoutMs: number | undefined;

  if (timeout !== undefined) {
    if (!/^[1-9]\d*$/.test(timeout)) {
      throw new Error(
        "LETTA_APP_SERVER_TIMEOUT_MS must be a positive integer in milliseconds.",
      );
    }
    requestTimeoutMs = Number(timeout);
    if (!Number.isSafeInteger(requestTimeoutMs)) {
      throw new Error(
        "LETTA_APP_SERVER_TIMEOUT_MS must be a positive integer in milliseconds.",
      );
    }
  }

  return {
    url: environment.LETTA_APP_SERVER_URL ?? "http://127.0.0.1:4500",
    ...(environment.LETTA_APP_SERVER_TOKEN
      ? { authToken: environment.LETTA_APP_SERVER_TOKEN }
      : {}),
    ...(environment.LETTA_MODEL ? { model: environment.LETTA_MODEL } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
  };
}
