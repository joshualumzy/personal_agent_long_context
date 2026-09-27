import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createSessionToken } from "../src/auth.js";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { InMemoryConversationStore } from "../src/adapters/postgres-conversations.js";
import { buildApp } from "../src/http-app.js";
import { SoCLaaSCompanyAgent } from "../src/soclaas-company-agent.js";
import type { AsOf } from "../src/as-of.js";
import type {
  CompanyKnowledge,
  CompanyQuestion,
  DayPlanEntry,
  Evidence,
  TodoItem,
} from "../src/company-domain.js";

const SECRET = "planner-test-secret-that-is-at-least-32-characters";
const DAYS = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"];

const todoItem = (itemKey: string, extra: Partial<TodoItem> = {}): TodoItem => ({
  itemKey, title: `ticket ${itemKey}`, status: "In Progress", relation: "assignee", since: "2026-01-05",
  department: "Engineering_Backend", points: 3, sprintNo: 1, reporter: "Chloe", sources: [itemKey], ...extra,
});

const planEntry = (seq: number, title: string, extra: Partial<DayPlanEntry> = {}): DayPlanEntry => ({
  seq, title, activityType: "deep_work", estHours: 2, collaborators: [], deferred: false,
  deferReason: null, itemKey: null, sources: [], ...extra,
});

const ticket = (sourceId: string, occurredAt: string): Evidence => ({
  sourceId, sourceType: "jira", title: `ticket ${sourceId}`, excerpt: "…", occurredAt,
});

/** A knowledge base that records what it was asked, with a dated view. */
function fakeKnowledge() {
  const calls: Array<{ what: string; person?: string; day?: string }> = [];
  const people: Record<string, string> = { jax: "Jax", priya: "Priya" };
  const tickets = [ticket("ENG-107", "2026-01-01T10:30:00Z"), ticket("ENG-200", "2026-03-01T10:30:00Z")];
  const base = (day?: AsOf): CompanyKnowledge => ({
    async employee(employeeId) {
      const name = people[employeeId];
      return name ? { employeeId, displayName: name, currentAssignments: [] } : null;
    },
    async search() { return []; },
    async related() { return []; },
    async sources(ids) {
      calls.push({ what: "sources", ...(day ? { day } : {}) });
      return tickets.filter((item) => ids.includes(item.sourceId) && (!day || item.occurredAt! < `${day}T24`));
    },
    async workingDays() { return DAYS; },
    async todo(person, when) {
      calls.push({ what: "todo", person, day: day && when > day ? day : when });
      return person === "Jax" ? [todoItem("ENG-107"), todoItem("ENG-200")] : [todoItem("DES-1")];
    },
    async dayPlan(person, when) {
      calls.push({ what: "day", person, day: day && when > day ? day : when });
      return [planEntry(1, "refactor titandb connection layer", { itemKey: "ENG-107", sources: ["ENG-107"] }),
        planEntry(2, "check-in with deepa", { activityType: "1on1", collaborators: ["Deepa"] })];
    },
    ...(day ? {} : { asOf: (d: AsOf) => { calls.push({ what: "asOf", day: d }); return base(d); } }),
  });
  return { knowledge: base(), calls };
}

