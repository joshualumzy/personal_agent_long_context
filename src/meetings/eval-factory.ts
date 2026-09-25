import { loadEnvFile } from "node:process";
import { PostgresCompanyKnowledge } from "../adapters/postgres-company-knowledge.js";
import { OpenAiCompatibleModel, type JsonModel } from "../recruiting/llm.js";
import { SoCLaaSCompanyAgent } from "../soclaas-company-agent.js";
import { ActionDrafter } from "./drafter.js";
import type { MeetingActions } from "./domain.js";
import { DispatchingExecutor } from "./executor.js";
import { ModelCommitmentExtractor } from "./extractor.js";
import { MeetingService } from "./service.js";
import { InMemoryMeetingStore } from "./store.js";

/**
 * The live pipeline for eval/meetings/run.ts: the real model, S1 and OrgForge
 * retrieval, but an in-memory meeting store so evaluation runs never mix with
 * demo meetings. Nothing is approved during evaluation, so the executor has no
 * email or hiring connection.
 */
export default function createMeetingActions(): MeetingActions {
  try {
    loadEnvFile();
  } catch {
    // variables may come from the shell instead
  }
  const { DATABASE_URL, SOCLAAS_API_KEY, SOCLAAS_BASE_URL } = process.env;
  if (!DATABASE_URL || !SOCLAAS_API_KEY) throw new Error("DATABASE_URL and SOCLAAS_API_KEY are required.");
  const knowledge = new PostgresCompanyKnowledge(DATABASE_URL);
  const base = new OpenAiCompatibleModel({
    baseUrl: SOCLAAS_BASE_URL ?? "https://soclaas-api.comp.nus.edu.sg/v1",
    apiKey: SOCLAAS_API_KEY,
    model: process.env.MEETINGS_MODEL ?? "qwen3.8:27b",
    timeoutMs: 90_000,
  });
  const model: JsonModel = { json: (request) => base.json({ ...request, fast: true }) };
  const answerer = new SoCLaaSCompanyAgent(knowledge, {
    apiKey: SOCLAAS_API_KEY,
    ...(SOCLAAS_BASE_URL ? { baseUrl: SOCLAAS_BASE_URL } : {}),
  });
  return new MeetingService({
    store: new InMemoryMeetingStore(),
    extractor: new ModelCommitmentExtractor(model),
    drafter: new ActionDrafter({ model, knowledge, answerer }),
    executor: new DispatchingExecutor({}),
    knowledge,
    model,
    onError: (context, error) =>
      console.error(`[meetings] ${context}: ${error instanceof Error ? error.message : String(error)}`),
  });
}
