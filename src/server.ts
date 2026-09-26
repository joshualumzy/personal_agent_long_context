import { loadEnvFile } from "node:process";
import { DeterministicMemoryProvider } from "./adapters/deterministic-memory.js";
import { LettaMemoryProvider } from "./adapters/letta-memory.js";
import type { MemoryProvider } from "./domain.js";
import { buildApp } from "./http-app.js";
import { lettaOptionsFromEnvironment } from "./letta-config.js";
import { recruitingFromEnvironment } from "./recruiting/config.js";
import { PostgresCompanyKnowledge } from "./adapters/postgres-company-knowledge.js";
import { PostgresConversationStore } from "./adapters/postgres-conversations.js";
import { SoCLaaSCompanyAgent } from "./soclaas-company-agent.js";
import { embeddingProviderFromEnvironment } from "./embeddings.js";

import { validateAuthConfig } from "./auth.js";

try {
  loadEnvFile();
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
    throw error;
  }
}

const sessionConfig = validateAuthConfig({
  SESSION_SECRET: process.env.SESSION_SECRET || process.env.AUTH_SECRET,
  SESSION_COOKIE_NAME: process.env.SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS: process.env.SESSION_MAX_AGE_SECONDS,
});

function memoryProviderFromEnvironment(): MemoryProvider {
  if (process.env.MEMORY_ADAPTER === "deterministic") {
    return new DeterministicMemoryProvider();
  }

  return new LettaMemoryProvider(lettaOptionsFromEnvironment(process.env));
}

const databaseUrl = process.env.DATABASE_URL;
const soCLaaSApiKey = process.env.SOCLAAS_API_KEY;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (!soCLaaSApiKey) throw new Error("SOCLAAS_API_KEY is required.");

const companyKnowledge = new PostgresCompanyKnowledge(
  databaseUrl,
  embeddingProviderFromEnvironment(process.env),
);
const conversationStore = new PostgresConversationStore(companyKnowledge.pool);
const companyAgent = new SoCLaaSCompanyAgent(companyKnowledge, {
  apiKey: soCLaaSApiKey,
  baseUrl: process.env.SOCLAAS_BASE_URL,
  model: process.env.SOCLAAS_COMPANY_MODEL,
});

const gatewayUrl = (process.env.LLM_GATEWAY_URL || process.env.LM_GATEWAY_URL)?.replace(/\/$/, "");
const gatewayApiKey = process.env.LLM_GATEWAY_API_KEY || process.env.LM_GATEWAY_API_KEY;
const gatewayModel = process.env.LLM_MODEL ?? "global.anthropic.claude-sonnet-4-5-20250929-v1:0";

const sonnetAgent =
  gatewayUrl && gatewayApiKey
    ? new SoCLaaSCompanyAgent(companyKnowledge, {
        apiKey: gatewayApiKey,
        baseUrl: `${gatewayUrl}/v1`,
        model: gatewayModel,
      })
    : null;

import { createDefaultModelRegistry } from "./model-registry.js";

const companyAgents: Record<string, SoCLaaSCompanyAgent> = {
  soclaas: companyAgent,
  ...(sonnetAgent ? { sonnet: sonnetAgent } : {}),
};

const modelRegistry = createDefaultModelRegistry({
  companyAgent,
  companyAgents,
  env: process.env,
});

const memory = memoryProviderFromEnvironment();
let logRecruitingFailure: (context: string, error: unknown) => void = () => {};
const recruiting = recruitingFromEnvironment(process.env, memory, (context, error) =>
  logRecruitingFailure(context, error),
);
const app = buildApp({
  sessionConfig,
  memory,
  companyAgent,
  companyAgents,
  modelRegistry,
  companyKnowledge,
  conversationStore,
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
