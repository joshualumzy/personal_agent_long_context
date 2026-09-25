// Round 2 hunt: the chat agent's tool loop. Each "BUG" test fails today; "NOT A BUG" tests pass.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentExtension } from "../../src/agent-extension.js";
import type { CompanyKnowledge, Evidence } from "../../src/company-domain.js";
import { parseSkill } from "../../src/skills.js";
import { SoCLaaSCompanyAgent, type SoCLaaSCompanyAgentOptions } from "../../src/soclaas-company-agent.js";

const EVIDENCE: Evidence = {
  sourceId: "JIRA-42",
  sourceType: "jira",
  title: "Project update",
  excerpt: "The project is active.",
};

function knowledge(found: Evidence[] = []): CompanyKnowledge {
  return {
    async employee() {
      return { employeeId: "jax", displayName: "Jax", currentAssignments: [] };
    },
    async search() {
      return found;
    },
    async related() {
      return [];
    },
    async sources() {
      return [];
    },
  };
}

type RawMessage = { content?: string | null; tool_calls?: unknown[] };
type Reply = string | { raw: RawMessage } | { calls: Array<[string, string | object]> } | { stream: string[] };

type Msg = {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string } }>;
};
type Body = { messages: Msg[]; tools: Array<{ function: { name: string } }>; tool_choice: string; stream?: boolean };

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function scripted(replies: Reply[], extra: Partial<SoCLaaSCompanyAgentOptions> = {}, found: Evidence[] = []) {
  const bodies: Body[] = [];
  const agent = new SoCLaaSCompanyAgent(knowledge(found), {
    apiKey: "k",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Body;
      bodies.push(body);
      const reply = replies.shift();
      if (reply === undefined) throw new Error("script exhausted");
      if (typeof reply === "object" && "stream" in reply) return sse(reply.stream);
      let message: RawMessage;
      if (typeof reply === "string") message = { content: reply };
      else if ("raw" in reply) message = reply.raw;
      else
        message = {
          content: null,
          tool_calls: reply.calls.map(([name, args], index) => ({
            id: `c${bodies.length}-${index}`,
            type: "function",
            function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
          })),
        };
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    },
    ...extra,
  });
  return { agent, bodies };
}

const data = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

function fakeExtension(content = "Shown."): AgentExtension & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    skill: "demo",
    tools: [
      {
        type: "function",
        function: { name: "demo_panel", description: "Shows a panel.", parameters: { type: "object", properties: {} } },
      },
    ],
    async run(name) {
      ran.push(name);
      return { content, block: { type: "recruiting", view: "pool", roleId: "r1" } };
    },
  };
}
const demoSkill = parseSkill("---\nname: demo\ndescription: Demo things.\n---\nUse demo_panel.");

/** Every tool message must answer an assistant tool_call id, and ids must be unique per assistant turn. */
function assertToolMessagesWellFormed(messages: Msg[]) {
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls) {
      const ids = message.tool_calls.map((call) => call.id);
      for (const id of ids) assert.equal(typeof id, "string", "every assistant tool_call carries an id");
      assert.equal(new Set(ids).size, ids.length, `tool_call ids must be unique, got ${JSON.stringify(ids)}`);
      for (const id of ids) seen.add(id);
    }
    if (message.role === "tool") {
      assert.equal(typeof message.tool_call_id, "string", "every tool message carries a tool_call_id");
      assert.ok(seen.has(message.tool_call_id!), `tool message answers unknown id ${message.tool_call_id}`);
    }
  }
}

