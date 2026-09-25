import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";
import { privateRemarksIn } from "../src/recruiting/agent.js";
import type { ContactFinder } from "../src/recruiting/contacts.js";
import type { Candidate, CandidateProfile, Criterion } from "../src/recruiting/domain.js";
import { LocalIntentMemory } from "../src/recruiting/intent-memory.js";
import type { JsonModel } from "../src/recruiting/llm.js";
import { RecruitingService } from "../src/recruiting/service.js";
import { canonicalProfileUrl, profileFromExaResult, type CandidateSource } from "../src/recruiting/sources.js";
import { MemoryStore } from "../src/recruiting/store.js";
import { JsonRoleRepository, MemoryRoleRepository, RoleBoard } from "../src/recruiting/roles.js";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tierOf } from "../src/recruiting/tiers.js";
import { recruitingExtension } from "../src/recruiting/chat-tools.js";
import { SoCLaaSCompanyAgent } from "../src/soclaas-company-agent.js";
import { loadSkills, parseSkill } from "../src/skills.js";
import type { CompanyKnowledge } from "../src/company-domain.js";

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
                  // Not an existing criterion: since round 3 a duplicate add is skipped.
                  text: "product company",
                  kind: "must",
                  rationale: "You passed on two consultants.",
                  supportingCandidateIds: consultants.map((entry: { candidateId: string }) => entry.candidateId),
                }
              : { found: false }
          ) as T;
        }
        case "search query":
          return {
            queries: [`typescript startup engineer singapore ${data.previous.length + 1}`],
          } as T;
        case "pool expansion":
          return { query: "typescript engineer remote", operations: [], rationale: "Accept remote." } as T;
        case "outreach draft":
          return { subject: `Hello ${data.candidate.name}`, body: `Your work on ${data.whyTheyFit.join(", ")} stood out.` } as T;
        case "instruction interpretation":
          if (String(data.said).includes("Rust is required")) {
            const rust = data.criteria.find((criterion: { text: string }) => criterion.text === "rust");
            return { intent: "criteria", operations: [{ op: "set_kind", id: rust.id, kind: "must" }] } as T;
          }
          if (String(data.said).includes("women")) {
            return { intent: "criteria", operations: [{ op: "add", text: "women only", kind: "must" }] } as T;
          }
          return { intent: "unknown" } as T;
        case "role title":
          return { title: data.currentTitle } as T;
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
    settings: { resultsPerQuery: 6 },
  });
  return { service, model, source, memory, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

/** Several roles over in-memory stores, sharing the same fakes. */
function boardSetup() {
  const model = fakeModel();
  const source = new FakeSource();
  const memory = new LocalIntentMemory();
  const board = new RoleBoard(
    new MemoryRoleRepository(),
    (store) =>
      new RecruitingService({
        model,
        source,
        store,
        memory,
        contactFinders: [],
        gmail: null,
        clock: () => new Date("2026-09-23T02:00:00.000Z"),
        settings: { resultsPerQuery: 6 },
      }),
  );
  return { board };
}

async function confirmedRole() {
  const { board } = boardSetup();
  const { id, service } = board.create();
  await service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
  await service.confirm();
  await service.settle();
  return { board, roleId: id, service };
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

describe("recruiting flow", () => {
  test("proposes criteria for review before searching", async () => {
    const { service } = setup();
    await service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
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

  test("a spoken criteria change rescores", async () => {
    const { service } = await confirmed();
    const changed = await service.say("Actually Rust is required");
    assert.equal(changed.intent, "criteria");
    await service.settle();
    assert.equal((await tiers(service)).b, 50);
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
    // No provider is configured, and nothing is guessed.
    assert.equal(a.contact, null);
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

  test("contact finders are tried in order, and nothing is guessed when all miss", async () => {
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

    const { service: bare } = setup({ finders: [finder("hunter", null)] });
    await bare.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    await bare.confirm();
    await bare.settle();
    await bare.prepareOutreach("a");
    assert.equal((await bare.snapshot()).candidates.find((c) => c.id === "a")!.contact, null);
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

/** Ten different people per query, so rounds overflow into the reserve. */
class WideSource implements CandidateSource {
  readonly name = "wide";
  readonly queries: string[] = [];
  async search(query: string): Promise<CandidateProfile[]> {
    this.queries.push(query);
    const tag = query.replace(/\W+/g, "").slice(-6);
    return Array.from({ length: 10 }, (_, index) => profile(`${tag}${index}`, "typescript startup rust"));
  }
}

describe("searching with several queries", () => {
  function wideSetup() {
    const source = new WideSource();
    const model = fakeModel();
    const inner = model.json.bind(model);
    // The brief drafts three queries, as the real model is asked to.
    model.json = async <T>(request: { task: string; input: unknown }) =>
      request.task === "criteria extraction"
        ? ({ ...(await inner<Record<string, unknown>>(request as never)), queries: ["q one", "q two", "q three"] } as T)
        : inner<T>(request as never);
    const service = new RecruitingService({
      model,
      source,
      store: new MemoryStore(),
      memory: new LocalIntentMemory(),
      contactFinders: [],
      gmail: null,
      clock: () => new Date("2026-09-23T02:00:00.000Z"),
      settings: { resultsPerQuery: 6 },
    });
    return { service, source };
  }

  test("a round runs every drafted query and scores everyone they return, one from each in turn", async () => {
    const { service, source } = wideSetup();
    await service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    await service.confirm();
    await service.settle();
    assert.deepEqual(source.queries, ["q one", "q two", "q three"]);
    const snapshot = await service.snapshot();
    assert.equal(snapshot.candidates.length, 30);
    assert.deepEqual(
      snapshot.candidates.map((candidate) => candidate.id).slice(0, 3),
      ["qone0", "qtwo0", "qthree0"],
    );
    assert.ok(snapshot.candidates.every((candidate) => candidate.settled), "everyone found is scored");
    assert.deepEqual(snapshot.rounds[0]!.queries, ["q one", "q two", "q three"]);
  });

  test("find more searches with new queries under the same criteria", async () => {
    const { service, source } = wideSetup();
    await service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    await service.confirm();
    await service.settle();
    const criteria = (await service.snapshot()).criteria.map((criterion) => criterion.text);

    const more = await service.findMore();
    assert.equal(more.searched.length, 1);
    assert.ok(!["q one", "q two", "q three"].includes(more.searched[0]!), "new queries, not repeats");
    assert.equal(source.queries.at(-1), more.searched[0]);
    assert.equal(more.added, 10);
    const after = await service.snapshot();
    assert.equal(after.candidates.length, 40);
    assert.deepEqual(after.criteria.map((criterion) => criterion.text), criteria);
  });

  test("people an earlier version set aside unscored are added and scored on load", async () => {
    const store = new MemoryStore();
    const { service: first } = setup();
    await first.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    await first.confirm();
    await first.settle();
    const saved = JSON.parse(JSON.stringify({ ...(await (first as any).current()), reserve: [profile("z", "typescript startup rust")] }));
    await store.save(saved);
    const service = new RecruitingService({
      model: fakeModel(),
      source: new FakeSource(),
      store,
      memory: new LocalIntentMemory(),
      contactFinders: [],
      gmail: null,
      clock: () => new Date("2026-09-23T02:00:00.000Z"),
    });
    await waitFor(async () => (await service.snapshot()).candidates.find((c) => c.id === "z")?.settled === true);
    assert.equal((await service.snapshot()).candidates.find((c) => c.id === "z")?.tier, 100);
  });
});

describe("one record per person", () => {
  test("country subdomains and www are the same LinkedIn profile", () => {
    assert.equal(
      canonicalProfileUrl("https://sg.linkedin.com/in/Tze-Jit-Kho-0a6826196/"),
      canonicalProfileUrl("https://www.linkedin.com/in/tze-jit-kho-0a6826196"),
    );
    assert.notEqual(canonicalProfileUrl("https://www.linkedin.com/in/a"), canonicalProfileUrl("https://www.linkedin.com/in/b"));
  });

  test("a duplicate saved earlier is merged into the record with more progress", async () => {
    const store = new MemoryStore();
    const { service: first } = setup();
    await first.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    await first.confirm();
    await first.settle();
    await first.feedback("a", "keep");
    const saved = JSON.parse(JSON.stringify(await (first as any).current()));
    const twin = structuredClone(saved.candidates.a);
    twin.profile.id = "a-twin";
    twin.kept = false;
    twin.profile.profileUrl = "https://sg.linkedin.com/in/person-a";
    saved.candidates.a.profile.profileUrl = "https://www.linkedin.com/in/person-a";
    saved.candidates["a-twin"] = twin;
    await store.save(saved);
    const service = new RecruitingService({
      model: fakeModel(),
      source: new FakeSource(),
      store,
      memory: new LocalIntentMemory(),
      contactFinders: [],
      gmail: null,
      clock: () => new Date("2026-09-23T02:00:00.000Z"),
    });
    const ids = (await service.snapshot()).candidates.map((candidate) => candidate.id);
    assert.ok(ids.includes("a"), "the kept record survives");
    assert.ok(!ids.includes("a-twin"));
  });
});

describe("recruiting routes", () => {
  test("are served only when configured, and each role answers with its own state", async () => {
    const plain = buildApp({ memory: new DeterministicMemoryProvider() });
    assert.equal((await plain.inject({ method: "GET", url: "/api/recruiting/roles" })).statusCode, 404);

    const { board } = boardSetup();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), recruiting: { board, gmail: null } });
    const page = await app.inject({ method: "GET", url: "/recruiting" });
    assert.equal(page.statusCode, 200);
    for (const asset of ["/recruiting/app.js", "/recruiting/styles.css"]) {
      assert.ok(page.body.includes(asset));
      assert.equal((await app.inject({ method: "GET", url: asset })).statusCode, 200);
    }
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/recruiting/roles" })).json(), { roles: [] });

    const created = await app.inject({
      method: "POST",
      url: "/api/recruiting/roles",
      payload: { text: "We need a founding backend engineer in Singapore who knows TypeScript." },
    });
    assert.equal(created.statusCode, 200);
    const { roleId } = created.json();
    assert.equal(created.json().state.criteria.length, 3);

    const second = await app.inject({
      method: "POST",
      url: "/api/recruiting/roles",
      payload: { text: "A product designer in Jakarta who has shipped a mobile app." },
    });
    const roles = (await app.inject({ method: "GET", url: "/api/recruiting/roles" })).json().roles;
    assert.equal(roles.length, 2);

    const confirmedFirst = await app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/confirm`, payload: {} });
    assert.equal(confirmedFirst.statusCode, 200);
    const secondState = await app.inject({ method: "GET", url: `/api/recruiting/roles/${second.json().roleId}/state` });
    assert.equal(secondState.json().role.confirmed, false, "confirming one role leaves the other alone");

    const upload = await app.inject({
      method: "POST",
      url: "/api/recruiting/roles",
      payload: { filename: "jd.exe", contentBase64: Buffer.from("x").toString("base64") },
    });
    assert.equal(upload.json().code, "unsupported_file");

    assert.equal((await app.inject({ method: "GET", url: "/api/recruiting/roles/nope/state" })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/recruiting/roles/..%2Fx/state" })).statusCode, 404);

    const removed = await app.inject({ method: "DELETE", url: `/api/recruiting/roles/${roleId}` });
    assert.equal(removed.json().roles.length, 1);
    assert.equal((await app.inject({ method: "GET", url: `/api/recruiting/roles/${roleId}/state` })).statusCode, 404);
  });
});

describe("role storage", () => {
  test("keeps one file per role and adopts the earlier single-role file once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roles-"));
    const legacy = join(directory, "recruiting.json");
    const { service } = setup();
    await service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    await writeFile(legacy, JSON.stringify({ ...(await service.snapshot()), candidates: {}, events: [], proposals: [], rounds: [], clockOffsetDays: 0, expansionStep: 0 }));
    const repository = new JsonRoleRepository(join(directory, "roles"));
    const adopted = await repository.adoptLegacy(legacy);
    assert.ok(adopted);
    assert.deepEqual(await repository.list(), [adopted]);
    assert.equal(await repository.adoptLegacy(legacy), null, "nothing left to adopt");
    assert.deepEqual(await readdir(directory), ["roles"]);
    assert.throws(() => repository.store("../escape"), /No such role/);
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

describe("job description files", () => {
  const expected = ["招聘：AI 工程师", "语音识别", "嵌入式项目", "（on-device ML）"];

  for (const file of ["jd-zh.pdf", "jd-zh.docx"]) {
    test(`reads Chinese text from ${file}`, async () => {
      const { readFile } = await import("node:fs/promises");
      const { textFromFile } = await import("../src/recruiting/routes.js");
      const text = await textFromFile(file, await readFile(new URL(`./fixtures/${file}`, import.meta.url)));
      for (const phrase of expected) assert.ok(text.includes(phrase), `${file} is missing "${phrase}"`);
      // No Kangxi radical look-alikes left behind by PDF fonts.
      assert.equal(/[⼀-⿟]/.test(text), false);
    });
  }
});

describe("recruiting as a chat skill", () => {
  const knowledge: CompanyKnowledge = {
    async employee() {
      return { employeeId: "jax", displayName: "Jax", currentAssignments: [] };
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
  };

  /** Plays back scripted model turns and records what each request offered. */
  function scriptedAgent(board: RoleBoard, turns: Array<Array<[string, object]> | string>) {
    const offered: string[][] = [];
    const toolReplies: string[] = [];
    const agent = new SoCLaaSCompanyAgent(knowledge, {
      apiKey: "test-key",
      skills: [parseSkill("---\nname: recruiting\ndescription: Hiring.\n---\nCall recruiting_status first.")],
      extensions: [recruitingExtension(board)],
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          tools: Array<{ function: { name: string } }>;
          messages: Array<{ role: string; content: string }>;
        };
        offered.push(body.tools.map((entry) => entry.function.name));
        const last = body.messages.at(-1);
        if (last?.role === "tool") toolReplies.push(last.content);
        const turn = turns.shift();
        const message =
          typeof turn === "string"
            ? { content: turn }
            : {
                content: null,
                tool_calls: turn!.map(([name, args], index) => ({
                  id: `call-${offered.length}-${index}`,
                  type: "function",
                  // "ROLE" stands for the role id the last tool reply named, as a model would read it.
                  function: {
                    name,
                    arguments: JSON.stringify(args).replace(
                      '"ROLE"',
                      JSON.stringify(/"role_id":"(\w+)"/.exec(toolReplies.at(-1) ?? "")?.[1] ?? "ROLE"),
                    ),
                  },
                })),
              };
        return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
      },
    });
    return { agent, offered, toolReplies };
  }

  test("the recruiting skill ships with the repository", async () => {
    const skills = await loadSkills();
    const recruiting = skills.find((skill) => skill.name === "recruiting");
    assert.ok(recruiting);
    assert.match(recruiting.description, /hire/i);
    assert.match(recruiting.body, /recruiting_status/);
  });

  test("tools load with the skill, the answer needs no company citation, and a panel is attached", async () => {
    const { board } = boardSetup();
    const { agent, offered } = scriptedAgent(board, [
      [["load_skill", { name: "recruiting" }]],
      [["recruiting_start", { requirement: "We need a founding backend engineer in Singapore who knows TypeScript." }]],
      [["show_recruiting_panel", { view: "criteria", role_id: "ROLE" }]],
      "I drafted three criteria. Check them in the panel, then confirm.",
    ]);

    const result = await agent.answer({ employeeId: "jax", question: "I need to hire a backend engineer." });

    assert.equal(offered[0]!.includes("load_skill"), true);
    assert.equal(offered[0]!.includes("recruiting_start"), false, "tools stay hidden until the skill loads");
    assert.equal(offered[1]!.includes("recruiting_start"), true);
    assert.equal(offered.flat().some((name) => /send/.test(name)), false, "no tool can send");
    assert.match(result.answer, /three criteria/);
    const [role] = await board.list();
    assert.deepEqual(result.blocks, [{ type: "recruiting", view: "criteria", roleId: role!.id }]);
    assert.equal(role!.confirmed, false);
  });

  test("a recruiting tool called before the skill is loaded is refused, not fatal", async () => {
    const { board } = boardSetup();
    const { agent, toolReplies } = scriptedAgent(board, [
      [["recruiting_status", {}]],
      [["load_skill", { name: "recruiting" }]],
      [["recruiting_status", {}]],
      "No role yet. Tell me who you need.",
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "How is hiring going?" });
    assert.match(toolReplies[0]!, /load_skill/);
    assert.match(toolReplies[2]!, /"roles":\[\]/);
    assert.match(result.answer, /No role yet/);
  });

  test("a panel for an unknown candidate is refused", async () => {
    const { board, roleId } = await confirmedRole();
    const tools = recruitingExtension(board);
    const outcome = await tools.run("show_recruiting_panel", { role_id: roleId, view: "candidate", candidate_id: "nobody" });
    assert.equal(outcome.block, undefined);
    assert.match(outcome.content, /No candidate/);
    const shown = await tools.run("show_recruiting_panel", { role_id: roleId, view: "candidate", candidate_id: "a" });
    assert.deepEqual(shown.block, { type: "recruiting", view: "candidate", roleId, candidateId: "a" });
    assert.match((await tools.run("recruiting_confirm", { role_id: "missing" })).content, /No such role/);
  });

  test("status gives the model ids and tiers, and drafting outreach sends nothing", async () => {
    const { board, roleId, service } = await confirmedRole();
    const tools = recruitingExtension(board);
    const status = JSON.parse((await tools.run("recruiting_status", {})).content).status;
    assert.equal(status.role.confirmed, true);
    assert.equal(status.candidates[0].tier, 100);
    await tools.run("recruiting_prepare_outreach", { role_id: roleId, candidate_id: "a" });
    const candidate = (await service.snapshot()).candidates.find((entry) => entry.id === "a")!;
    assert.ok(candidate.draft);
    assert.equal(candidate.messages.length, 0);
  });

  test("a second role opens beside the first, and status asks for a role once there are two", async () => {
    const { board, roleId, service } = await confirmedRole();
    const tools = recruitingExtension(board);
    const started = JSON.parse(
      (await tools.run("recruiting_start", { requirement: "A product designer in Jakarta who has shipped a mobile app." })).content,
    );
    assert.notEqual(started.role_id, roleId);
    assert.equal((await service.snapshot()).role?.confirmed, true, "the first role is untouched");
    const overview = JSON.parse((await tools.run("recruiting_status", {})).content);
    assert.equal(overview.roles.length, 2);
    assert.equal(overview.status, undefined, "with two roles the model must name one");
  });

  test("recent turns reach the model, and an empty reply gets one more try", async () => {
    const { board } = boardSetup();
    const seen: Array<Array<{ role: string; content: string | null }>> = [];
    const replies = [
      { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "load_skill", arguments: '{"name":"recruiting"}' } }] },
      { content: "" },
      { content: "Replaced. Check the criteria below." },
    ];
    const agent = new SoCLaaSCompanyAgent(knowledge, {
      apiKey: "test-key",
      model: "qwen3.8:27b",
      skills: [parseSkill("---\nname: recruiting\ndescription: Hiring.\n---\nBody.")],
      extensions: [recruitingExtension(board)],
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        seen.push(body.messages);
        assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
        return new Response(JSON.stringify({ choices: [{ message: replies.shift() }] }), { status: 200 });
      },
    });
    const result = await agent.answer({
      employeeId: "jax",
      question: "yes",
      history: [
        { role: "user", content: "Hire a designer in Jakarta." },
        { role: "assistant", content: "Replace the Founding backend engineer role?" },
      ],
    });
    assert.deepEqual(
      seen[0]!.slice(1, 3).map((message) => message.content),
      ["Hire a designer in Jakarta.", "Replace the Founding backend engineer role?"],
    );
    assert.match(result.answer, /Replaced/);
  });

  test("only the recruiting page may be framed, and only by this origin", async () => {
    const { board } = boardSetup();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), recruiting: { board, gmail: null } });
    const page = await app.inject({ method: "GET", url: "/recruiting?embed=1" });
    assert.equal(page.headers["x-frame-options"], "SAMEORIGIN");
    assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'self'/);
    const home = await app.inject({ method: "GET", url: "/" });
    assert.equal(home.headers["x-frame-options"], "DENY");
  });
});
