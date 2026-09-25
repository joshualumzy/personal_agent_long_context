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

type Reply =
  | string
  | { calls: Array<[string, string | object]> }
  | { stream: string[] };

type Body = {
  model: string;
  messages: Array<{ role: string; content: string | null; tool_call_id?: string }>;
  tools: Array<{ function: { name: string } }>;
  tool_choice: string;
  stream?: boolean;
  chat_template_kwargs?: unknown;
};

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

/** Plays back scripted replies; records every request body. */
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
      const message =
        typeof reply === "string"
          ? { content: reply }
          : {
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

const toolMessages = (body: Body | undefined) => (body?.messages ?? []).filter((m) => m.role === "tool");

/** A fake extension, standing in for recruiting. */
function fakeExtension(): AgentExtension & { ran: string[] } {
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
      return { content: "Shown.", block: { type: "recruiting", view: "pool", roleId: "r1" } };
    },
  };
}

const demoSkill = parseSkill("---\nname: demo\ndescription: Demo things.\n---\nUse demo_panel.");

describe("malformed tool calls", () => {
  test("invalid JSON tool arguments become a tool error, not a failed turn", async () => {
    const { agent, bodies } = scripted([
      { calls: [["search_company_knowledge", '{"query": "project"']] },
      "Sorry, let me answer without it.",
    ], {}, []);
    const result = await agent.answer({ employeeId: "jax", question: "q", personalMemory: "ctx" });
    assert.match(result.answer, /Sorry/);
    assert.equal(toolMessages(bodies[1]).length, 1, "the model gets a tool message it can recover from");
  });

  test("an empty arguments string for a no-argument tool does not crash the turn", async () => {
    const ext = fakeExtension();
    const { agent } = scripted(
      [{ calls: [["load_skill", { name: "demo" }]] }, { calls: [["demo_panel", ""]] }, "Here is the panel."],
      { skills: [demoSkill], extensions: [ext] },
    );
    const result = await agent.answer({ employeeId: "jax", question: "show it" });
    assert.match(result.answer, /panel/);
  });

  test("non-object tool arguments become a tool error, not a failed turn", async () => {
    const { agent, bodies } = scripted([{ calls: [["search_company_knowledge", "[1,2]"]] }, "Recovered."]);
    const result = await agent.answer({ employeeId: "jax", question: "q", personalMemory: "ctx" });
    assert.equal(result.answer, "Recovered.");
    assert.equal(toolMessages(bodies[1]).length, 1);
  });

  test("an unknown tool name becomes a tool error, not a failed turn", async () => {
    const { agent, bodies } = scripted([{ calls: [["web_search", { q: "x" }]] }, "Recovered."]);
    const result = await agent.answer({ employeeId: "jax", question: "q", personalMemory: "ctx" });
    assert.equal(result.answer, "Recovered.");
    assert.match(String(toolMessages(bodies[1])[0]?.content), /web_search/);
  });

  test("search_company_knowledge without a query becomes a tool error, not a failed turn", async () => {
    const { agent } = scripted([{ calls: [["search_company_knowledge", {}]] }, "Recovered."]);
    const result = await agent.answer({ employeeId: "jax", question: "q", personalMemory: "ctx" });
    assert.equal(result.answer, "Recovered.");
  });

  test("get_related_sources without source_ids becomes a tool error, not a failed turn", async () => {
    const { agent } = scripted([{ calls: [["get_related_sources", { limit: 2 }]] }, "Recovered."]);
    const result = await agent.answer({ employeeId: "jax", question: "q", personalMemory: "ctx" });
    assert.equal(result.answer, "Recovered.");
  });
});

describe("skill gating", () => {
  test("skill tools are hidden until load_skill, and an early call is refused not run", async () => {
    const ext = fakeExtension();
    const { agent, bodies } = scripted(
      [
        { calls: [["demo_panel", {}]] },
        { calls: [["load_skill", { name: "demo" }]] },
        { calls: [["demo_panel", {}]] },
        "Done.",
      ],
      { skills: [demoSkill], extensions: [ext] },
    );
    const result = await agent.answer({ employeeId: "jax", question: "q" });
    assert.equal(bodies[0]!.tools.some((t) => t.function.name === "demo_panel"), false);
    assert.match(String(toolMessages(bodies[1])[0]?.content), /load_skill/);
    assert.equal(bodies[2]!.tools.some((t) => t.function.name === "demo_panel"), true);
    assert.deepEqual(ext.ran, ["demo_panel"]);
    assert.equal(result.blocks?.length, 1);
  });

  test("no skills: no load_skill tool and no skill list in the system prompt", async () => {
    const { agent, bodies } = scripted(["Hi."]);
    await agent.answer({ employeeId: "jax", question: "q", personalMemory: "ctx" });
    assert.equal(bodies[0]!.tools.some((t) => t.function.name === "load_skill"), false);
    assert.doesNotMatch(String(bodies[0]!.messages[0]!.content), /load_skill/);
  });

  test("loading an unknown skill does not unlock tools", async () => {
    const ext = fakeExtension();
    const { agent, bodies } = scripted(
      [{ calls: [["load_skill", { name: "nope" }]] }, { calls: [["demo_panel", {}]] }, "Done."],
      { skills: [demoSkill], extensions: [ext] },
    );
    await agent.answer({ employeeId: "jax", question: "q", personalMemory: "ctx" });
    assert.deepEqual(ext.ran, []);
    assert.match(String(toolMessages(bodies[1]).at(-1)?.content), /No skill named nope/);
  });
});

