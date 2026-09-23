import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";
import { privateRemarksIn } from "../src/recruiting/agent.js";
import type { ContactFinder } from "../src/recruiting/contacts.js";
import type { Candidate, CandidateProfile, Criterion } from "../src/recruiting/domain.js";
import { protectedCharacteristic } from "../src/recruiting/fairness.js";
import { LocalIntentMemory } from "../src/recruiting/intent-memory.js";
import type { JsonModel } from "../src/recruiting/llm.js";
import { RecruitingService } from "../src/recruiting/service.js";
import { profileFromExaResult, type CandidateSource } from "../src/recruiting/sources.js";
import { MemoryStore } from "../src/recruiting/store.js";
import { tierOf } from "../src/recruiting/tiers.js";

function profile(id: string, traits: string, location = "Singapore"): CandidateProfile {
  return {
    id,
    name: `Person ${id}`,
    headline: traits,
    location,
    profileUrl: `https://example.com/${id}`,
    workHistory: [{ title: "Engineer", company: `Company ${id}` }],
    educationHistory: [],
    summary: traits,
  };
}

/** Six people for the first round, three more that only a wider search finds. */
const POOL = [
  profile("a", "typescript startup rust"),
  profile("b", "typescript startup"),
  profile("c", "typescript consulting"),
  profile("d", "typescript consulting"),
  profile("e", "java bigco"),
  profile("f", "typescript startup rust"),
];
const WIDER = [profile("g", "typescript startup rust remote", "Jakarta"), profile("h", "typescript remote", "Manila")];

class FakeSource implements CandidateSource {
  readonly name = "fake";
  readonly queries: string[] = [];
  async search(query: string): Promise<CandidateProfile[]> {
    this.queries.push(query);
    return query.includes("remote") ? [...WIDER, ...POOL] : POOL;
  }
}

/**
 * Judges by keyword: a criterion "typescript" is met when the profile summary
 * contains that word. Enough to drive every tier deterministically.
 */
function fakeModel(): JsonModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
      calls.push(task);
      const data = input as Record<string, any>;
      switch (task) {
        case "criteria extraction":
          return {
            title: "Founding backend engineer",
            criteria: [
              { text: "typescript", kind: "must" },
              { text: "startup", kind: "must" },
              { text: "rust", kind: "nice" },
              { text: "under 30", kind: "must" },
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
          return { reason: data.profile.summary.includes("consulting") ? "consulting only" : "other" } as T;
        case "preference pattern": {
          const consultants = data.decisions.filter((entry: { reason: string }) => entry.reason === "consulting only");
          return (
            consultants.length >= 2
              ? {
                  found: true,
                  text: "startup",
                  kind: "must",
                  rationale: "You passed on two consultants.",
                  supportingCandidateIds: consultants.map((entry: { candidateId: string }) => entry.candidateId),
                }
              : { found: false }
          ) as T;
        }
        case "search query":
          return { query: "typescript startup engineer singapore" } as T;
        case "pool expansion":
          return { query: "typescript engineer remote", operations: [], rationale: "Accept remote." } as T;
        case "outreach draft":
          return { subject: `Hello ${data.candidate.name}`, body: `Your work on ${data.matchedCriteria.join(", ")} stood out.` } as T;
        case "email guess":
          return { email: "person@example.com" } as T;
        case "instruction interpretation":
          if (String(data.said).includes("Rust is required")) {
            const rust = data.criteria.find((criterion: { text: string }) => criterion.text === "rust");
            return { intent: "criteria", operations: [{ op: "set_kind", id: rust.id, kind: "must" }] } as T;
          }
          if (String(data.said).includes("women")) {
            return { intent: "criteria", operations: [{ op: "add", text: "women only", kind: "must" }] } as T;
          }
          return { intent: "unknown" } as T;
        case "reply reading":
          return {
            candidateId: data.knownCandidateId,
            interested: !String(data.message).includes("not interested"),
            wantsToSchedule: String(data.message).includes("Tuesday"),
            summary: "Replied.",
          } as T;
        default:
          throw new Error(`Unscripted task ${task}`);
      }
    },
  };
}

