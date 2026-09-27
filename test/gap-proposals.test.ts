import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createSessionToken } from "../src/auth.js";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";
import type { AsOf } from "../src/as-of.js";
import type { CompanyKnowledge, Evidence } from "../src/company-domain.js";
import type { DomainHealth } from "../src/domain-health.js";
import { GapHiring, MemoryGapLedger } from "../src/gap-hiring.js";
import { LocalIntentMemory } from "../src/recruiting/intent-memory.js";
import type { JsonModel } from "../src/recruiting/llm.js";
import { MemoryRoleRepository, RoleBoard, roleStarterFor } from "../src/recruiting/roles.js";
import { RecruitingService } from "../src/recruiting/service.js";
import type { CandidateProfile } from "../src/recruiting/domain.js";
import { SoCLaaSCompanyAgent } from "../src/soclaas-company-agent.js";

const SECRET = "gap-proposals-test-secret-at-least-32-characters";
/** Thirty-one days from 2026-01-01, so the thin rule has a full window. */
const DAYS = Array.from({ length: 31 }, (_, index) => new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10));
const LAST = DAYS.at(-1)!;

function health(domain: string, extra: Partial<DomainHealth> = {}): DomainHealth {
  return {
    domain, name: domain, department: "Engineering_Backend", owner: "Owner", ownerSince: null, ownerActive: true,
    ownerLeftOn: null, ownerLoad: 1, activeContributors30d: ["A", "B", "C", "D", "E", "F", "G", "H"], incidents30d: [],
    pages30d: 10, evidence: { contributors: [`CONF-${domain}`], incidents: [] }, ...extra,
  };
}

/** Morgan's two domains: kubernetes-deploy loses its owner from 01-20; terraform-infra is thin throughout. */
function fakeKnowledge(): CompanyKnowledge {
  const evidence: Evidence[] = [
    { sourceId: "CONF-kubernetes-deploy", sourceType: "confluence", title: "k8s runbook", excerpt: "…", occurredAt: "2026-01-02T09:00:00Z" },
    { sourceId: "CONF-terraform-infra", sourceType: "confluence", title: "terraform notes", excerpt: "…", occurredAt: "2026-01-03T09:00:00Z" },
  ];
  const knowledge: CompanyKnowledge = {
    async employee(id) { return { employeeId: id, displayName: id === "jax" ? "Jax" : id, currentAssignments: [] }; },
    async search() { return []; }, async related() { return []; },
    async sources(ids) { return evidence.filter((item) => ids.includes(item.sourceId)); },
    async workingDays() { return DAYS; },
    asOf() { return knowledge; },
    async domainHealth(day) {
      return [
        health("kubernetes-deploy", day >= "2026-01-20"
          ? { owner: "Morgan", ownerActive: false, ownerLeftOn: "2026-01-20" } : { owner: "Morgan" }),
        health("terraform-infra", { owner: "Priya", activeContributors30d: ["Priya"] }),
        ...["a", "b", "c"].map((name) => health(name)),
      ];
    },
  };
  return knowledge;
}

function fakeModel(): JsonModel & { tasks: string[] } {
  const tasks: string[] = [];
  return {
    tasks,
    async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
      tasks.push(task);
      if (task === "criteria extraction") {
        const requirement = String((input as { requirement?: string }).requirement ?? JSON.stringify(input));
        return {
          title: /kubernetes/.test(requirement) ? "Backend engineer, kubernetes-deploy" : "Backend engineer",
          criteria: [{ text: "kubernetes in production", kind: "must" }, { text: "terraform", kind: "nice" }],
          query: "kubernetes engineer",
        } as T;
      }
      throw new Error(`the test model was asked to ${task}`);
    },
  };
}

function recruiting() {
  const model = fakeModel();
  const searched: string[] = [];
  const board = new RoleBoard(new MemoryRoleRepository(), (store) => new RecruitingService({
    model,
    source: { name: "fake", async search(query: string): Promise<CandidateProfile[]> { searched.push(query); return []; } },
    store, memory: new LocalIntentMemory(), contactFinders: [], gmail: null,
    clock: () => new Date("2026-09-28T02:00:00.000Z"),
  }));
  return { board, model, searched };
}

