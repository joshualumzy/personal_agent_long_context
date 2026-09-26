import { loadEnvFile } from "node:process";
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
import { meetingsFromEnvironment } from "./meetings/config.js";
import { googleAvailability } from "./meetings/availability.js";
import { gmailContactDirectory } from "./meetings/contacts.js";

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

const gatewayUrl = (process.env.LLM_GATEWAY_URL || process.env.LM_GATEWAY_URL)?.replace(/\/$/, "");
const gatewayApiKey = process.env.LLM_GATEWAY_API_KEY || process.env.LM_GATEWAY_API_KEY;
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

let logMeetingFailure: (context: string, error: unknown) => void = () => {};
const meetings = meetingsFromEnvironment(process.env, {
  pool: companyKnowledge.pool,
  knowledge: companyKnowledge,
  answerer: companyAgent,
  contacts: recruiting?.gmail ? gmailContactDirectory(recruiting.gmail) : null,
  availability: recruiting?.gmail ? googleAvailability(recruiting.gmail) : null,
  ...(recruiting?.gmail
    ? {
        googleStatus: async () => {
          const gmail = recruiting.gmail!;
          const connected = await gmail.connected();
          return {
            connected,
            mailbox: connected && (await gmail.hasMailbox()),
            calendar: connected && (await gmail.canReadCalendar()),
          };
        },
      }
    : {}),
  // A hiring need heard in a meeting opens a new role, as the chat does.
  hiring: recruiting
    ? {
        async start(requirement: string) {
          const { id, service } = recruiting.board.create();
          try {
            return await service.start(requirement);
          } catch (error) {
            recruiting.board.forget(id);
            throw error;
          }
        },
      }
    : null,
  log: (context, error) => logMeetingFailure(context, error),
});
const app = buildApp({
  sessionConfig,
  memory,
  companyAgent,
  companyAgents,
  modelRegistry,
  companyKnowledge,
  conversationStore,
  logger: true,
  ...(recruiting ? { recruiting: { board: recruiting.board, gmail: recruiting.gmail } } : {}),
  ...(meetings ? { meetings } : {}),
});
logMeetingFailure = (context, error) =>
  app.log.error(
    { context, reason: error instanceof Error ? error.message : String(error) },
    "Meeting actions failure",
  );
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