function setup(options: { finders?: ContactFinder[] } = {}) {
  let now = new Date("2026-09-23T02:00:00.000Z");
  const model = fakeModel();
  const source = new FakeSource();
  const memory = new LocalIntentMemory();
  const service = new RecruitingService({
    model,
    source,
    store: new MemoryStore(),
    memory,
    contactFinders: options.finders ?? [],
    gmail: null,
    clock: () => now,
    settings: { roundSize: 6 },
  });
  return { service, model, source, memory, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

async function tiers(service: RecruitingService) {
  const snapshot = await service.snapshot();
  return Object.fromEntries(
    snapshot.candidates.filter((c) => c.stage !== "closed").map((c) => [c.id, c.tier]),
  );
}

async function confirmed() {
  const context = setup();
  await context.service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
  await context.service.confirm();
  await context.service.settle();
  return context;
}

describe("tiers", () => {
  const criteria: Criterion[] = [
    { id: "m1", text: "", kind: "must", origin: "stated", active: true, createdAt: "" },
    { id: "m2", text: "", kind: "must", origin: "stated", active: true, createdAt: "" },
    { id: "n1", text: "", kind: "nice", origin: "stated", active: true, createdAt: "" },
  ];
  const withVerdicts = (values: Record<string, "yes" | "no" | "unclear">) =>
    ({
      verdicts: Object.fromEntries(
        Object.entries(values).map(([criterionId, satisfied]) => [criterionId, { criterionId, satisfied, reasoning: "" }]),
      ),
    }) as unknown as Candidate;

  test("follow the must and nice rules", () => {
    assert.equal(tierOf(withVerdicts({ m1: "yes", m2: "yes", n1: "yes" }), criteria), 100);
    assert.equal(tierOf(withVerdicts({ m1: "yes", m2: "yes", n1: "no" }), criteria), 75);
    assert.equal(tierOf(withVerdicts({ m1: "yes", m2: "unclear", n1: "yes" }), criteria), 50);
    assert.equal(tierOf(withVerdicts({ m1: "no", m2: "no", n1: "yes" }), criteria), "out");
    assert.equal(tierOf(withVerdicts({ m1: "yes", m2: "yes" }), criteria), "pending");
  });
});

describe("fairness", () => {
  test("refuses criteria on protected characteristics and keeps job-relevant ones", () => {
    for (const text of ["under 30", "Must be male", "Singaporeans only", "no kids", "年轻"]) {
      assert.notEqual(protectedCharacteristic(text), null, text);
    }
    for (const text of ["Over 10 years of experience", "Fluent in Chinese", "Built single-page apps", "Serves Indian market"]) {
      assert.equal(protectedCharacteristic(text), null, text);
    }
  });
});

describe("recruiting flow", () => {
  test("proposes criteria without the protected one and reports the refusal", async () => {
    const { service } = setup();
    const result = await service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    assert.deepEqual(result.refused, [{ text: "under 30", characteristic: "age" }]);
    const snapshot = await service.snapshot();
    assert.deepEqual(snapshot.criteria.map((c) => c.text), ["typescript", "startup", "rust"]);
    assert.equal(snapshot.role?.confirmed, false);
    assert.equal(snapshot.candidates.length, 0);
  });

  test("confirming searches once, scores everyone, and records the intent", async () => {
    const { service, source, memory } = await confirmed();
    assert.equal(source.queries.length, 1);
    assert.deepEqual(await tiers(service), { a: 100, b: 75, c: 50, d: 50, e: "out", f: 100 });
    assert.equal(memory.events[0]?.kind, "criteria_confirmed");
  });

  test("a spoken criteria change rescores and refuses discriminatory additions", async () => {
    const { service } = await confirmed();
    const changed = await service.say("Actually Rust is required");
    assert.equal(changed.intent, "criteria");
    await service.settle();
    assert.equal((await tiers(service)).b, 50);

    const refused = await service.say("Only women please");
    assert.deepEqual(refused.refused, [{ text: "women only", characteristic: "sex or gender" }]);
    assert.equal((await service.snapshot()).criteria.some((c) => c.text === "women only"), false);
  });

  test("two passes for the same reason become a proposal that only applies once accepted", async () => {
    const { service, memory } = await confirmed();
    await service.feedback("c", "pass", "just a consultant");
    await service.feedback("d", "pass");
    await waitFor(async () => (await service.snapshot()).proposals.length === 1);

    const [proposal] = (await service.snapshot()).proposals;
    assert.equal(proposal?.type, "criterion");
    assert.equal((await service.snapshot()).criteria.filter((c) => c.origin === "inferred").length, 0);

    await service.resolveProposal(proposal!.id, true);
    await service.settle();
    const snapshot = await service.snapshot();
    assert.equal(snapshot.criteria.filter((c) => c.origin === "inferred").length, 1);
    assert.ok(memory.events.some((event) => event.kind === "preference_accepted"));
    assert.equal(snapshot.candidates.find((c) => c.id === "c")?.stage, "closed");
  });

  test("a stall proposes the next expansion step and accepting it adds a new ring", async () => {
    const { service, source } = await confirmed();
    await service.fastForward(8);
    const [proposal] = (await service.snapshot()).proposals;
    assert.equal(proposal?.type, "expansion");
    assert.equal(proposal?.type === "expansion" && proposal.stepName, "Widen location");

    await service.resolveProposal(proposal!.id, true);
    await waitFor(async () => (await service.snapshot()).rounds.length === 2);
    await service.settle();
    const snapshot = await service.snapshot();
    assert.equal(source.queries.at(-1), "typescript engineer remote");
    assert.deepEqual(
      snapshot.candidates.filter((c) => c.poolRound === 2).map((c) => c.id).sort(),
      ["g", "h"],
    );
  });

  test("outreach drafts, blocks private remarks, follows up, then goes cold", async () => {
    const { service } = await confirmed();
    await service.feedback("a", "keep", "love the Rust matching engine work");
    await service.prepareOutreach("a");
    let a = (await service.snapshot()).candidates.find((c) => c.id === "a")!;
    assert.equal(a.stage, "drafted");
    assert.deepEqual(a.contact, { email: "person@example.com", status: "unverified", provider: "guess" });
    assert.deepEqual(a.draft?.warnings, []);

    await service.editDraft("a", { body: "I love the Rust matching engine work you did." });
    await assert.rejects(service.send("a", true), /said privately/);
    await service.editDraft("a", { body: "Would you like to chat about the role?" });

    await service.send("a", true);
    a = (await service.snapshot()).candidates.find((c) => c.id === "a")!;
    assert.equal(a.stage, "contacted");

    await service.fastForward(5);
    a = (await service.snapshot()).candidates.find((c) => c.id === "a")!;
    assert.equal(a.draft?.kind, "follow_up");
    await service.send("a", true);

    await service.fastForward(7);
    a = (await service.snapshot()).candidates.find((c) => c.id === "a")!;
    assert.equal(a.stage, "closed");
    assert.equal(a.closedReason, "cold");
  });

  test("a reply moves the candidate on and drafts a scheduling message", async () => {
    const { service } = await confirmed();
    await service.prepareOutreach("b");
    await service.send("b", true);
    const result = await service.reply("Sounds good, free Tuesday afternoon", "b", "pasted");
    assert.match(result.message, /scheduling reply is drafted/);
    const b = (await service.snapshot()).candidates.find((c) => c.id === "b")!;
    assert.equal(b.stage, "replied");
    assert.equal(b.draft?.kind, "scheduling");
    await service.send("b", true);
    assert.equal((await service.snapshot()).candidates.find((c) => c.id === "b")?.stage, "scheduling");
  });

  test("closed candidates are erased after the retention period", async () => {
    const { service } = await confirmed();
    await service.feedback("e", "pass");
    await service.fastForward(30);
    await service.fastForward(1);
    assert.equal((await service.snapshot()).candidates.some((c) => c.id === "e"), false);
  });

  test("contact finders are tried in order before guessing", async () => {
    const tried: string[] = [];
    const finder = (provider: "hunter" | "prospeo", email: string | null): ContactFinder => ({
      provider,
      async find() {
        tried.push(provider);
        return email ? { email, status: "verified", provider } : null;
      },
    });
    const { service } = setup({ finders: [finder("hunter", null), finder("prospeo", "a@company.test")] });
    await service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    await service.confirm();
    await service.settle();
    await service.prepareOutreach("a");
    assert.deepEqual(tried, ["hunter", "prospeo"]);
    const a = (await service.snapshot()).candidates.find((c) => c.id === "a")!;
    assert.equal(a.contact?.provider, "prospeo");
  });
});

describe("helpers", () => {
  test("maps an Exa people result to a profile", () => {
    const mapped = profileFromExaResult({
      url: "https://www.linkedin.com/in/jane-doe",
      title: "Jane Doe - Staff Engineer at Acme",
      text: "Builds things.",
      entities: [
        {
          type: "person",
          properties: {
            name: "Jane Doe",
            location: "Singapore",
            workHistory: [
              { title: "Staff Engineer", location: null, dates: { from: "2021-01", to: null }, company: { id: "c1", name: "Acme" } },
            ],
            educationHistory: [
              { degree: "BComp", dates: null, institution: { id: "i1", name: "NUS" } },
            ],
          },
        },
      ],
    });
    assert.equal(mapped?.name, "Jane Doe");
    assert.equal(mapped?.headline, "Staff Engineer at Acme");
    assert.deepEqual(mapped?.workHistory, [{ title: "Staff Engineer", company: "Acme", from: "2021-01" }]);
    assert.deepEqual(mapped?.educationHistory, [{ degree: "BComp", institution: "NUS" }]);
  });

  test("flags a draft that repeats a private remark", () => {
    assert.deepEqual(privateRemarksIn("Your consulting background is thin", ["consulting background too thin"]), ["consulting background too thin"]);
    assert.deepEqual(privateRemarksIn("Would you like to chat?", ["consulting background too thin"]), []);
  });
});

describe("recruiting routes", () => {
  test("are served only when configured and answer with state", async () => {
    const plain = buildApp({ memory: new DeterministicMemoryProvider() });
    assert.equal((await plain.inject({ method: "GET", url: "/api/recruiting/state" })).statusCode, 404);

    const { service } = setup();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), recruiting: { service, gmail: null } });
    const page = await app.inject({ method: "GET", url: "/recruiting" });
    assert.equal(page.statusCode, 200);

    const early = await app.inject({ method: "POST", url: "/api/recruiting/confirm", payload: {} });
    assert.equal(early.statusCode, 409);

    const said = await app.inject({
      method: "POST",
      url: "/api/recruiting/say",
      payload: { text: "We need a founding backend engineer in Singapore who knows TypeScript." },
    });
    assert.equal(said.statusCode, 200);
    assert.equal(said.json().state.criteria.length, 3);

    const upload = await app.inject({
      method: "POST",
      url: "/api/recruiting/upload",
      payload: { filename: "jd.exe", contentBase64: Buffer.from("x").toString("base64") },
    });
    assert.equal(upload.json().code, "unsupported_file");
  });
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition not met in time.");
}

describe("linkedin inbox", () => {
  test("ignores conversations that mention nobody the founder contacted", async () => {
    const { service } = await confirmed();
    await service.prepareOutreach("a");
    await service.send("a", true);
    const kept = await service.relevantConversations([
      "Person a: Thanks for reaching out, happy to chat.",
      "Mum: dinner on Sunday?",
    ]);
    assert.deepEqual(kept, ["Person a: Thanks for reaching out, happy to chat."]);
  });
});

describe("adding people by link", () => {
  test("loads profiles, marks them as referrals, and scores them", async () => {
    const context = setup();
    const referral = profile("r", "typescript startup rust");
    Object.assign(context.source, { fetchProfiles: async () => [referral] });
    await context.service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    await context.service.confirm();
    await assert.rejects(context.service.importProfiles(["https://example.com/x"]), /Not a LinkedIn profile link/);
    const result = await context.service.importProfiles(["https://www.linkedin.com/in/someone/"]);
    assert.match(result.message, /Added Person r/);
    await context.service.settle();
    const added = (await context.service.snapshot()).candidates.find((c) => c.id === "r")!;
    assert.equal(added.origin, "referral");
    assert.equal(added.tier, 100);
  });
});
