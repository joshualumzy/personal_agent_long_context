/**
 * In-process fakes for the held-out recruiting acceptance suite. Nothing here
 * reaches a network service: the model, the people source, Gmail, and the
 * contact finders are all scripted.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompanyKnowledge } from "../../src/company-domain.js";
import { DeterministicMemoryProvider } from "../../src/adapters/deterministic-memory.js";
import { buildApp } from "../../src/http-app.js";
import type { ContactFinder } from "../../src/recruiting/contacts.js";
import type { CandidateProfile, ContactDetails } from "../../src/recruiting/domain.js";
import type { GmailClient } from "../../src/recruiting/gmail.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel } from "../../src/recruiting/llm.js";
import { JsonRoleRepository, MemoryRoleRepository, RoleBoard, type RoleRepository } from "../../src/recruiting/roles.js";
import { RecruitingService } from "../../src/recruiting/service.js";
import type { CandidateSource } from "../../src/recruiting/sources.js";

export const REQUIREMENT =
  "We need a founding backend engineer in Singapore who writes TypeScript, has startup experience, and ideally knows Rust.";

export function person(id: string, summary: string, url = `https://www.linkedin.com/in/${id}`): CandidateProfile {
  return {
    id,
    name: `${id[0]!.toUpperCase()}${id.slice(1)} Tan`,
    headline: `Engineer ${id}`,
    location: summary.includes("singapore") ? "Singapore" : "Elsewhere",
    profileUrl: url,
    workHistory: [{ title: "Engineer", company: `Company ${id}` }],
    educationHistory: [],
    summary,
  };
}

/**
 * The default criteria are keywords the fake judge looks for in a profile
 * summary: present means yes, "maybe-<word>" means unclear, absent means no.
 */
export const DEFAULT_CRITERIA = [
  { text: "typescript", kind: "must" },
  { text: "startup", kind: "must" },
  { text: "singapore", kind: "must" },
  { text: "rust", kind: "nice" },
];

/** Five people, one per ring and one who falls out, spread over three queries. */
export const ALPHA = [person("centre", "typescript startup singapore rust"), person("middle", "typescript startup singapore")];
export const BETA = [person("outer", "typescript startup rust"), person("unsure", "typescript maybe-startup singapore rust")];
export const GAMMA = [person("gone", "java singapore"), person("centre", "typescript startup singapore rust")];
export const REMOTE = [person("remote1", "typescript startup rust remote"), person("remote2", "typescript startup remote")];

export type Handler = (data: any) => unknown;

export function fakeModel(overrides: Record<string, Handler> = {}) {
  const calls: Array<{ task: string; input: any }> = [];
  let queryCounter = 0;
  const defaults: Record<string, Handler> = {
    "criteria extraction": () => ({
      title: "Founding backend engineer",
      criteria: DEFAULT_CRITERIA,
      excluded: [],
      queries: ["alpha typescript engineer singapore", "beta typescript startup", "gamma backend singapore"],
    }),
    "criterion judgement": (data) => ({
      verdicts: data.criteria.map((criterion: { id: string; text: string }) => {
        const summary = String(data.profile.summary);
        const word = criterion.text.toLowerCase();
        const satisfied = summary.includes(`maybe-${word}`) ? "unclear" : summary.split(/\s+/).includes(word) ? "yes" : "no";
        return { criterionId: criterion.id, satisfied, reasoning: "From the profile." };
      }),
    }),
    "search query": () => {
      queryCounter += 1;
      return { queries: [`more ${queryCounter} a`, `more ${queryCounter} b`, `more ${queryCounter} c`] };
    },
    "pool expansion": (data) => {
      const location = data.criteria.find((criterion: { text: string }) => criterion.text === "singapore");
      return {
        query: "remote typescript engineer",
        operations: location ? [{ op: "set_kind", id: location.id, kind: "nice" }] : [],
        rationale: "Accept people outside Singapore.",
      };
    },
    "outreach draft": (data) => ({
      subject: "Quick question",
      body: `Hi ${String(data.candidate?.name ?? "there").split(" ")[0]}, saw your backend work. Up for a quick call?`,
    }),
    "reason inference": (data) => ({ reason: data.statedReason ?? "unspecified trait" }),
    "preference pattern": () => ({ found: false }),
    "instruction interpretation": () => ({ intent: "unknown", summary: "" }),
    "role title": (data) => ({ title: data.currentTitle }),
    "reply reading": (data) => ({
      candidateId: data.knownCandidateId,
      interested: true,
      wantsToSchedule: false,
      summary: "Interested.",
    }),
  };
  const model: JsonModel & { calls: typeof calls } = {
    calls,
    async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
      calls.push({ task, input });
      const handler = overrides[task] ?? defaults[task];
      if (!handler) throw new Error(`Unscripted task ${task}`);
      return (await handler(input)) as T;
    },
  };
  return model;
}

export class FakeSource implements CandidateSource {
  readonly name = "fake";
  readonly queries: string[] = [];
  readonly fetched: string[][] = [];
  private extra = 0;

