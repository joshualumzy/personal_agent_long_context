import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DeterministicMemoryProvider } from "./adapters/deterministic-memory.js";
import { LettaMemoryProvider } from "./adapters/letta-memory.js";
import type { MemoryProvider } from "./domain.js";
import { buildApp } from "./http-app.js";
import { lettaOptionsFromEnvironment } from "./letta-config.js";
import { recruitingFromEnvironment } from "./recruiting/config.js";
import { recruitingExtension } from "./recruiting/chat-tools.js";
import { loadSkills } from "./skills.js";
import { PostgresCompanyKnowledge } from "./adapters/postgres-company-knowledge.js";
import { PostgresConversationStore } from "./adapters/postgres-conversations.js";
import { SoCLaaSCompanyAgent } from "./soclaas-company-agent.js";
import { embeddingProviderFromEnvironment } from "./embeddings.js";
import { EmergentMemory } from "./emergent-memory.js";

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

const databaseUrl = process.env.DATABASE_URL;
const soCLaaSApiKey = process.env.SOCLAAS_API_KEY;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (!soCLaaSApiKey) throw new Error("SOCLAAS_API_KEY is required.");

const companyKnowledge = new PostgresCompanyKnowledge(
  databaseUrl,
  embeddingProviderFromEnvironment(process.env),
);
const conversationStore = new PostgresConversationStore(companyKnowledge.pool);

const memory = memoryProviderFromEnvironment();
let logRecruitingFailure: (context: string, error: unknown) => void = () => {};
const recruiting = recruitingFromEnvironment(process.env, memory, (context, error) =>
  logRecruitingFailure(context, error),
);
await recruiting?.ready;
// Recruiting reaches the chat agent as a skill whose tools load with it.
const agentSkills = recruiting
  ? {
      skills: (await loadSkills()).filter((skill) => skill.name === "recruiting"),
      extensions: [recruitingExtension(recruiting.board)],
    }
  : {};

const companyAgent = new SoCLaaSCompanyAgent(companyKnowledge, {
  apiKey: soCLaaSApiKey,
  baseUrl: process.env.SOCLAAS_BASE_URL,
  model: process.env.SOCLAAS_COMPANY_MODEL,
  ...agentSkills,
});

const gatewayUrl = (process.env.LLM_GATEWAY_URL || process.env.LM_GATEWAY_URL)?.replace(/\/$/, "");const gatewayApiKey = process.env.LLM_GATEWAY_API_KEY || process.env.LM_GATEWAY_API_KEY;
const gatewayModel = process.env.LLM_MODEL ?? "global.anthropic.claude-sonnet-4-5-20250929-v1:0";

const sonnetAgent =
  gatewayUrl && gatewayApiKey
    ? new SoCLaaSCompanyAgent(companyKnowledge, {
        apiKey: gatewayApiKey,
        baseUrl: `${gatewayUrl}/v1`,
        model: gatewayModel,
        ...agentSkills,
      })
    : null;

const companyAgents: Record<string, SoCLaaSCompanyAgent> = {
  soclaas: companyAgent,
  ...(sonnetAgent ? { sonnet: sonnetAgent } : {}),
};

/**
 * Extraction for the emergent graph, if this checkout can run it.
 *
 * It needs the project virtualenv and an LLM for cognee, so it stays off unless
 * both are present: without it, questions are answered exactly as before and
 * /graph simply shows the last export.
 */
const pythonBin = process.env.PYTHON_BIN ?? fileURLToPath(new URL("../.venv/bin/python", import.meta.url));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const emergentMemory =
  process.env.EMERGENT_MEMORY !== "off" && process.env.LLM_API_KEY && existsSync(pythonBin)
    ? new EmergentMemory({
        python: pythonBin,
        projectRoot,
        questionsFile: fileURLToPath(
          new URL("../orgforge_kb/.cognee/questions.json", import.meta.url),
        ),
      })
    : undefined;

const app = buildApp({
  memory,
  companyAgent,
  companyAgents,
  companyKnowledge,
  conversationStore,
  logger: true,
  ...(recruiting ? { recruiting: { board: recruiting.board, gmail: recruiting.gmail } } : {}),
  ...(emergentMemory ? { emergentMemory } : {}),
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
