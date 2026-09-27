/**
 * Round 2 bug hunt: hypotheses that turned out NOT to be bugs. These PASS.
 * Run: node --import tsx --test test/hunt/r2-backend-nonbugs.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CandidateProfile, HiringEvent, RecruitingState } from "../../src/recruiting/domain.js";
import type { GmailClient } from "../../src/recruiting/gmail.js";
import type { IntentMemory } from "../../src/recruiting/intent-memory.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel } from "../../src/recruiting/llm.js";
import { RecruitingService } from "../../src/recruiting/service.js";
import { canonicalProfileUrl } from "../../src/recruiting/sources.js";
import type { CandidateSource } from "../../src/recruiting/sources.js";
import { MemoryStore, type StateStore } from "../../src/recruiting/store.js";

// ------------------------------------------------------------------ fakes

const DAY = 86_400_000;

function profile(id: string, traits: string, extra: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    id,
    name: `Person ${id}`,
    headline: traits,
    location: "Singapore",
    profileUrl: `https://example.com/${id}`,
    workHistory: [{ title: "Engineer", company: `Company ${id}` }],
    educationHistory: [],
    summary: traits,
    ...extra,
  };
}

const POOL = [
  profile("a", "typescript startup rust"),
  profile("b", "typescript startup"),
  profile("c", "typescript consulting", { headline: "Principal at Quillfeather Advisory" }),
  profile("d", "typescript consulting"),
];

class FakeSource implements CandidateSource {
  readonly name = "fake";
  failNext = 0;
  constructor(public pool: CandidateProfile[] = POOL) {}
  async search(): Promise<CandidateProfile[]> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("search provider timed out");
    }
    return this.pool;
  }
  fetched: CandidateProfile[] = [];
  async fetchProfiles(): Promise<CandidateProfile[]> {
    return this.fetched;
  }
}

type Override = (input: Record<string, any>) => unknown | Promise<unknown>;

function fakeModel(overrides: Record<string, Override> = {}): JsonModel & { inputs: { task: string; input: any }[] } {
  const inputs: { task: string; input: any }[] = [];
  return {
    inputs,
    async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
      inputs.push({ task, input });
      const data = input as Record<string, any>;
      if (overrides[task]) return (await overrides[task]!(data)) as T;
      switch (task) {
        case "criteria extraction":
          return {
            title: "Founding backend engineer",
            criteria: [
              { text: "typescript", kind: "must" },
              { text: "startup", kind: "must" },
              { text: "rust", kind: "nice" },
            ],
            query: "typescript startup engineer singapore",
          } as T;
        case "criterion judgement":
          return {
            verdicts: data.criteria.map((criterion: { id: string; text: string }) => ({
              criterionId: criterion.id,
              satisfied: data.profile.summary.includes(criterion.text) ? "yes" : "no",
              reasoning: "keyword",
            })),
          } as T;
        case "reason inference":
          return { reason: "other" } as T;
        case "preference pattern":
          return { found: false } as T;
        case "search query":
          return { queries: [`typescript startup engineer singapore ${data.previous.length + 1}`] } as T;
        case "pool expansion":
          return { query: "typescript engineer remote", operations: [], rationale: "Accept remote." } as T;
        case "outreach draft":
          return { subject: `Hello ${data.candidate.name}`, body: "Short note." } as T;
        case "instruction interpretation":
          return { intent: "unknown" } as T;
        case "role title":
          return { title: data.currentTitle } as T;
        case "reply reading":
          return {
            candidateId: data.knownCandidateId,
            interested: String(data.message).includes("not interested")
              ? false
              : String(data.message).includes("yes please")
                ? true
                : null,
            wantsToSchedule: false,
            summary: "Replied.",
          } as T;
        default:
          throw new Error(`Unscripted task ${task}`);
      }
    },
  };
}

class CountingMemory implements IntentMemory {
  readonly events: HiringEvent[] = [];
  record(event: HiringEvent): void {
    this.events.push(event);
  }
  async ask(): Promise<string> {
    return "";
  }
  pending(): number {
    return 0;
  }
}

function setup(
  options: {
    model?: JsonModel;
    store?: StateStore;
    source?: FakeSource;
    gmail?: GmailClient | null;
    memory?: IntentMemory;
    onError?: (context: string, error: unknown) => void;
  } = {},
) {
  let now = new Date("2026-09-23T02:00:00.000Z");
  const model = options.model ?? fakeModel();
  const source = options.source ?? new FakeSource();
  const store = options.store ?? new MemoryStore();
  const service = new RecruitingService({
    model,
    source,
    store,
    memory: options.memory ?? new LocalIntentMemory(),
    contactFinders: [],
    gmail: options.gmail ?? null,
    clock: () => now,
    settings: { resultsPerQuery: 6 },
    ...(options.onError ? { onError: options.onError } : {}),
  });
  return {
    service,
    model,
    source,
    store,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    realNow: () => now,
  };
}

async function confirmed(options: Parameters<typeof setup>[0] = {}) {
  const context = setup(options);
  await context.service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
  await context.service.confirm();
  await context.service.settle();
  return context;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function candidateIn(service: RecruitingService, id: string) {
  return (await service.snapshot()).candidates.find((candidate) => candidate.id === id);
}

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ non-bugs

describe("r2 non-bugs", () => {
  test("send and close racing: whichever lands first wins, nothing is sent after close", async () => {
    const { service } = await confirmed();
    await service.prepareOutreach("a");
    const results = await Promise.allSettled([service.close("a", "withdrawn"), service.send("a", true)]);
    const a = (await candidateIn(service, "a"))!;
    assert.equal(a.stage, "closed");
    assert.equal(a.messages.length, 0);
    assert.equal(results[1].status, "rejected");
  });

  test("editDraft on a closed candidate is refused (the draft was dropped)", async () => {
    const { service } = await confirmed();
    await service.prepareOutreach("a");
    await service.close("a", "withdrawn");
    await assert.rejects(service.editDraft("a", { body: "x" }), /no draft/i);
  });

  test("findMore where every query fails leaves the state untouched", async () => {
    const { service, source } = await confirmed();
    const before = JSON.stringify((await service.snapshot()).rounds);
    source.failNext = 5;
    await assert.rejects(service.findMore(), /timed out/);
    assert.equal(JSON.stringify((await service.snapshot()).rounds), before);
  });

  test("findMore that returns nobody new records a round with 0 added", async () => {
    const { service } = await confirmed();
    const result = await service.findMore();
    assert.equal(result.added, 0);
  });

  test("tick with no role does nothing harmful", async () => {
    const { service } = setup();
    await service.tick();
    assert.equal((await service.snapshot()).role, null);
  });

  test("fast-forward by 30 days twice: one follow-up, not cold while the draft waits", async () => {
    const { service } = await confirmed();
    await service.prepareOutreach("a");
    await service.send("a", true);
    await service.fastForward(30);
    await service.fastForward(30);
    const a = (await candidateIn(service, "a"))!;
    assert.equal(a.stage, "contacted");
    assert.equal(a.draft?.kind, "follow_up");
    assert.equal((await service.snapshot()).clockOffsetDays, 60);
  });

  test("retention boundary: kept at exactly 30 days, erased just after", async () => {
    const { service, advance } = await confirmed();
    await service.close("d", "withdrawn");
    advance(30 * DAY);
    await service.tick();
    assert.ok(await candidateIn(service, "d"));
    advance(1);
    await service.tick();
    assert.equal(await candidateIn(service, "d"), undefined);
  });

  test("LinkedIn addresses: case, trailing slash, subdomain, and percent-encoded unicode are one person", () => {
    const forms = [
      "https://www.linkedin.com/in/Zo%C3%AB-Tan/",
      "https://sg.linkedin.com/in/zoë-tan",
      "http://linkedin.com/in/ZOË-TAN?trk=x",
    ];
    assert.equal(new Set(forms.map(canonicalProfileUrl)).size, 1);
  });

  test("a reply for a candidate erased by retention is not recorded anywhere", async () => {
    const { service, advance } = await confirmed();
    await service.close("d", "withdrawn");
    advance(31 * DAY);
    await service.tick();
    const result = await service.reply("hello", "d", "pasted");
    assert.match(result.message, /Nobody/);
  });

  test("the last criterion cannot be dropped, and the failed change leaves criteria intact", async () => {
    const { service } = await confirmed();
    const ids = (await service.snapshot()).criteria.map((criterion) => criterion.id);
    await assert.rejects(service.changeCriteria(ids.map((id) => ({ op: "remove" as const, id })), "drop all"));
    assert.equal((await service.snapshot()).criteria.length, ids.length);
  });

  test("closing drops the draft; a closed candidate cannot be sent to", async () => {
    const { service } = await confirmed();
    await service.prepareOutreach("a");
    await service.close("a", "withdrawn");
    await assert.rejects(service.send("a", true), /closed/);
  });

  test("any reply clears a pending follow-up draft", async () => {
    const { service } = await confirmed();
    await service.prepareOutreach("a");
    await service.send("a", true);
    await service.fastForward(6);
    assert.equal((await candidateIn(service, "a"))!.draft?.kind, "follow_up");
    await service.reply("hmm, maybe", "a", "pasted");
    assert.equal((await candidateIn(service, "a"))!.draft, null);
  });

  test("a large pool (2000 people) scores and snapshots correctly", async () => {
    const pool = Array.from({ length: 2000 }, (_, index) => profile(`p${index}`, "typescript startup"));
    const source = new FakeSource(pool);
    const context = setup({ source });
    await context.service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    await context.service.confirm();
    await context.service.settle();
    const snapshot = await context.service.snapshot();
    assert.equal(snapshot.candidates.length, 2000);
    assert.ok(snapshot.candidates.every((candidate) => candidate.settled));
  });
});