  constructor(private readonly respond?: (query: string) => CandidateProfile[] | undefined) {}

  async search(query: string): Promise<CandidateProfile[]> {
    this.queries.push(query);
    const scripted = this.respond?.(query);
    if (scripted) return scripted;
    if (query.startsWith("alpha")) return ALPHA;
    if (query.startsWith("beta")) return BETA;
    if (query.startsWith("gamma")) return GAMMA;
    if (query.includes("remote")) return REMOTE;
    // Any other query finds two people nobody has seen yet.
    this.extra += 1;
    return [
      person(`new${this.extra}x`, "typescript startup singapore"),
      person(`new${this.extra}y`, "typescript singapore"),
    ];
  }

  async fetchProfiles(urls: string[]): Promise<CandidateProfile[]> {
    this.fetched.push(urls);
    return urls.map((url) => {
      const handle = /\/in\/([^/?#]+)/.exec(url)![1]!;
      return person(`ref-${handle}-${this.fetched.length}`, "typescript startup singapore rust", url);
    });
  }
}

export function fakeGmail() {
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  const client = {
    async connected() {
      return true;
    },
    async send(message: { to: string; subject: string; body: string }) {
      sent.push(message);
      return { threadId: `thread-${sent.length}`, id: `m-${sent.length}` };
    },
    async repliesIn() {
      return [];
    },
    consentUrl() {
      return "https://accounts.example/consent";
    },
    async exchangeCode() {},
  } as unknown as GmailClient;
  return { sent, client };
}

export function finder(provider: ContactDetails["provider"], answer: (profile: CandidateProfile) => string | null) {
  const seen: string[] = [];
  const found: ContactFinder & { seen: string[] } = {
    provider,
    seen,
    async find(profile) {
      seen.push(profile.id);
      const email = answer(profile);
      return email ? { email, status: "verified", provider } : null;
    },
  };
  return found;
}

export interface WorldOptions {
  model?: ReturnType<typeof fakeModel>;
  source?: FakeSource;
  finders?: ContactFinder[];
  gmail?: GmailClient | null;
  repository?: RoleRepository;
}

/** A role board over fakes, with a clock the test can move. */
export function world(options: WorldOptions = {}) {
  let now = new Date("2026-09-23T02:00:00.000Z");
  const model = options.model ?? fakeModel();
  const source = options.source ?? new FakeSource();
  const memory = new LocalIntentMemory();
  const repository = options.repository ?? new MemoryRoleRepository();
  const gmail = options.gmail ?? null;
  const board = new RoleBoard(
    repository,
    (store) =>
      new RecruitingService({
        model,
        source,
        store,
        memory,
        contactFinders: options.finders ?? [],
        gmail,
        clock: () => now,
      }),
  );
  return {
    board,
    model,
    source,
    memory,
    gmail,
    advanceDays: (days: number) => (now = new Date(now.getTime() + days * 86_400_000)),
  };
}

export async function jsonWorld(options: Omit<WorldOptions, "repository"> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "holdout-roles-"));
  const roles = join(directory, "roles");
  return { directory, roles, ...world({ ...options, repository: new JsonRoleRepository(roles) }) };
}

type Service = RecruitingService;

/** Waits until background scoring and searches have finished. */
export async function idle(service: Service): Promise<void> {
  let quiet = 0;
  for (let attempt = 0; attempt < 400 && quiet < 3; attempt += 1) {
    await service.settle();
    await new Promise((resolve) => setTimeout(resolve, 2));
    quiet = (await service.snapshot()).busy ? 0 : quiet + 1;
  }
}

export async function openRole(board: RoleBoard, requirement = REQUIREMENT) {
  const { id, service } = board.create();
  const result = await service.start(requirement);
  return { roleId: id, service, result };
}

export async function confirmedRole(board: RoleBoard, requirement = REQUIREMENT) {
  const opened = await openRole(board, requirement);
  await opened.service.confirm();
  await idle(opened.service);
  return opened;
}

export async function tiersOf(service: Service): Promise<Record<string, unknown>> {
  const snapshot = await service.snapshot();
  return Object.fromEntries(
    snapshot.candidates.filter((candidate) => candidate.stage !== "closed").map((candidate) => [candidate.id, candidate.tier]),
  );
}

export async function candidateOf(service: Service, id: string) {
  const found = (await service.snapshot()).candidates.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No candidate ${id}`);
  return found;
}

export function appFor(board: RoleBoard, gmail: GmailClient | null = null) {
  return buildApp({ memory: new DeterministicMemoryProvider(), recruiting: { board, gmail } });
}

export const knowledge: CompanyKnowledge = {
  async employee() {
    return { employeeId: "founder", displayName: "Founder", currentAssignments: [] };
  },
  async search() {
    return [];
  },
  async related() {
    return [];
  },
  async sources() {
    return [];
  },
} as unknown as CompanyKnowledge;
