// Round 3 backend hunt: service.ts code added since round 2 (send split, setSender,
// keep-reopens, rescoring, funnel, change_criteria). Every test here fails today.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { recruitingExtension, statusForModel } from "../../src/recruiting/chat-tools.js";
import type { CandidateProfile, RecruitingState } from "../../src/recruiting/domain.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel } from "../../src/recruiting/llm.js";
import { MemoryRoleRepository, RoleBoard } from "../../src/recruiting/roles.js";
import { RecruitingService, type RecruitingSettings } from "../../src/recruiting/service.js";
import type { CandidateSource } from "../../src/recruiting/sources.js";
import { MemoryStore, type StateStore } from "../../src/recruiting/store.js";

function person(id: string, summary: string): CandidateProfile {
  return {
    id, name: `Person ${id}`, headline: summary, location: "Singapore",
    profileUrl: `https://www.linkedin.com/in/${id}`, workHistory: [], educationHistory: [], summary,
  };
}
const POOL = [person("a", "typescript startup rust"), person("b", "typescript startup"), person("c", "java bigco")];

interface Knobs {
  judgeFails?: (profileId: string) => boolean;
  extra?: CandidateProfile[];
}

function modelWith(knobs: Knobs = {}): JsonModel {
  return {
    async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
      const data = input as Record<string, any>;
      switch (task) {
        case "criteria extraction":
          return { title: "Backend engineer", criteria: [{ text: "typescript", kind: "must" }, { text: "startup", kind: "must" }, { text: "rust", kind: "nice" }], queries: ["q"] } as T;
        case "criterion judgement":
          if (knobs.judgeFails?.(data.profile.id ?? data.profile.name)) throw new Error("HTTP 429");
          return { verdicts: data.criteria.map((c: { id: string; text: string }) => ({ criterionId: c.id, satisfied: data.profile.summary.includes(c.text) ? "yes" : "no", reasoning: "k" })) } as T;
        case "outreach draft":
          return { subject: "Hi", body: `Hello from ${data.founderName ?? "nobody"} at ${data.company ?? "?"}` } as T;
        case "role title":
          return { title: data.currentTitle } as T;
        case "reason inference":
          return { reason: "other" } as T;
        case "search query":
          return { queries: [`more ${data.previous.length}`] } as T;
        default:
          throw new Error(`unscripted ${task}`);
      }
    },
  };
}

function sourceWith(knobs: Knobs = {}): CandidateSource {
  return { name: "fake", search: async (query) => (query.startsWith("more") ? knobs.extra ?? [] : POOL) };
}