describe("BUG: tool_call ids from the model are trusted as-is", () => {
  test("a tool call without an id produces a tool message without tool_call_id", async () => {
    const { agent, bodies } = scripted(
      [
        {
          raw: {
            content: null,
            tool_calls: [{ type: "function", function: { name: "search_company_knowledge", arguments: '{"query":"p"}' } }],
          },
        },
        "Active. [source:JIRA-42]",
      ],
      {},
      [EVIDENCE],
    );
    await agent.answer({ employeeId: "jax", question: "q" });
    assertToolMessagesWellFormed(bodies[1]!.messages);
  });

  test("two parallel calls sharing one id produce two tool messages the server cannot tell apart", async () => {
    const call = (q: string) => ({
      id: "call_0",
      type: "function",
      function: { name: "search_company_knowledge", arguments: JSON.stringify({ query: q }) },
    });
    const { agent, bodies } = scripted(
      [{ raw: { content: null, tool_calls: [call("a"), call("b")] } }, "Active. [source:JIRA-42]"],
      {},
      [EVIDENCE],
    );
    await agent.answer({ employeeId: "jax", question: "q" });
    assertToolMessagesWellFormed(bodies[1]!.messages);
  });

  test("streaming: a tool call whose delta carries no id is silently dropped", async () => {
    const statuses: string[] = [];
    const { agent, bodies } = scripted(
      [
        { calls: [["search_company_knowledge", { query: "p" }]] },
        {
          stream: [
            data({
              choices: [
                { delta: { tool_calls: [{ index: 0, function: { name: "search_company_knowledge", arguments: '{"query":"more"}' } }] } },
              ],
            }),
            "data: [DONE]\n\n",
          ],
        },
        { stream: [data({ choices: [{ delta: { content: "Active. [source:JIRA-42]" } }] })] },
      ],
      {},
      [EVIDENCE],
    );
    await agent.answer({ employeeId: "jax", question: "q" }, { onToken: () => {}, onStatus: (s) => statuses.push(s) });
    const nudged = bodies[2]!.messages.some((m) => m.role === "user" && /returned nothing/.test(String(m.content)));
    assert.equal(nudged, false, "the model called a tool, but the agent told it that it returned nothing");
    assert.ok(
      bodies[2]!.messages.some((m) => m.role === "tool" && /JIRA-42/.test(String(m.content))),
      "the second search should have run",
    );
  });
});

describe("BUG: empty-answer retry sends an invalid assistant message", () => {
  test("an empty reply is echoed back as {role: assistant, content: null} with no tool_calls", async () => {
    const { agent, bodies } = scripted(
      [{ calls: [["search_company_knowledge", { query: "p" }]] }, { raw: { content: null } }, "Active. [source:JIRA-42]"],
      {},
      [EVIDENCE],
    );
    const result = await agent.answer({ employeeId: "jax", question: "q" });
    assert.match(result.answer, /Active/);
    const invalid = bodies[2]!.messages.filter(
      (m) => m.role === "assistant" && (m.content === null || m.content === "") && !m.tool_calls?.length,
    );
    // OpenAI-compatible servers (and the Bedrock gateway) reject an assistant message with neither content nor tool_calls.
    assert.equal(invalid.length, 0, `sent ${JSON.stringify(invalid)}`);
  });
});

describe("BUG: citation repair rejects the answer it asks for", () => {
  test("the repair prompt says to answer 'Insufficient evidence' and name what is missing; doing so is thrown away", async () => {
    const { agent, bodies } = scripted(
      [
        { calls: [["search_company_knowledge", { query: "budget" }]] },
        "The budget is 2M.",
        "Insufficient evidence: the retrieved Jira ticket does not mention the Q3 budget figure.",
      ],
      {},
      [EVIDENCE],
    );
    const result = await agent.answer({ employeeId: "jax", question: "What is the Q3 budget?" });
    assert.match(String(bodies[2]!.messages.at(-1)!.content), /say 'Insufficient evidence' and name what is missing/);
    assert.match(result.answer, /Q3 budget figure/, `got the generic fallback: ${result.answer}`);
  });

  test("with nothing retrieved and no personal context, repair can never pass, yet a model call is spent on it", async () => {
    const { agent, bodies } = scripted(
      [
        { calls: [["search_company_knowledge", { query: "budget" }]] },
        "I found nothing about that.",
        "Insufficient evidence: no artifact about the Q3 budget was found.",
      ],
      {},
      [],
    );
    const result = await agent.answer({ employeeId: "jax", question: "What is the Q3 budget?" });
    assert.match(String(bodies[2]?.messages.at(-1)?.content ?? ""), /Available source IDs: none/);
    // Either skip the doomed repair, or accept its compliant answer. Today: both calls, then the canned fallback.
    assert.ok(
      bodies.length === 2 || /Q3 budget/.test(result.answer),
      `${bodies.length} model calls, answer: ${result.answer}`,
    );
  });
});