describe("the planner routes", () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  after(async () => { for (const app of apps) await app.close(); });

  function start(companyKnowledge?: CompanyKnowledge) {
    const app = buildApp({
      memory: new DeterministicMemoryProvider(),
      sessionConfig: { secret: SECRET },
      ...(companyKnowledge ? { companyKnowledge } : {}),
    });
    apps.push(app);
    return app;
  }
  const as = (employeeId: string) => ({ authorization: `Bearer ${createSessionToken(employeeId, SECRET)}` });

  test("the to-do list is the signed-in employee's own, on the day asked for", async () => {
    const { knowledge, calls } = fakeKnowledge();
    const app = start(knowledge);
    const response = await app.inject({ url: "/api/v1/planner/todo?asOf=2026-01-06", headers: as("jax") });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.asOf, "2026-01-06");
    assert.equal(body.person, "Jax");
    assert.deepEqual(body.items.map((item: TodoItem) => item.itemKey), ["ENG-107", "ENG-200"]);
    assert.deepEqual(calls.find((call) => call.what === "todo"), { what: "todo", person: "Jax", day: "2026-01-06" });
  });

  test("the day plan comes back in plan order, and a weekend shows the Friday before", async () => {
    const { knowledge, calls } = fakeKnowledge();
    const app = start(knowledge);
    const response = await app.inject({ url: "/api/v1/planner/day?asOf=2026-01-04", headers: as("jax") });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.asOf, "2026-01-02");
    assert.equal(body.adjusted, true);
    assert.deepEqual(body.entries.map((entry: DayPlanEntry) => entry.seq), [1, 2]);
    assert.equal(calls.find((call) => call.what === "day")?.day, "2026-01-02");
  });

  test("no date means the latest working day", async () => {
    const { knowledge } = fakeKnowledge();
    const response = await start(knowledge).inject({ url: "/api/v1/planner/todo", headers: as("jax") });
    assert.equal(response.json().asOf, "2026-01-07");
  });

  test("another employee's list cannot be asked for", async () => {
    const { knowledge, calls } = fakeKnowledge();
    const app = start(knowledge);
    // Asking for someone else by id is refused outright…
    const other = await app.inject({ url: "/api/v1/planner/todo?userId=priya", headers: as("jax") });
    assert.equal(other.statusCode, 400);
    // …a person parameter is not a thing, so it changes nothing…
    const named = await app.inject({ url: "/api/v1/planner/todo?person=Priya", headers: as("jax") });
    assert.equal(named.json().person, "Jax");
    // …and without signing in there is no list at all.
    assert.equal((await app.inject({ url: "/api/v1/planner/todo" })).statusCode, 401);
    assert.ok(calls.filter((call) => call.what === "todo").every((call) => call.person === "Jax"));
  });

  test("a date outside the record is a 400, and no planner is a 503", async () => {
    const { knowledge } = fakeKnowledge();
    const app = start(knowledge);
    for (const bad of ["2025-12-31", "2026-04-11", "someday"]) {
      const response = await app.inject({ url: `/api/v1/planner/day?asOf=${bad}`, headers: as("jax") });
      assert.equal(response.statusCode, 400, bad);
    }
    const bare = start({
      async employee() { return { employeeId: "jax", displayName: "Jax", currentAssignments: [] }; },
      async search() { return []; }, async related() { return []; }, async sources() { return []; },
    });
    assert.equal((await bare.inject({ url: "/api/v1/planner/todo", headers: as("jax") })).statusCode, 503);
    assert.equal((await bare.inject({ url: "/api/v1/planner/days", headers: as("jax") })).statusCode, 503);
  });

  test("the date picker gets the working days", async () => {
    const { knowledge } = fakeKnowledge();
    const response = await start(knowledge).inject({ url: "/api/v1/planner/days", headers: as("jax") });
    assert.deepEqual(response.json(), { days: DAYS, first: "2026-01-02", last: "2026-01-07" });
  });
});

describe("chat on a chosen day", () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  after(async () => { for (const app of apps) await app.close(); });

  /** An agent that records the questions it is given. */
  function recordingAgent() {
    const asked: CompanyQuestion[] = [];
    const agent = {
      async answer(question: CompanyQuestion) {
        asked.push(question);
        return { answer: "Here is where things stood.", sources: [], runId: "run", toolCalls: [] };
      },
    } as unknown as SoCLaaSCompanyAgent;
    return { agent, asked };
  }

  function start() {
    const { knowledge } = fakeKnowledge();
    const { agent, asked } = recordingAgent();
    const memory = new DeterministicMemoryProvider();
    let memoryReads = 0;
    const read = memory.getContext.bind(memory);
    memory.getContext = async (userId: string) => { memoryReads += 1; return read(userId); };
    const conversationStore = new InMemoryConversationStore();
    const app = buildApp({
      memory, companyKnowledge: knowledge, companyAgent: agent, conversationStore,
      sessionConfig: { secret: SECRET },
    });
    apps.push(app);
    const headers = { authorization: `Bearer ${createSessionToken("jax", SECRET)}` };
    const ask = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/v1/agent/chat", headers, payload: { message: "what should I do today?", ...payload } });
    return { ask, asked, memoryReads: () => memoryReads, conversationStore };
  }

  test("the day reaches the agent and is kept with the conversation", async () => {
    const { ask, asked, conversationStore } = start();
    const first = await ask({ asOf: "2026-01-06" });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().asOf, "2026-01-06");
    assert.equal(asked[0]?.asOf, "2026-01-06");

    // A later turn keeps the conversation's day, whatever it asks for.
    const conversationId = first.json().conversationId as string;
    const second = await ask({ conversationId, asOf: "2026-01-07" });
    assert.equal(second.json().asOf, "2026-01-06");
    assert.equal(asked[1]?.asOf, "2026-01-06");
    const saved = await conversationStore.get(conversationId, "jax");
    assert.ok(saved?.messages.every((message) => message.metadata.asOf === "2026-01-06"));

    // A conversation begun without a day stays without one.
    const undated = await ask({});
    const third = await ask({ conversationId: undated.json().conversationId, asOf: "2026-01-06" });
    assert.equal(third.json().asOf, undefined);
    assert.equal(asked[3]?.asOf, undefined);
  });

  test("personal memory is left alone on a past day", async () => {
    const { ask, memoryReads } = start();
    const response = await ask({ asOf: "2026-01-05" });
    assert.equal(response.json().personalMemory.status, "unavailable");
    assert.match(response.json().personalMemory.reason, /2026-01-05/);
    assert.equal(memoryReads(), 0);
  });

  test("a day outside the record is refused before anything runs", async () => {
    const { ask, asked } = start();
    const response = await ask({ asOf: "2026-04-11" });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_as_of");
    assert.equal(asked.length, 0);
  });
});

