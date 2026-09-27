/**
 * Round 2 bug hunt, recruiting service core. Every test asserts the CORRECT
 * behaviour; each failure demonstrates one bug.
 * Run: node --import tsx --test test/hunt/r2-backend-core.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CandidateProfile, HiringEvent, RecruitingState } from "../../src/recruiting/domain.js";
import type { GmailClient } from "../../src/recruiting/gmail.js";
import type { IntentMemory } from "../../src/recruiting/intent-memory.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel } from "../../src/recruiting/llm.js";
import { RecruitingService } from "../../src/recruiting/service.js";
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

// ------------------------------------------------------------------ bugs

describe("r2 core: unsafe candidate ids", () => {
  test("closing candidate '__proto__' is refused and does not pollute Object.prototype", async () => {
    const { service } = await confirmed();
    const proto = Object.prototype as Record<string, unknown>;
    try {
      const outcome = await service.close("__proto__", "hired").then(() => "resolved", (error) => error?.statusCode);
      const polluted = ({} as Record<string, unknown>).stage;
      assert.equal(polluted, undefined, `every object in the process now has stage=${String(polluted)}`);
      assert.equal(outcome, 404);
    } finally {
      delete proto.stage;
      delete proto.closedReason;
      delete proto.closedAt;
    }
  });
});

describe("r2 core: single-flight load", () => {
  test("a load that fails once can be retried; the rejection is not cached forever", async () => {
    let failures = 1;
    const inner = new MemoryStore();
    const store: StateStore = {
      load: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("EBUSY: resource busy");
        }
        return inner.load();
      },
      save: (state) => inner.save(state),
    };
    const { service } = setup({ store });
    await assert.rejects(service.snapshot(), /EBUSY/);
    // The disk is fine now. The role should be readable again.
    const snapshot = await service.snapshot();
    assert.equal(snapshot.role, null);
  });
});

describe("r2 core: side effects inside a transactional change", () => {
  // Retired at the S2 merge (docs/s3-bug-hunt.md): the server no longer sends email; the founder sends from their own Gmail and the page records it.
  test.skip("an email sent before a failed save is not sent a second time on retry", async () => {
    let sent = 0;
    const gmail = {
      connected: async () => true,
      send: async () => {
        sent += 1;
        return { threadId: "t1" };
      },
      hasMailbox: async () => true,
      repliesFrom: async () => [],
    } as unknown as GmailClient;
    let failSave = false;
    const inner = new MemoryStore();
    const store: StateStore = {
      load: () => inner.load(),
      save: async (state) => {
        if (failSave) {
          failSave = false;
          throw new Error("ENOSPC: no space left on device");
        }
        await inner.save(state);
      },
    };
    const { service } = await confirmed({ gmail, store });
    await service.prepareOutreach("a");
    await service.editDraft("a", { email: "a@example.com" });
    failSave = true;
    await assert.rejects(service.send("a", false), /ENOSPC/);
    // The screen still offers the same draft, so the founder presses send again.
    await service.send("a", false).catch(() => undefined);
    const a = (await candidateIn(service, "a"))!;
    const recorded = a.messages.filter((message) => message.direction === "outbound").length;
    assert.equal(sent, recorded, `Gmail delivered ${sent} emails but the record shows ${recorded}`);
  });

  test("a confirm that fails does not leave a 'criteria confirmed' event in Memory", async () => {
    const memory = new CountingMemory();
    const source = new FakeSource();
    const { service } = setup({ memory, source });
    await service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    source.failNext = 1;
    await assert.rejects(service.confirm(), /timed out/);
    assert.equal((await service.snapshot()).role?.confirmed, false);
    assert.deepEqual(
      memory.events.map((event) => event.kind),
      [],
      "Memory was told the criteria were confirmed, but the change was thrown away",
    );
  });

  test("a reply is kept even when drafting the scheduling answer fails", async () => {
    let draftsFail = false;
    const model = fakeModel({
      "outreach draft": (data) => {
        if (draftsFail) throw new Error("model overloaded");
        return { subject: `Hello ${data.candidate.name}`, body: "Short note." };
      },
    });
    const { service } = await confirmed({ model });
    await service.prepareOutreach("a");
    await service.send("a", true);
    draftsFail = true;
    await service.reply("yes please, happy to talk", "a", "pasted").catch(() => undefined);
    const a = (await candidateIn(service, "a"))!;
    assert.equal(
      a.messages.filter((message) => message.direction === "inbound").length,
      1,
      "the candidate's reply was lost",
    );
  });
});

describe("r2 core: stale work landing after the candidate moved on", () => {
  async function contactedWithGatedDrafts() {
    let gate: Promise<void> | null = null;
    const entered = deferred();
    const model = fakeModel({
      "outreach draft": async (data) => {
        if (gate) {
          entered.resolve();
          await gate;
        }
        return { subject: `Hello ${data.candidate.name}`, body: "Short note." };
      },
    });
    const context = await confirmed({ model });
    await context.service.prepareOutreach("a");
    await context.service.send("a", true);
    return {
      ...context,
      hold() {
        const release = deferred();
        gate = release.promise;
        return { entered: entered.promise, release: () => { gate = null; release.resolve(); } };
      },
    };
  }

  test("a follow-up drafted while the candidate replied is not attached to them", async () => {
    const { service, advance, hold } = await contactedWithGatedDrafts();
    advance(6 * DAY);
    const held = hold();
    const ticking = service.tick();
    await held.entered;
    await service.reply("Thanks, let me think about it", "a", "pasted");
    held.release();
    await ticking;
    const a = (await candidateIn(service, "a"))!;
    assert.equal(a.stage, "replied");
    assert.notEqual(a.draft?.kind, "follow_up", "a 'just checking in' nudge is ready to send to someone who answered");
  });

  test("a follow-up drafted while the candidate was closed is not attached to them", async () => {
    const { service, advance, hold } = await contactedWithGatedDrafts();
    advance(6 * DAY);
    const held = hold();
    const ticking = service.tick();
    await held.entered;
    await service.close("a", "withdrawn");
    held.release();
    await ticking;
    const a = (await candidateIn(service, "a"))!;
    assert.equal(a.stage, "closed");
    assert.equal(a.draft, null, "a closed candidate has a pending draft again");
  });

  test("an intro drafted while the candidate was closed is not attached to them", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const entered = deferred();
    const model = fakeModel({
      "outreach draft": async (data) => {
        entered.resolve();
        await gate;
        return { subject: `Hello ${data.candidate.name}`, body: "Short note." };
      },
    });
    const { service } = await confirmed({ model });
    const preparing = service.prepareOutreach("b");
    await entered.promise;
    await service.feedback("b", "pass", "not senior enough");
    release();
    await preparing.catch(() => undefined);
    const b = (await candidateIn(service, "b"))!;
    assert.equal(b.stage, "closed");
    assert.equal(b.draft, null, "a passed candidate has a pending intro draft");
  });
});

describe("r2 core: replies to closed candidates", () => {
  test("a pasted reply does not silently un-hire a hired candidate", async () => {
    const { service } = await confirmed();
    await service.prepareOutreach("a");
    await service.send("a", true);
    await service.close("a", "hired");
    await service.reply("See you on Monday!", "a", "pasted");
    const a = (await candidateIn(service, "a"))!;
    assert.ok(
      a.stage === "closed" || a.closedReason === null,
      `stage is ${a.stage} while closedReason is still ${a.closedReason}`,
    );
  });
});

describe("r2 core: Gmail and the simulated clock", () => {
  test("a Gmail reply is read after the founder used fast-forward and sent a follow-up", async () => {
    const sentAt: string[] = [];
    let replyAt: string | null = null;
    const gmail = {
      connected: async () => true,
      send: async () => {
        sentAt.push(new Date().toISOString());
        return { threadId: "t1" };
      },
      hasMailbox: async () => true,
      // Same filter as the real client: only messages strictly after `since`.
      repliesFrom: async (_address: string, since: string) =>
        replyAt && Date.parse(replyAt) > Date.parse(since) ? [{ from: "a@x.com", at: replyAt, text: "Sure, keen." }] : [],
    } as unknown as GmailClient;
    const { service, realNow } = await confirmed({ gmail });
    await service.prepareOutreach("a");
    await service.editDraft("a", { email: "a@example.com" });
    await service.send("a", false);
    await service.fastForward(5); // demo control: a follow-up is drafted
    const a = (await candidateIn(service, "a"))!;
    assert.equal(a.draft?.kind, "follow_up");
    await service.send("a", false);
    // The candidate answers an hour later in real time.
    replyAt = new Date(realNow().getTime() + 3_600_000).toISOString();
    const read = await service.syncGmail();
    assert.equal(read, 1, "the real reply is older than the simulated timestamp of the follow-up, so it is never read");
  });

  test("one Gmail thread that fails does not stop replies in other threads from being read", async () => {
    const gmail = {
      connected: async () => true,
      send: async (message: { to: string }) => ({ threadId: message.to.startsWith("a") ? "ta" : "tb" }),
      hasMailbox: async () => true,
      // Read by sender since the S2 merge: one person's failure must not stop the others.
      repliesFrom: async (address: string) => {
        if (address.startsWith("a")) throw new Error("Gmail request failed with HTTP 404.");
        return [{ from: "b@x.com", at: "2026-09-24T00:00:00.000Z", text: "Happy to chat" }];
      },
    } as unknown as GmailClient;
    const { service } = await confirmed({ gmail });
    for (const id of ["a", "b"]) {
      await service.prepareOutreach(id);
      await service.editDraft(id, { email: `${id}@example.com` });
      await service.send(id, false);
    }
    await service.syncGmail().catch(() => undefined);
    const b = (await candidateIn(service, "b"))!;
    assert.equal(b.messages.filter((m) => m.direction === "inbound").length, 1, "b's reply was never read");
  });
});

describe("r2 core: retention", () => {
  test("an erased candidate leaves no profile text behind in the saved state", async () => {
    const memory = new CountingMemory();
    const { service, store, advance } = await confirmed({ memory });
    await service.feedback("c", "pass", "only consulting");
    advance(31 * DAY);
    await service.tick();
    const saved = (await store.load()) as RecruitingState;
    assert.equal(saved.candidates.c, undefined, "retention should have erased c");
    const headline = "Quillfeather Advisory";
    assert.ok(!JSON.stringify(saved).includes(headline), "c's headline survives in the saved events");
    assert.ok(
      !memory.events.some((event) => event.summary.includes(headline)),
      "c's headline was sent to the founder's Memory",
    );
  });
});

describe("r2 core: input size", () => {
  test("what the founder says to a confirmed role is capped before it reaches the model", async () => {
    const model = fakeModel();
    const { service } = await confirmed({ model });
    await service.say("x".repeat(200_000));
    const interpretation = model.inputs.find((entry) => entry.task === "instruction interpretation")!;
    assert.ok(
      String(interpretation.input.said).length <= 8000,
      `the model received ${String(interpretation.input.said).length} characters`,
    );
  });
});

describe("r2 core: profile addresses", () => {
  test("a profile URL with a broken percent escape does not break the whole search round", async () => {
    const source = new FakeSource([
      ...POOL,
      profile("z", "typescript startup", { profileUrl: "https://www.linkedin.com/in/zoe-tan-%E0%A4" }),
    ]);
    const { service } = setup({ source });
    await service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    await service.confirm();
    await service.settle();
    assert.equal((await service.snapshot()).candidates.length, 5);
  });

  test("importing two links to one person reports that person once", async () => {
    const { service, source } = await confirmed();
    const zoe = profile("zoe", "typescript", { name: "Zoe Tan", profileUrl: "https://www.linkedin.com/in/zoetan" });
    source.fetched = [zoe, { ...zoe, profileUrl: "https://sg.linkedin.com/in/ZoeTan/" }];
    const result = await service.importProfiles([
      "https://www.linkedin.com/in/zoetan",
      "https://sg.linkedin.com/in/ZoeTan/",
    ]);
    assert.equal(result.message, "Added Zoe Tan. Scoring now.");
  });
});

describe("r2 core: disposal", () => {
  test("scoring that finishes after the role is deleted does not report an error", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let gated = false;
    const errors: string[] = [];
    const model = fakeModel({
      "criterion judgement": async (data) => {
        if (gated) await gate;
        return {
          verdicts: data.criteria.map((criterion: { id: string }) => ({
            criterionId: criterion.id,
            satisfied: "yes",
            reasoning: "x",
          })),
        };
      },
    });
    const { service } = setup({ model, onError: (context) => errors.push(context) });
    await service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    gated = true;
    await service.confirm();
    await pause();
    await service.dispose();
    release();
    await pause(50);
    assert.deepEqual(errors, [], "a deleted role logged scoring failures");
  });
});
