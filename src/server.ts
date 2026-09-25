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
import { meetingsFromEnvironment } from "./meetings/config.js";
import { googleAvailability } from "./meetings/availability.js";
import { gmailContactDirectory } from "./meetings/contacts.js";

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
const companyAgent = new SoCLaaSCompanyAgent(companyKnowledge, {
  apiKey: soCLaaSApiKey,
  baseUrl: process.env.SOCLAAS_BASE_URL,
  model: process.env.SOCLAAS_COMPANY_MODEL,
});

const memory = memoryProviderFromEnvironment();
let logRecruitingFailure: (context: string, error: unknown) => void = () => {};
const recruiting = recruitingFromEnvironment(process.env, memory, (context, error) =>
  logRecruitingFailure(context, error),
);
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
  hiring: recruiting?.service ?? null,
  log: (context, error) => logMeetingFailure(context, error),
});
const app = buildApp({
  memory,
  companyAgent,
  companyKnowledge,
  conversationStore,
  logger: true,
  ...(recruiting ? { recruiting } : {}),
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