describe("citations", () => {
  test("loading a skill does not waive citations for company evidence the agent retrieved", async () => {
    const ext = fakeExtension();
    const { agent, bodies } = scripted(
      [
        { calls: [["load_skill", { name: "demo" }]] },
        { calls: [["search_company_knowledge", { query: "project" }]] },
        "The project is active and ships Friday.",
        "Insufficient evidence.",
      ],
      { skills: [demoSkill], extensions: [ext] },
      [EVIDENCE],
    );
    const result = await agent.answer({ employeeId: "jax", question: "Is the project active?" });
    assert.equal(bodies.length, 4, "an uncited answer over retrieved company evidence should go to citation repair");
    assert.doesNotMatch(result.answer, /Friday/);
  });

  test("an answer citing a retrieved source passes", async () => {
    const { agent } = scripted(
      [{ calls: [["search_company_knowledge", { query: "p" }]] }, "Active. [source:JIRA-42]"],
      {},
      [EVIDENCE],
    );
    const result = await agent.answer({ employeeId: "jax", question: "q" });
    assert.equal(result.sources[0]?.sourceId, "JIRA-42");
  });

  test("a panel the skill attached survives the insufficient-evidence fallback", async () => {
    const ext = fakeExtension();
    const { agent } = scripted(
      [
        { calls: [["load_skill", { name: "demo" }]] },
        { calls: [["demo_panel", {}]] },
        "See the panel. [source:MADE-UP]",
        "See the panel. [source:MADE-UP]",
      ],
      { skills: [demoSkill], extensions: [ext] },
    );
    const result = await agent.answer({ employeeId: "jax", question: "q" });
    assert.equal(ext.ran.length, 1, "the tool really ran and changed state");
    assert.deepEqual(result.blocks, [{ type: "recruiting", view: "pool", roleId: "r1" }]);
  });
});

describe("steps", () => {
  test("empty answer gets one retry and the final request is must-answer", async () => {
    const { agent, bodies } = scripted(
      [{ calls: [["search_company_knowledge", { query: "p" }]] }, "", "Active. [source:JIRA-42]"],
      { maxSteps: 3 },
      [EVIDENCE],
    );
    const result = await agent.answer({ employeeId: "jax", question: "q" });
    assert.equal(bodies.length, 3);
    assert.deepEqual(bodies.map((b) => b.tool_choice), ["required", "auto", "none"]);
    assert.match(result.answer, /Active/);
  });

  test("a model that still calls a tool on the must-answer step does not fail the turn", async () => {
    const { agent } = scripted(
      [
        { calls: [["search_company_knowledge", { query: "p" }]] },
        { calls: [["search_company_knowledge", { query: "again" }]] },
      ],
      { maxSteps: 2 },
      [EVIDENCE],
    );
    await assert.doesNotReject(agent.answer({ employeeId: "jax", question: "q" }));
  });
});

describe("request options and history", () => {
  test("Qwen gets chat_template_kwargs on every request including repair; others do not", async () => {
    const qwen = scripted(
      [{ calls: [["search_company_knowledge", { query: "p" }]] }, "uncited", "Active. [source:JIRA-42]"],
      { model: "Qwen/Qwen3-32B" },
      [EVIDENCE],
    );
    await qwen.agent.answer({ employeeId: "jax", question: "q" });
    assert.equal(qwen.bodies.length, 3);
    for (const body of qwen.bodies) assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });

    const other = scripted(["Hi."], { model: "global.anthropic.claude-sonnet-4-5" });
    await other.agent.answer({ employeeId: "jax", question: "q", personalMemory: "ctx" });
    assert.equal(other.bodies[0]!.chat_template_kwargs, undefined);
  });

  test("history sits between the system prompt and the question, in order, once", async () => {
    const { agent, bodies } = scripted(["Hi."]);
    await agent.answer({
      employeeId: "jax",
      question: "third",
      personalMemory: "ctx",
      history: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
      ],
    });
    const messages = bodies[0]!.messages;
    assert.deepEqual(messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
    assert.equal(messages[1]!.content, "first");
    assert.equal(messages[2]!.content, "second");
    assert.match(String(messages[3]!.content), /"question":"third"/);
  });
});

describe("streaming", () => {
  const data = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

  test("tokens streamed before a tool call are reset", async () => {
    const events: string[] = [];
    const { agent } = scripted(
      [
        { calls: [["search_company_knowledge", { query: "p" }]] },
        {
          stream: [
            data({ choices: [{ delta: { content: "Let me check" } }] }),
            data({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: "s1", function: { name: "search_company_knowledge", arguments: '{"query":' } },
                    ],
                  },
                },
              ],
            }),
            data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"more"}' } }] } }] }),
            "data: [DONE]\n\n",
          ],
        },
        { stream: [data({ choices: [{ delta: { content: "Active. [source:JIRA-42]" } }] }), "data: [DONE]\n\n"] },
      ],
      {},
      [EVIDENCE],
    );
    const result = await agent.answer(
      { employeeId: "jax", question: "q" },
      { onToken: (t) => events.push(`token:${t}`), onResetTokens: () => events.push("reset") },
    );
    assert.deepEqual(events, ["token:Let me check", "reset", "token:Active. [source:JIRA-42]"]);
    assert.match(result.answer, /Active/);
  });

  test("a final SSE line without a trailing newline is not dropped", async () => {
    const { agent, bodies } = scripted(
      [
        { calls: [["search_company_knowledge", { query: "p" }]] },
        { stream: [`data: ${JSON.stringify({ choices: [{ delta: { content: "Active. [source:JIRA-42]" } }] })}`] },
        { stream: [data({ choices: [{ delta: { content: "fallback [source:JIRA-42]" } }] })] },
      ],
      {},
      [EVIDENCE],
    );
    const result = await agent.answer({ employeeId: "jax", question: "q" }, { onToken: () => {} });
    assert.equal(bodies.length, 2, "no retry should be needed");
    assert.equal(result.answer, "Active. [source:JIRA-42]");
  });
});