class FlakyStore implements StateStore {
  inner = new MemoryStore();
  failNextSave = false;
  async load() { return this.inner.load(); }
  async save(state: RecruitingState) {
    if (this.failNextSave) { this.failNextSave = false; throw new Error("EBUSY"); }
    await this.inner.save(state);
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A Gmail whose sends are held until the test lets them go. */
function heldGmail() {
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  const holds: Array<ReturnType<typeof deferred<{ threadId: string }>>> = [];
  let arrived = deferred();
  return {
    sent,
    holds,
    nextArrival: () => arrived.promise,
    gmail: {
      async connected() { return true; },
      async send(message: { to: string; subject: string; body: string }) {
        sent.push(message);
        const hold = deferred<{ threadId: string }>();
        holds.push(hold);
        const was = arrived;
        arrived = deferred();
        was.resolve();
        return hold.promise;
      },
      async repliesIn() { return []; },
    },
  };
}

async function confirmed(opts: { gmail?: unknown; store?: StateStore; knobs?: Knobs; settings?: Partial<RecruitingSettings> } = {}) {
  const store = opts.store ?? new MemoryStore();
  const service = new RecruitingService({
    model: modelWith(opts.knobs), source: sourceWith(opts.knobs), store, memory: new LocalIntentMemory(),
    contactFinders: [], gmail: (opts.gmail ?? null) as never,
    settings: { founderName: "Michael", companyName: "Acme", ...opts.settings },
  });
  await service.start("We need a backend engineer who knows TypeScript and has startup experience.");
  await service.confirm();
  await service.settle();
  return service;
}

const find = async (service: RecruitingService, id: string) =>
  (await service.snapshot()).candidates.find((c) => c.id === id)!;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("r3 service: send split", () => {
  test("B1 prepareOutreach replaces a draft that is being sent, so the same intro can go out twice", async () => {
    const mail = heldGmail();
    const service = await confirmed({ gmail: mail.gmail });
    await service.prepareOutreach("a");
    await service.editDraft("a", { email: "a@example.com" });
    const first = service.send("a", false);
    await mail.nextArrival();
    // While Gmail is still sending, the draft is redrafted and sent again.
    const redraft = await service.prepareOutreach("a").then(() => "replaced", (e: Error) => e.message);
    const second = service.send("a", false).then(() => "sent", (e: Error) => e.message);
    await pause(20);
    for (const hold of mail.holds) hold.resolve({ threadId: "t1" });
    await first;
    await second;
    assert.notEqual(redraft, "replaced", "a draft being sent must not be replaced");
    assert.equal(mail.sent.length, 1, "only one intro email should have gone out");
  });

  test("B2 closing a candidate while Gmail is sending is undone by the record step", async () => {
    const mail = heldGmail();
    const service = await confirmed({ gmail: mail.gmail });
    await service.prepareOutreach("a");
    await service.editDraft("a", { email: "a@example.com" });
    const sending = service.send("a", false);
    await mail.nextArrival();
    await service.close("a", "hired");
    mail.holds[0]!.resolve({ threadId: "t1" });
    await sending;
    const a = await find(service, "a");
    assert.equal(a.stage, "closed", `a hired candidate became "${a.stage}" (closedReason ${a.closedReason})`);
  });

  test("B3 a failed record after Gmail sent leaves the draft stuck in `sending` with the message and thread lost", async () => {
    const mail = heldGmail();
    const store = new FlakyStore();
    const service = await confirmed({ gmail: mail.gmail, store });
    await service.prepareOutreach("a");
    await service.editDraft("a", { email: "a@example.com" });
    const sending = service.send("a", false).catch((e: Error) => e);
    await mail.nextArrival();
    store.failNextSave = true; // the record step's save fails
    mail.holds[0]!.resolve({ threadId: "t1" });
    assert.ok((await sending) instanceof Error);
    // The founder retries, as the UI invites.
    const retry = await service.send("a", false).then(() => "ok", (e: Error) => e.message);
    const a = await find(service, "a");
    assert.equal(mail.sent.length, 1);
    assert.ok(
      a.messages.some((m) => m.direction === "outbound"),
      `sent email never recorded; retry said "${retry}", draft.sending=${a.draft?.sending}, stage=${a.stage}`,
    );
  });

  test("B4 Gmail that delivers and then errors (lost response) releases the claim, and a retry sends twice", async () => {
    const sent: string[] = [];
    let first = true;
    const gmail = {
      async connected() { return true; },
      async send(message: { body: string }) {
        sent.push(message.body);
        if (first) { first = false; throw new Error("socket hang up"); }
        return { threadId: "t" };
      },
      async repliesIn() { return []; },
    };
    const service = await confirmed({ gmail });
    await service.prepareOutreach("a");
    await service.editDraft("a", { email: "a@example.com" });
    await service.send("a", false).catch(() => undefined);
    await service.send("a", false).catch(() => undefined);
    assert.equal(sent.length, 1, "an ambiguous Gmail failure must not allow a second send");
  });

  test("B5 setSender during an in-flight send that then fails leaves the released draft on the old signature", async () => {
    const mail = heldGmail();
    const service = await confirmed({ gmail: mail.gmail });
    await service.prepareOutreach("a");
    await service.editDraft("a", { email: "a@example.com" });
    const sending = service.send("a", false).catch(() => undefined);
    await mail.nextArrival();
    const redrafted = await service.setSender({ name: "Jax" });
    mail.holds[0]!.reject(new Error("HTTP 500"));
    await sending;
    const a = await find(service, "a");
    assert.equal(redrafted, 0);
    assert.match(a.draft!.body, /Jax/, `draft waiting to be sent still says: ${a.draft!.body}`);
  });
});

describe("r3 service: setSender", () => {
  test("B6 setSender silently discards the founder's own edits to a waiting draft", async () => {
    const service = await confirmed();
    await service.prepareOutreach("a");
    await service.editDraft("a", { body: "Hi Person a, loved your Rust talk at FOSSASIA. Coffee?" });
    await service.setSender({ name: "Jax" });
    const body = (await find(service, "a")).draft!.body;
    assert.match(body, /FOSSASIA/, `the founder's edited text was replaced by: ${body}`);
  });
});

describe("r3 service: keep reopens a passed candidate", () => {
  test("B7 a reopened candidate is never scored on criteria added while they were closed", async () => {
    const service = await confirmed();
    await service.feedback("a", "pass", "not now");
    await service.changeCriteria([{ op: "add", text: "go", kind: "nice" }], "add go");
    await service.settle();
    await service.feedback("a", "keep");
    await pause(100);
    const a = await find(service, "a");
    assert.equal(a.settled, true, `a stays unscored: busy=${(await service.snapshot()).busy}, verdicts=${JSON.stringify(a.verdicts.map((v) => v?.satisfied ?? null))}`);
  });

  test("B8 keeping a contacted-then-passed candidate resets them to `scored`, so no follow-up is ever drafted", async () => {
    const service = await confirmed();
    await service.prepareOutreach("a");
    await service.send("a", true);
    assert.equal((await find(service, "a")).stage, "contacted");
    await service.feedback("a", "pass", "changed mind");
    await service.feedback("a", "keep");
    await service.fastForward(6);
    const a = await find(service, "a");
    assert.equal(a.stage, "contacted", `stage after keep is "${a.stage}"`);
    assert.equal(a.draft?.kind, "follow_up");
  });
});

describe("r3 service: rescoring", () => {
  test("B9 the rescore budget is never refilled: one unscoreable person disables retries for everyone after", async () => {
    let flaky = true;
    const knobs: Knobs = {
      // "c" can never be scored; "d" fails once (a rate limit), then works.
      judgeFails: (id) => {
        if (id === "c" && process.env.B9_CONTROL !== "1") return true;
        if (id === "d" && flaky) { flaky = false; return true; }
        return false;
      },
      extra: [person("d", "typescript startup")],
    };
    const service = await confirmed({ knobs, settings: { rescoreAfterMs: 10, rescoreAttempts: 2 } });
    await pause(150); // both rescores for "c" happen and fail
    await service.findMore(); // adds "d"; its first judgement is rate limited (findMore starts scoring itself)
    await pause(150); // a fresh failure should get its own retries
    const d = await find(service, "d");
    assert.equal(d.settled, true, "d was rate-limited once and never retried");
  });
});

describe("r3 funnel", () => {
  test("B10 funnel.pending counts closed people who will never be scored, and disagrees with counts.pending", async () => {
    const service = await confirmed();
    await service.feedback("c", "pass", "java only");
    await service.changeCriteria([{ op: "add", text: "go", kind: "nice" }], "add go");
    await service.settle();
    await pause(50);
    await service.settle();
    const status = statusForModel(await service.snapshot());
    assert.equal(status.counts.pending, 0);
    assert.equal(status.funnel.pending, status.counts.pending, `funnel says ${status.funnel.pending} still being scored, forever`);
  });
});

describe("r3 recruiting_change_criteria", () => {
  async function tooled() {
    const roles = new RoleBoard(new MemoryRoleRepository(), (store) =>
      new RecruitingService({ model: modelWith(), source: sourceWith(), store, memory: new LocalIntentMemory(), contactFinders: [], gmail: null }));
    const { id, service } = roles.create();
    await service.start("We need a backend engineer who knows TypeScript and has startup experience.");
    await service.confirm();
    await service.settle();
    return { id, service, tools: recruitingExtension(roles) };
  }

  test("B11 adding a criterion that already exists creates a duplicate that double-counts", async () => {
    const { id, service, tools } = await tooled();
    const outcome = JSON.parse((await tools.run("recruiting_change_criteria", {
      role_id: id, changes: [{ op: "add", text: "typescript", kind: "must" }],
    })).content);
    const texts = (await service.snapshot()).criteria.map((c) => c.text.toLowerCase());
    assert.equal(texts.filter((t) => t === "typescript").length, 1, `duplicate accepted: ${JSON.stringify(outcome.result ?? outcome)}`);
  });

  test("B12 an edit to empty text is dropped silently while the rest of the batch reports success", async () => {
    const { id, service, tools } = await tooled();
    const startup = (await service.snapshot()).criteria.find((c) => c.text === "startup")!;
    const outcome = JSON.parse((await tools.run("recruiting_change_criteria", {
      role_id: id, changes: [{ op: "edit", id: startup.id, text: "   " }, { op: "add", text: "go", kind: "nice" }],
    })).content);
    assert.ok(outcome.error, `no error; result: ${JSON.stringify(outcome.result)}`);
  });
});
