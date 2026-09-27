// From the black-box run against docs/ref (use cases 2, 5, 11, 14, 15).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../../src/adapters/deterministic-memory.js";
import { PostgresConversationStore } from "../../src/adapters/postgres-conversations.js";
import { buildApp } from "../../src/http-app.js";
import { recruitingExtension, statusForModel } from "../../src/recruiting/chat-tools.js";
import type { CandidateProfile } from "../../src/recruiting/domain.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel } from "../../src/recruiting/llm.js";
import { MemoryRoleRepository, RoleBoard } from "../../src/recruiting/roles.js";
import { RecruitingService } from "../../src/recruiting/service.js";
import type { CandidateSource } from "../../src/recruiting/sources.js";

function person(id: string, summary: string): CandidateProfile {
  return {
    id, name: `Person ${id}`, headline: summary, location: "Singapore",
    profileUrl: `https://www.linkedin.com/in/${id}`, workHistory: [], educationHistory: [], summary,
  };
}
const POOL = [person("a", "typescript startup rust"), person("b", "typescript startup"), person("c", "java bigco")];
const source: CandidateSource = { name: "fake", search: async () => POOL };

const drafts: Array<Record<string, unknown>> = [];
const model: JsonModel = {
  async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
    const data = input as Record<string, any>;
    switch (task) {
      case "criteria extraction":
        return { title: "Backend engineer", criteria: [{ text: "typescript", kind: "must" }, { text: "startup", kind: "must" }, { text: "rust", kind: "nice" }], queries: ["q"] } as T;
      case "criterion judgement":
        return { verdicts: data.criteria.map((c: { id: string; text: string }) => ({ criterionId: c.id, satisfied: data.profile.summary.includes(c.text) ? "yes" : "no", reasoning: "k" })) } as T;
      case "outreach draft":
        drafts.push(data);
        return { subject: "Hi", body: `Hello from ${data.founderName ?? "nobody"} at ${data.company ?? "?"}` } as T;
      case "role title":
        return { title: data.currentTitle } as T;
      default:
        throw new Error(`unscripted ${task}`);
    }
  },
};

function board() {
  return new RoleBoard(new MemoryRoleRepository(), (store) =>
    new RecruitingService({ model, source, store, memory: new LocalIntentMemory(), contactFinders: [], gmail: null, settings: { founderName: "Michael", companyName: "Acme" } }),
  );
}

async function confirmedRole() {
  const roles = board();
  const { id, service } = roles.create();
  await service.start("We need a backend engineer who knows TypeScript and has startup experience.");
  await service.confirm();
  await service.settle();
  return { roles, id, service, tools: recruitingExtension(roles) };
}

describe("conversations", () => {
  test("a conversation id that is not a UUID is simply not found, never a database error", async () => {
    const pool = { query: async () => { throw new Error('invalid input syntax for type uuid: "does-not-exist-123"'); } };
    const store = new PostgresConversationStore(pool as never);
    assert.equal(await store.get("does-not-exist-123", "jax"), null);
    assert.equal(await store.delete("does-not-exist-123", "jax"), false);
    assert.equal(await store.updateTitle("does-not-exist-123", "jax", "t"), false);
  });

  test("a pasted job description up to 8000 characters is accepted", async () => {
    const agent = { answer: async () => ({ answer: "ok", sources: [], runId: "r", toolCalls: [] }) };
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never });
    const ok = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: "a".repeat(8000) } });
    assert.equal(ok.statusCode, 200);
    const tooLong = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: "a".repeat(8001) } });
    assert.equal(tooLong.statusCode, 400);
    await app.close();
  });
});

describe("the agent can answer with numbers", () => {
  test("status carries the funnel: found, scored, in view by ring, out, contacted, replied", async () => {
    const { service } = await confirmedRole();
    const status = statusForModel(await service.snapshot());
    assert.deepEqual(status.funnel, {
      found: 3, scored: 3, pending: 0, in_view: 2, centre: 1, middle: 1, outer: 0, out: 1,
      contacted: 0, replied: 0, reply_rate: null, closed: 0, drafts_waiting: 0,
    });
  });
});

describe("criteria can be changed exactly", () => {
  test("recruiting_change_criteria makes a must a nice-to-have without a second model reading", async () => {
    const { id, service, tools } = await confirmedRole();
    const startup = (await service.snapshot()).criteria.find((c) => c.text === "startup")!;
    const outcome = await tools.run("recruiting_change_criteria", {
      role_id: id,
      changes: [{ op: "set_kind", id: startup.id, kind: "nice" }, { op: "add", text: "go", kind: "nice" }],
    });
    assert.equal(JSON.parse(outcome.content).error, undefined);
    const criteria = (await service.snapshot()).criteria;
    assert.equal(criteria.find((c) => c.id === startup.id)?.kind, "nice");
    assert.ok(criteria.some((c) => c.text === "go" && c.kind === "nice"));
  });
});

describe("drafts are signed by the person who is hiring", () => {
  test("recruiting_set_signature changes who drafts are from and redrafts the ones waiting", async () => {
    const { id, service, tools } = await confirmedRole();
    await service.prepareOutreach("a");
    assert.match((await service.snapshot()).candidates.find((c) => c.id === "a")!.draft!.body, /Michael/);
    const outcome = await tools.run("recruiting_set_signature", { role_id: id, name: "Jax", company: "a 12-person startup" });
    assert.equal(JSON.parse(outcome.content).error, undefined);
    const body = (await service.snapshot()).candidates.find((c) => c.id === "a")!.draft!.body;
    assert.match(body, /Jax/);
    assert.match(body, /12-person startup/);
  });
});
