import { HomeSummarizer } from "./home-summary.js";
import { OpenAiCompatibleModel } from "./recruiting/llm.js";
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
import { roleStarterFor } from "./recruiting/roles.js";
import { GapHiring, JsonGapLedger } from "./gap-hiring.js";
import { loadSkills } from "./skills.js";
import { PostgresCompanyKnowledge } from "./adapters/postgres-company-knowledge.js";
import { PostgresConversationStore } from "./adapters/postgres-conversations.js";
import { SoCLaaSCompanyAgent } from "./soclaas-company-agent.js";
import { embeddingProviderFromEnvironment } from "./embeddings.js";
import { EmergentMemory } from "./emergent-memory.js";
import { meetingsFromEnvironment } from "./meetings/config.js";
import { googleAvailability } from "./meetings/availability.js";
import { gmailContactDirectory } from "./meetings/contacts.js";
import { localWhisper } from "./meetings/speech.js";
import { QuickMeetingAnswerer } from "./meetings/quick-answer.js";

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

// Hiring proposals from knowledge gaps: shared by the routes and the agent's
// tools, so a role opened in either is seen by both.
const gapHiring = new GapHiring(
  companyKnowledge,
  new JsonGapLedger(process.env.GAP_PROPOSALS_PATH ?? "data/gap-proposals.json"),
  recruiting ? roleStarterFor(recruiting.board) : undefined,
);

const companyAgent = new SoCLaaSCompanyAgent(companyKnowledge, {
  apiKey: soCLaaSApiKey,
  baseUrl: process.env.SOCLAAS_BASE_URL,
  model: process.env.SOCLAAS_COMPANY_MODEL,
  gapHiring,
  ...agentSkills,
});

// Answers during a meeting: the question itself is the search, then one
// streamed call writes a short answer. The room is waiting, so this skips the
// chat agent's planning step and its skills.
const meetingAnswerer = new QuickMeetingAnswerer(companyKnowledge, {
  apiKey: soCLaaSApiKey,
  baseUrl: process.env.SOCLAAS_BASE_URL ?? "https://soclaas-api.comp.nus.edu.sg/v1",
  name: process.env.SOCLAAS_COMPANY_MODEL ?? "qwen3.8:27b",
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
        gapHiring,
        ...agentSkills,
      })
    : null;

import { createDefaultModelRegistry } from "./model-registry.js";

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

const modelRegistry = createDefaultModelRegistry({
  companyAgent,
  companyAgents,
  env: process.env,
});

let logMeetingFailure: (context: string, error: unknown) => void = () => {};
const meetings = meetingsFromEnvironment(process.env, {
  pool: companyKnowledge.pool,
  knowledge: companyKnowledge,
  answerer: meetingAnswerer,
  // After the quick answer, the full company agent searches further for the same card.
  deepAnswerer: new SoCLaaSCompanyAgent(companyKnowledge, {
    apiKey: soCLaaSApiKey,
    baseUrl: process.env.SOCLAAS_BASE_URL,
    model: process.env.SOCLAAS_COMPANY_MODEL,
  }),
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
  log: (context, error) => logMeetingFailure(context, error),
});
// The line under the home's headline: a short job, so the model runs without its thinking phase.
const homeSummarizer =
  process.env.SOCLAAS_BASE_URL && process.env.SOCLAAS_API_KEY
    ? new HomeSummarizer(
        new OpenAiCompatibleModel({
          baseUrl: process.env.SOCLAAS_BASE_URL,
          apiKey: process.env.SOCLAAS_API_KEY,
          model: process.env.HOME_SUMMARY_MODEL ?? process.env.SOCLAAS_COMPANY_MODEL ?? "qwen3.8:27b",
          timeoutMs: 20_000,
        }),
      )
    : undefined;

const app = buildApp({
  sessionConfig,
  ...(homeSummarizer ? { homeSummarizer } : {}),
  memory,
  companyAgent,
  companyAgents,
  modelRegistry,
  companyKnowledge,
  conversationStore,
  gapHiring,
  logger: true,
  ...(recruiting ? { recruiting: { board: recruiting.board, gmail: recruiting.gmail } } : {}),
  ...(emergentMemory ? { emergentMemory } : {}),
  ...(meetings
    ? {
        meetings: {
          ...meetings,
          transcribe: localWhisper(),
          // With a Doubao key the page streams audio for live recognition;
          // without one it records clips for the local models.
          ...(process.env.VOLC_ASR_API_KEY
            ? {
                liveAsr: {
                  apiKey: process.env.VOLC_ASR_API_KEY,
                  resourceId: process.env.VOLC_ASR_RESOURCE_ID ?? "volc.seedasr.sauc.duration",
                },
              }
            : {}),
        },
      }
    : {}),
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