describe("hiring proposals, as people act on them", () => {
  test("lists what is open on a day, with reasons and a suggested role", async () => {
    const gaps = new GapHiring(fakeKnowledge(), new MemoryGapLedger());
    const early = await gaps.list("2026-01-19" as AsOf);
    assert.deepEqual(early.map((p) => p.id), [], "nothing is orphaned yet and the window is not full");
    const later = await gaps.list(LAST as AsOf);
    assert.deepEqual(later.map((p) => [p.id, p.status]), [
      ["kubernetes-deploy@2026-01-21", "open"],
      ["terraform-infra@2026-01-30", "open"],
    ]);
    assert.equal(later[0]!.suggestedTitle, "Backend engineer to own kubernetes-deploy");
  });

  test("opening a role starts a draft with the proposal as its origin, and searches and sends nothing", async () => {
    const { board, model, searched } = recruiting();
    const ledger = new MemoryGapLedger();
    const gaps = new GapHiring(fakeKnowledge(), ledger, roleStarterFor(board));
    const role = await gaps.openRole("kubernetes-deploy@2026-01-21", LAST as AsOf, "jax");

    const service = await board.get(role.roleId);
    const snapshot = await service.snapshot();
    assert.equal(snapshot.role?.confirmed, false, "the criteria wait for a person");
    assert.equal(snapshot.role?.origin?.kind, "knowledge_gap");
    assert.equal(snapshot.role?.origin?.proposalId, "kubernetes-deploy@2026-01-21");
    assert.match(snapshot.role?.origin?.reasons[0] ?? "", /Morgan, who owned kubernetes-deploy, left on 2026-01-20/);
    assert.match(snapshot.role?.requirement ?? "", /own kubernetes-deploy/);
    assert.deepEqual(model.tasks, ["criteria extraction"]);
    assert.deepEqual(searched, [], "no search runs before the criteria are confirmed");
    assert.equal(snapshot.candidates.length, 0);

    const listed = await gaps.list(LAST as AsOf);
    assert.deepEqual(listed.find((p) => p.domain === "kubernetes-deploy"), { ...listed.find((p) => p.domain === "kubernetes-deploy")!, status: "role_opened", roleId: role.roleId });
    await assert.rejects(gaps.openRole("kubernetes-deploy@2026-01-21", LAST as AsOf, "jax"), /already open/);
    assert.equal((await ledger.all()).length, 1);
  });

  test("a dismissed proposal says so, and a deleted role frees its domain again", async () => {
    const { board } = recruiting();
    const gaps = new GapHiring(fakeKnowledge(), new MemoryGapLedger(), roleStarterFor(board));
    await gaps.dismiss("terraform-infra@2026-01-30", LAST as AsOf, "jax", "Priya has it");
    assert.equal((await gaps.list(LAST as AsOf)).find((p) => p.domain === "terraform-infra")?.status, "dismissed");
    await assert.rejects(gaps.openRole("terraform-infra@2026-01-30", LAST as AsOf, "jax"), /dismissed/);

    const role = await gaps.openRole("kubernetes-deploy@2026-01-21", LAST as AsOf, "jax");
    await board.remove(role.roleId);
    assert.equal((await gaps.list(LAST as AsOf)).find((p) => p.domain === "kubernetes-deploy")?.status, "open");
  });

  test("a proposal that is not open on the day cannot be acted on", async () => {
    const gaps = new GapHiring(fakeKnowledge(), new MemoryGapLedger(), roleStarterFor(recruiting().board));
    await assert.rejects(gaps.openRole("kubernetes-deploy@2026-01-21", "2026-01-15" as AsOf, "jax"), /no open proposal/);
    await assert.rejects(gaps.dismiss("nope@2026-01-01", LAST as AsOf, "jax"), /no open proposal/);
  });
});

