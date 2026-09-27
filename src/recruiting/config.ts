import { fileURLToPath } from "node:url";
import type { MemoryProvider } from "../domain.js";
import { HunterFinder, ProspeoFinder, type ContactFinder } from "./contacts.js";
import { GmailClient } from "./gmail.js";
import { LettaIntentMemory, LocalIntentMemory } from "./intent-memory.js";
import { OpenAiCompatibleModel } from "./llm.js";
import { RecruitingService } from "./service.js";
import { ExaPeopleSource, SampleSource } from "./sources.js";
import { JsonRoleRepository, RoleBoard } from "./roles.js";

type Environment = Readonly<Record<string, string | undefined>>;

const samplePath = fileURLToPath(new URL("./sample-candidates.json", import.meta.url));

function positiveInteger(environment: Environment, key: string): number | undefined {
  const value = environment[key]?.trim();
  // KEY= in .env means unset, as it does for every other key here.
  if (value === undefined || value === "") return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${key} must be a positive integer.`);
  return Number(value);
}

/**
 * Builds the recruiting service. Every outside service is optional except the
 * model: without EXA_API_KEY it serves invented sample profiles, without
 * Hunter or Prospeo keys it finds no emails, and without Google OAuth
 * credentials sending is by hand.
 */
export function recruitingFromEnvironment(
  environment: Environment,
  memory: MemoryProvider,
  log: (context: string, error: unknown) => void,
) {
  const baseUrl = environment.SOCLAAS_BASE_URL;
  const apiKey = environment.SOCLAAS_API_KEY;
  if (!baseUrl || !apiKey) return null;

  const contactFinders: ContactFinder[] = [];
  if (environment.HUNTER_API_KEY) contactFinders.push(new HunterFinder(environment.HUNTER_API_KEY));
  if (environment.PROSPEO_API_KEY) contactFinders.push(new ProspeoFinder(environment.PROSPEO_API_KEY));

  const port = environment.PORT ?? "3000";
  const gmail =
    environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET
      ? new GmailClient({
          clientId: environment.GOOGLE_CLIENT_ID,
          clientSecret: environment.GOOGLE_CLIENT_SECRET,
          redirectUri:
            environment.GOOGLE_REDIRECT_URI ??
            `http://127.0.0.1:${port}/api/recruiting/gmail/callback`,
          tokenPath: environment.GMAIL_TOKEN_PATH ?? "data/gmail-token.json",
        })
      : null;

  const intentMemory =
    environment.MEMORY_ADAPTER === "deterministic"
      ? new LocalIntentMemory()
      : new LettaIntentMemory(
          memory,
          environment.RECRUITING_USER_ID ?? "demo-user",
          (reason) => log("Sending hiring intent to Memory", new Error(reason)),
        );

  const settings = {
    ...(positiveInteger(environment, "RECRUITING_RESULTS_PER_QUERY") !== undefined
      ? { resultsPerQuery: positiveInteger(environment, "RECRUITING_RESULTS_PER_QUERY")! }
      : {}),
    ...(positiveInteger(environment, "RECRUITING_PREFERENCE_THRESHOLD") !== undefined
      ? { preferenceThreshold: positiveInteger(environment, "RECRUITING_PREFERENCE_THRESHOLD")! }
      : {}),
    ...(environment.FOUNDER_NAME ? { founderName: environment.FOUNDER_NAME } : {}),
    ...(environment.COMPANY_NAME ? { companyName: environment.COMPANY_NAME } : {}),
    ...(environment.COMPANY_PITCH ? { companyPitch: environment.COMPANY_PITCH } : {}),
  };

  const repository = new JsonRoleRepository(environment.RECRUITING_ROLES_DIR ?? "data/recruiting/roles");
  const legacyPath = environment.RECRUITING_STATE_PATH ?? "data/recruiting.json";
  const model = new OpenAiCompatibleModel({
    baseUrl,
    apiKey,
    model: environment.RECRUITING_MODEL ?? "qwen3.8:27b",
  });
  const source = environment.EXA_API_KEY
    ? new ExaPeopleSource(environment.EXA_API_KEY)
    : new SampleSource(samplePath);
  const board = new RoleBoard(repository, (store) => new RecruitingService({
    model,
    source,
    store,
    memory: intentMemory,
    contactFinders,
    gmail,
    onError: log,
    settings,
  }));
  // Earlier versions kept one role in one file; it becomes the first role here.
  const ready = repository
    .adoptLegacy(legacyPath)
    .catch((error) => log("Moving the earlier single role", error));

  return { board, gmail, ready };
}