describe("the agent's planner tools", () => {
  function scripted(calls: Array<{ name: string; args?: Record<string, unknown> }>, final: string) {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      { choices: [{ message: { content: null, tool_calls: calls.map((call, index) => ({
        id: `call-${index}`, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      })) } }] },
      { choices: [{ message: { content: final } }] },
    ];
    const fetch = async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    };
    return { fetch, requests };
  }

  test("on a chosen day every read goes through that day, and the list's tickets become citable", async () => {
    const { knowledge, calls } = fakeKnowledge();
    const { fetch, requests } = scripted([{ name: "today_todo" }, { name: "day_plan" }],
      "Finish ENG-107 first. [source:ENG-107]");
    const agent = new SoCLaaSCompanyAgent(knowledge, { apiKey: "k", fetch });
    const result = await agent.answer({ employeeId: "jax", question: "what now?", asOf: "2026-01-06" as AsOf });

    assert.deepEqual(calls.filter((call) => call.what === "asOf"), [{ what: "asOf", day: "2026-01-06" }]);
    assert.deepEqual(
      calls.filter((call) => call.what === "todo" || call.what === "day").map((call) => [call.what, call.person, call.day]),
      [["todo", "Jax", "2026-01-06"], ["day", "Jax", "2026-01-06"]],
    );
    const system = JSON.stringify((requests[0]!.messages as Array<{ content: string }>)[0]);
    assert.match(system, /Today is 2026-01-06/);
    assert.match(system, /Current company workplace date: 2026-01-06/);
    const offered = (requests[0]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
    assert.ok(offered.includes("today_todo") && offered.includes("day_plan"));

    // ENG-200 is on the list but its ticket is from March: not citable on the 6th.
    const toolResult = JSON.parse((requests[1]!.messages as Array<{ role: string; content: string }>)
      .find((message) => message.role === "tool")!.content);
    assert.equal(toolResult.date, "2026-01-06");
    assert.deepEqual(toolResult.tickets.map((row: { itemKey: string; cite: string[] }) => [row.itemKey, row.cite]),
      [["ENG-107", ["ENG-107"]], ["ENG-200", []]]);
    assert.deepEqual(result.sources.map((source) => source.sourceId), ["ENG-107"]);
  });

  test("the model may look back, never ahead", async () => {
    const { knowledge, calls } = fakeKnowledge();
    const { fetch, requests } = scripted([
      { name: "day_plan", args: { date: "2026-01-05" } },
      { name: "today_todo", args: { date: "2026-01-07" } },
    ], "Yesterday was a refactor day.");
    const agent = new SoCLaaSCompanyAgent(knowledge, { apiKey: "k", fetch });
    await agent.answer({ employeeId: "jax", question: "what did I plan yesterday?", asOf: "2026-01-06" as AsOf });

    assert.deepEqual(calls.filter((call) => call.what === "day").map((call) => call.day), ["2026-01-05"]);
    assert.equal(calls.filter((call) => call.what === "todo").length, 0);
    const refused = (requests[1]!.messages as Array<{ role: string; content: string }>)
      .filter((message) => message.role === "tool")
      .map((message) => JSON.parse(message.content) as { error?: string });
    assert.match(refused[1]!.error!, /after today/);
  });

  test("without a day the planner reads the corporate date's working day", async () => {
    const { knowledge, calls } = fakeKnowledge();
    const { fetch } = scripted([{ name: "today_todo" }], "Two tickets open.");
    const agent = new SoCLaaSCompanyAgent(knowledge, { apiKey: "k", fetch, corporateDate: "2026-01-06" });
    await agent.answer({ employeeId: "jax", question: "what is open?" });
    assert.equal(calls.filter((call) => call.what === "asOf").length, 0, "no dated view without a day");
    assert.equal(calls.find((call) => call.what === "todo")?.day, "2026-01-06");
  });

  test("without a planner the tools are not offered", async () => {
    const knowledge: CompanyKnowledge = {
      async employee() { return { employeeId: "jax", displayName: "Jax", currentAssignments: [] }; },
      async search() { return []; }, async related() { return []; }, async sources() { return []; },
    };
    const { fetch, requests } = scripted([{ name: "search_company_knowledge", args: { query: "x" } }], "Nothing found.");
    await new SoCLaaSCompanyAgent(knowledge, { apiKey: "k", fetch }).answer({ employeeId: "jax", question: "x?" });
    const offered = (requests[0]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
    assert.ok(!offered.includes("today_todo"));
  });
});