describe("the proposal routes", () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  after(async () => { for (const app of apps) await app.close(); });
  const headers = { authorization: `Bearer ${createSessionToken("jax", SECRET)}` };

  function start(withRecruiting = true) {
    const { board } = recruiting();
    const app = buildApp({
      memory: new DeterministicMemoryProvider(), companyKnowledge: fakeKnowledge(), sessionConfig: { secret: SECRET },
      ...(withRecruiting ? { recruiting: { board, gmail: null } } : {}),
    });
    apps.push(app);
    return { app, board };
  }

  test("any signed-in employee lists, opens and dismisses", async () => {
    const { app, board } = start();
    const list = await app.inject({ url: `/api/v1/gaps/proposals?asOf=${LAST}`, headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().canOpenRoles, true);
    assert.equal(list.json().proposals.length, 2);

    const opened = await app.inject({ method: "POST", url: "/api/v1/gaps/proposals/kubernetes-deploy@2026-01-21/open-role", headers, payload: { asOf: LAST } });
    assert.equal(opened.statusCode, 201);
    assert.ok((await board.list()).some((role) => role.id === opened.json().roleId && !role.confirmed));
    const again = await app.inject({ method: "POST", url: "/api/v1/gaps/proposals/kubernetes-deploy@2026-01-21/open-role", headers, payload: { asOf: LAST } });
    assert.equal(again.statusCode, 409);

    const dismissed = await app.inject({ method: "POST", url: "/api/v1/gaps/proposals/terraform-infra@2026-01-30/dismiss", headers, payload: { asOf: LAST, reason: "covered" } });
    assert.equal(dismissed.statusCode, 204);
    const missing = await app.inject({ method: "POST", url: "/api/v1/gaps/proposals/nope/dismiss", headers, payload: {} });
    assert.equal(missing.statusCode, 404);
    assert.equal((await app.inject({ url: "/api/v1/gaps/proposals" })).statusCode, 401);
  });

  test("without recruiting, proposals are listed but no role can be opened", async () => {
    const { app } = start(false);
    const list = await app.inject({ url: `/api/v1/gaps/proposals?asOf=${LAST}`, headers });
    assert.equal(list.json().canOpenRoles, false);
    const opened = await app.inject({ method: "POST", url: "/api/v1/gaps/proposals/kubernetes-deploy@2026-01-21/open-role", headers, payload: { asOf: LAST } });
    assert.equal(opened.statusCode, 503);
  });
});

describe("the agent's proposal tools", () => {
  function scripted(calls: Array<{ name: string; args?: Record<string, unknown> }>, final: string) {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      { choices: [{ message: { content: null, tool_calls: calls.map((call, index) => ({
        id: `call-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      })) } }] },
      { choices: [{ message: { content: final } }] },
    ];
    const fetch = async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    };
    return { fetch, requests };
  }
  const toolResults = (request: Record<string, unknown>) =>
    (request.messages as Array<{ role: string; content: string }>).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
  const offered = (request: Record<string, unknown>) =>
    (request.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);

  test("reads proposals as of the question's day, and their evidence becomes citable", async () => {
    const gaps = new GapHiring(fakeKnowledge(), new MemoryGapLedger());
    const { fetch, requests } = scripted([{ name: "hiring_proposals" }], "We are thin on terraform-infra [source:CONF-terraform-infra].");
    const agent = new SoCLaaSCompanyAgent(fakeKnowledge(), { apiKey: "k", fetch, gapHiring: gaps, corporateDate: LAST });
    const answer = await agent.answer({ employeeId: "jax", question: "我们缺什么人？" });

    assert.ok(offered(requests[0]!).includes("hiring_proposals"));
    assert.ok(!offered(requests[0]!).includes("open_role_from_gap"), "no recruiting, no opening");
    const result = toolResults(requests[1]!)[0];
    assert.equal(result.date, LAST);
    assert.deepEqual(result.proposals.map((p: { id: string }) => p.id), ["kubernetes-deploy@2026-01-21", "terraform-infra@2026-01-30"]);
    assert.deepEqual(result.proposals[1].cite, ["CONF-terraform-infra"]);
    assert.deepEqual(answer.sources.map((source) => source.sourceId), ["CONF-terraform-infra"]);
  });

  test("opens a role only through open_role_from_gap, keeping the proposal as its origin", async () => {
    const { board, searched } = recruiting();
    const gaps = new GapHiring(fakeKnowledge(), new MemoryGapLedger(), roleStarterFor(board));
    const { fetch, requests } = scripted([{ name: "open_role_from_gap", args: { proposal_id: "kubernetes-deploy@2026-01-21" } }],
      "I opened a draft role; confirm its criteria in recruiting.");
    const agent = new SoCLaaSCompanyAgent(fakeKnowledge(), { apiKey: "k", fetch, gapHiring: gaps, corporateDate: LAST });
    await agent.answer({ employeeId: "jax", question: "Open a role for the kubernetes-deploy gap." });

    assert.ok(offered(requests[0]!).includes("open_role_from_gap"));
    const result = toolResults(requests[1]!)[0];
    assert.equal(result.opened, true);
    const snapshot = await (await board.get(result.roleId)).snapshot();
    assert.equal(snapshot.role?.origin?.proposalId, "kubernetes-deploy@2026-01-21");
    assert.equal(snapshot.role?.confirmed, false);
    assert.deepEqual(searched, []);
  });
});
