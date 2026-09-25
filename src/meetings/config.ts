import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import type { CompanyKnowledge } from "../company-domain.js";
import { OpenAiCompatibleModel, type JsonModel } from "../recruiting/llm.js";
import { ActionDrafter } from "./drafter.js";
import type { AvailabilityChecker, ContactDirectory, EmailSender, HiringHandoff, QuestionAnswerer } from "./domain.js";
import { companyContactDirectory } from "./contacts.js";
import type { GoogleStatus } from "./routes.js";
import { DispatchingExecutor } from "./executor.js";
import { ModelCommitmentExtractor } from "./extractor.js";
import { postgresReplaySource, type ReplaySegment } from "./replay.js";
import { MeetingService } from "./service.js";
import { PostgresMeetingStore } from "./store.js";

type Environment = Readonly<Record<string, string | undefined>>;

const scenarioDirectory = fileURLToPath(new URL("./scenarios/", import.meta.url));
const SCENARIO_PREFIX = "scenario:";

interface Scenario {
  title: string;
  segments: ReplaySegment[];
}

/** Scripted demo meetings shipped with the repo, listed before OrgForge recordings. */
async function scenarios(): Promise<Map<string, Scenario>> {
  const found = new Map<string, Scenario>();
  let names: string[] = [];
  try {
    names = (await readdir(scenarioDirectory)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return found;
  }
  for (const name of names) {
    const parsed = JSON.parse(await readFile(`${scenarioDirectory}${name}`, "utf8")) as Scenario;
    if (typeof parsed.title === "string" && Array.isArray(parsed.segments)) {
      found.set(`${SCENARIO_PREFIX}${name.replace(/\.json$/, "")}`, parsed);
    }
  }
  return found;
}

export interface MeetingDependencies {
  pool: pg.Pool;
  knowledge: CompanyKnowledge;
  /** S1, for questions asked during the meeting. */
  answerer?: QuestionAnswerer;
  /** Gmail, shared with recruiting. */
  email?: EmailSender | null;
  /** The employee's mailbox, read-only, for finding a person's address a draft needs. */
  contacts?: ContactDirectory | null;
  /** The employee's calendar free/busy, read-only, for checking invites. */
  availability?: AvailabilityChecker | null;
  /** Whether Google is connected and calendar free/busy granted, for the page's connect prompt. */
  googleStatus?: () => Promise<GoogleStatus>;
  /** S3, so a hiring need heard in a meeting becomes a draft role. */
  hiring?: HiringHandoff | null;
  log: (context: string, error: unknown) => void;
}

/**
 * Builds meeting actions (S2). Returns null without SoCLaaS credentials,
 * like recruiting, so the rest of the app still starts.
 */
export function meetingsFromEnvironment(environment: Environment, deps: MeetingDependencies) {
  const baseUrl = environment.SOCLAAS_BASE_URL;
  const apiKey = environment.SOCLAAS_API_KEY;
  if (!baseUrl || !apiKey) return null;

  const base = new OpenAiCompatibleModel({
    baseUrl,
    apiKey,
    model: environment.MEETINGS_MODEL ?? environment.SOCLAAS_COMPANY_MODEL ?? "qwen3.8:27b",
    timeoutMs: 90_000,
  });
  // A meeting cannot wait minutes per turn. With thinking on, qwen3.8:27b took
  // over two minutes per extraction and timed out; with it off, about twenty
  // seconds for a whole meeting, with the same actions found.
  const model: JsonModel = { json: (request) => base.json({ ...request, fast: true }) };
  const service = new MeetingService({
    store: new PostgresMeetingStore(deps.pool),
    extractor: new ModelCommitmentExtractor(model),
    drafter: new ActionDrafter({
      model,
      knowledge: deps.knowledge,
      ...(deps.answerer ? { answerer: deps.answerer } : {}),
      contacts: deps.contacts ?? null,
      records: companyContactDirectory(deps.pool),
      availability: deps.availability ?? null,
    }),
    executor: new DispatchingExecutor({
      email: deps.email ?? null,
      hiring: deps.hiring ?? null,
      ticketRepo: environment.MEETINGS_TICKET_REPO || undefined,
      suite: environment.MEETINGS_SUITE === "microsoft" ? "microsoft" : "google",
      chat: environment.MEETINGS_CHAT === "teams" ? "teams" : "whatsapp",
    }),
    knowledge: deps.knowledge,
    model,
    onError: deps.log,
  });

  const recordings = postgresReplaySource(deps.pool);
  const replays = {
    async list() {
      const scripted = [...(await scenarios())].map(([sourceId, scenario]) => ({
        sourceId,
        title: `Demo: ${scenario.title}`,
      }));
      return [...scripted, ...(await recordings.list())];
    },
    async load(sourceId: string) {
      if (sourceId.startsWith(SCENARIO_PREFIX)) {
        const scenario = (await scenarios()).get(sourceId);
        return scenario ? { title: scenario.title, segments: scenario.segments } : null;
      }
      return recordings.load(sourceId);
    },
  };

  return { service, replays, ...(deps.googleStatus ? { googleStatus: deps.googleStatus } : {}) };
}