describe("NOT A BUG (verified)", () => {
  test("content and tool calls on one step: tools run, content is dropped, loop continues", async () => {
    const { agent, bodies } = scripted(
      [
        {
          raw: {
            content: "Draft answer",
            tool_calls: [{ id: "x", type: "function", function: { name: "search_company_knowledge", arguments: '{"query":"p"}' } }],
          },
        },
        "Active. [source:JIRA-42]",
      ],
      {},
      [EVIDENCE],
    );
    const result = await agent.answer({ employeeId: "jax", question: "q" });
    assert.equal(bodies.length, 2);
    assert.equal(result.answer, "Active. [source:JIRA-42]");
  });

  test("load_skill twice (and for an already loaded skill) is harmless", async () => {
    const ext = fakeExtension();
    const { agent } = scripted(
      [
        { calls: [["load_skill", { name: "demo" }], ["load_skill", { name: "demo" }]] },
        { calls: [["load_skill", { name: "demo" }], ["demo_panel", {}]] },
        "Here.",
      ],
      { skills: [demoSkill], extensions: [ext] },
    );
    const result = await agent.answer({ employeeId: "jax", question: "q" });
    assert.equal(result.answer, "Here.");
    assert.deepEqual(ext.ran, ["demo_panel"]);
  });

  test("prototype-looking source ids are rejected as not retrieved, never crash", async () => {
    const { agent } = scripted(
      [
        { calls: [["search_company_knowledge", { query: "p" }]] },
        "x [source:constructor] [source:__proto__] [source:toString]",
        "Active. [source:JIRA-42]",
      ],
      {},
      [EVIDENCE],
    );
    const result = await agent.answer({ employeeId: "jax", question: "q" });
    assert.deepEqual(result.sources.map((s) => s.sourceId), ["JIRA-42"]);
  });

  test("maxSteps reached exactly as a skill loads: last step gets tool_choice none and answers", async () => {
    const ext = fakeExtension();
    const { agent, bodies } = scripted(
      [{ calls: [["load_skill", { name: "demo" }]] }, { calls: [["demo_panel", {}]] }],
      { skills: [demoSkill], extensions: [ext], maxSteps: 2 },
    );
    const result = await agent.answer({ employeeId: "jax", question: "q" });
    assert.equal(bodies[1]!.tool_choice, "none");
    assert.deepEqual(ext.ran, []);
    assert.match(result.answer, /could not finish/);
  });

  test("a model that calls unknown tools every step still ends in an answer", async () => {
    const { agent, bodies } = scripted(
      [{ calls: [["nope", {}]] }, { calls: [["nope", {}]] }, { calls: [["nope", {}]] }, "Plain answer."],
      {},
    );
    const result = await agent.answer({ employeeId: "jax", question: "q", personalMemory: "ctx" });
    assert.equal(bodies.length, 4);
    assert.equal(result.answer, "Plain answer.");
  });

  test("a skill body with --- lines is returned whole by load_skill", async () => {
    const skill = parseSkill("---\nname: demo\ndescription: d\n---\nPart one\n---\nPart two");
    const { agent, bodies } = scripted([{ calls: [["load_skill", { name: "demo" }]] }, "Ok."], { skills: [skill] });
    await agent.answer({ employeeId: "jax", question: "q" });
    assert.match(String(bodies[1]!.messages.at(-1)!.content), /Part one\n---\nPart two/);
  });
});
