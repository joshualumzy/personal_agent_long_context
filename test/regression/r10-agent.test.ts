// Round 10 hunt: the chat agent loop (stray-tag stripping, translation), streaming, the Postgres
// conversation store, the chat route, and the recruiting skill text.
// "BUG" tests fail today; "NOT A BUG" tests pass. The model is always a scripted fetch.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import type pg from "pg";
import { DeterministicMemoryProvider } from "../../src/adapters/deterministic-memory.js";
import { PostgresConversationStore } from "../../src/adapters/postgres-conversations.js";
import type { AgentExtension, ChatBlock } from "../../src/agent-extension.js";
import type { CompanyAnswer, CompanyKnowledge, Evidence } from "../../src/company-domain.js";
import { buildApp } from "../../src/http-app.js";
import { parseSkill } from "../../src/skills.js";
import { SoCLaaSCompanyAgent, type SoCLaaSCompanyAgentOptions } from "../../src/soclaas-company-agent.js";

const EVIDENCE: Evidence = { sourceId: "JIRA-1", sourceType: "jira", title: "Payments", excerpt: "Payments service owned by Bob" };
const HAN = /[一-鿿]/g;

function knowledge(): CompanyKnowledge {
  return {
    async employee() { return { employeeId: "jax", displayName: "Jax", currentAssignments: [] }; },
    async search() { return [EVIDENCE]; },
    async related() { return []; },
    async sources() { return []; },
  };
}

type Body = { messages: Array<{ role: string; content: unknown }>; tool_choice: string; stream?: boolean };
type Reply = string | { calls: Array<[string, object]>; content?: string } | { stream: string[] };

const data = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const streamText = (text: string): Reply => ({ stream: [data({ choices: [{ delta: { content: text } }] }), "data: [DONE]\n\n"] });

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let sent = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (sent < chunks.length) controller.enqueue(encoder.encode(chunks[sent++]!));
        else controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function run(
  replies: Reply[],
  question: string,
  extra: Partial<SoCLaaSCompanyAgentOptions> = {},
  callbacks?: Parameters<SoCLaaSCompanyAgent["answer"]>[1],
) {
  const bodies: Body[] = [];
  const agent = new SoCLaaSCompanyAgent(knowledge(), {
    apiKey: "k",
    retryBaseMs: 1,
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      const reply = replies.shift();
      if (reply === undefined) throw new Error("script exhausted");
      if (typeof reply === "object" && "stream" in reply) return sse(reply.stream);
      const message =
        typeof reply === "string"
          ? { content: reply }
          : {
              content: reply.content ?? null,
              tool_calls: reply.calls.map(([name, args], index) => ({
                id: `c${bodies.length}-${index}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              })),
            };
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    }) as typeof fetch,
    ...extra,
  });
  const result = await agent
    .answer({ employeeId: "jax", question }, callbacks)
    .catch((error: Error) => ({ answer: `THREW: ${error.message}`, sources: [] as Evidence[] }));
  return { result, calls: bodies.length, bodies };
}

const recruitingSkill = parseSkill("---\nname: recruiting\ndescription: Hiring.\n---\nBody.");

function recruitingExtension(): AgentExtension & { ran: string[] } {
  const ran: string[] = [];
  const names = ["recruiting_start", "recruiting_status", "show_recruiting_panel"];
  return {
    ran,
    skill: "recruiting",
    tools: names.map((name) => ({ type: "function" as const, function: { name, description: name, parameters: { type: "object", properties: {} } } })),
    async run(name) {
      ran.push(name);
      if (name === "show_recruiting_panel") {
        const block: ChatBlock = { type: "recruiting", view: "pool", roleId: "r1" };
        return { content: "Shown.", block };
      }
      return { content: JSON.stringify({ role_id: "r1", status: { role: { title: "Founding Backend Engineer", confirmed: true } } }) };
    },
  };
}
const withSkill = () => {
  const extension = recruitingExtension();
  return { extension, extra: { skills: [recruitingSkill], extensions: [extension] } };
};

const hanShare = (text: string) => (text.match(HAN)?.length ?? 0) / Math.max(text.length, 1);

/** A pg pool that behaves like Postgres on what matters here: TEXT refuses NUL, JSONB must parse. */
function strictPool() {
  const stored: Array<{ content: string; metadata: unknown }> = [];
  const pool = {
    async query(text: string, params: unknown[] = []) {
      for (const param of params) {
        if (typeof param === "string" && param.includes("\u0000")) throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
      }
      if (/INSERT INTO conversations/.test(text)) {
        return { rows: [{ conversation_id: "00000000-0000-0000-0000-000000000001", user_id: params[0], title: params[1], created_at: new Date(), updated_at: new Date() }], rowCount: 1 };
      }
      if (/INSERT INTO conversation_messages/.test(text)) {
        const raw = String(params[3]);
        if (/\\u0000/.test(raw.replace(/\\\\/g, ""))) throw new Error("unsupported Unicode escape sequence");
        let metadata: unknown;
        try {
          metadata = JSON.parse(raw);
        } catch {
          throw new Error("invalid input syntax for type json");
        }
        stored.push({ content: String(params[2]), metadata });
        return { rows: [{ message_id: "m", conversation_id: params[0], role: params[1], content: params[2], metadata, created_at: new Date() }], rowCount: 1 };
      }
      if (/FROM conversations/.test(text)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as pg.Pool;
  return { pool, stored };
}

// ---------------------------------------------------------------- 1. Postgres: NUL stripping

describe("BUG: stripping \\u0000 from the metadata JSON text breaks an escaped backslash", () => {
  // .replace(/\\u0000/g, "") on JSON text also matches the literal text "\u0000" (a backslash the
  // user or a document wrote), which JSON.stringify encodes as "\\u0000": half the escaped backslash
  // is left before the next character, the JSON no longer parses, and the answer's save fails.
  test("1 an answer whose search query mentions '\\u0000' is not saved to the conversation", async () => {
    const { pool, stored } = strictPool();
    const store = new PostgresConversationStore(pool);
    const query = "why does ingest reject \\u0000 in JSON payloads";
    await assert.doesNotReject(
      store.appendMessage({
        conversationId: "00000000-0000-0000-0000-000000000001",
        role: "assistant",
        content: "Postgres jsonb refuses that escape [source:JIRA-1].",
        metadata: { toolCalls: [{ name: "search_company_knowledge", arguments: { query } }] },
      }),
    );
    const saved = stored[0]?.metadata as { toolCalls: Array<{ arguments: { query: string } }> };
    assert.equal(saved.toolCalls[0]!.arguments.query, query, "the saved text changed");
  });
});

describe("BUG: a NUL in the first message still fails the turn: the conversation title is not stripped", () => {
  // Round 9 strips NUL in appendMessage only. A new conversation is titled from the first message
  // (titleFrom), and create() passes that title to Postgres as it is.
  test("2 the first message of a new chat containing a NUL gets 'could not complete' instead of an answer", async () => {
    const { pool } = strictPool();
    const store = new PostgresConversationStore(pool);
    const agent = {
      async answer(): Promise<CompanyAnswer> {
        return { answer: "Bob owns payments.", sources: [], runId: "run", toolCalls: [] };
      },
    };
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never, conversationStore: store });
    const response = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: "copied from a PDF:\u0000 who owns payments?" } });
    await app.close();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().answer, "Bob owns payments.");
  });
});

// ---------------------------------------------------------------- 2. translation beside a skill

describe("BUG: beside a skill, a Chinese translation carrying the same stray tag is refused, so the founder gets English", () => {
  // The stray tag is stripped from the answer, but not from the translation: a translation that
  // keeps a [source:recruiting_status] tag (the retry prompt asks to keep every [source:ID]) fails
  // the unknown-id check both times and the English answer stands.
  test("3 '招聘进展怎么样？' is answered in English", async () => {
    const { extension, extra } = withSkill();
    const { result, calls } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_status", {}]] },
        "The Founding Backend Engineer search is confirmed and running [source:recruiting_status]. Open the panel to review people.",
        "Founding Backend Engineer 的搜索已经确认并在进行中 [source:recruiting_status]。打开面板查看候选人。",
        "Founding Backend Engineer 的搜索已经确认并在进行中 [source:recruiting_status]。打开面板查看候选人。",
      ],
      "招聘进展怎么样？",
      extra,
    );
    assert.deepEqual(extension.ran, ["recruiting_status"]);
    assert.ok(hanShare(result.answer) > 0.2, `(${calls} model calls) the Chinese founder got: ${result.answer}`);
  });
});

// ---------------------------------------------------------------- 3. stray-tag stripping

describe("BUG: a skill answer that is only a stray tag is stripped to nothing and delivered empty", () => {
  // The strip runs after the empty-answer check; "" then passes validateCitations (grounded
  // elsewhere) and is returned, and saved as an empty assistant turn.
  test("4 the founder gets an empty answer", async () => {
    const { extra } = withSkill();
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_status", {}]] },
        "[source:recruiting_status]",
        "The search is running.",
        "The search is running.",
      ],
      "how is hiring going?",
      extra,
    );
    assert.ok(result.answer.trim().length > 0, `answer: ${JSON.stringify(result.answer)}`);
  });
});

describe("BUG: a stray '[Source:...]' tag (capital S) is counted but not stripped", () => {
  // citedIds matches case-insensitively; the strip regex is case-sensitive. The tag stays, the
  // unknown-id check fails, and the strict repair's "Insufficient evidence" is accepted: the r9
  // bug 5 outcome (role opened, founder told "Insufficient evidence") comes back.
  test("5 the role was opened, yet the founder is told 'Insufficient evidence'", async () => {
    const { extension, extra } = withSkill();
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_start", { requirement: "backend engineer" }]] },
        { calls: [["show_recruiting_panel", { view: "criteria" }]] },
        "I've opened the Founding Backend Engineer role [Source:recruiting_start]. Review the draft criteria in the panel below.",
        "Insufficient evidence: none of the available sources mention the new role or its criteria.",
      ],
      "hire a founding backend engineer",
      extra,
    );
    assert.deepEqual(extension.ran, ["recruiting_start", "show_recruiting_panel"]);
    assert.doesNotMatch(result.answer, /insufficient evidence|^THREW/i, `got: ${result.answer}`);
  });
});

// ---------------------------------------------------------------- 4. the skill text

describe("BUG: the skill sends founders to a 'Send from Gmail' button that is not there when Gmail is not connected", () => {
  // SKILL.md: "A draft with an email address goes out when the founder presses 'Send from Gmail'."
  // The candidate panel renders that button only when state.integrations.gmail is true
  // (public/recruiting.js); the status gives the model gmail_connected, but the skill never tells
  // it to check, so with Gmail off the founder is told to press a button that does not exist.
  test("6 the 'Send from Gmail' rule does not depend on gmail_connected", async () => {
    const skill = await readFile(new URL("../../skills/recruiting/SKILL.md", import.meta.url), "utf8");
    const panel = await readFile(new URL("../../public/recruiting.js", import.meta.url), "utf8");
    assert.match(panel, /state\.integrations\?\.gmail\s*\?\s*gmailButton/, "precondition: the button is conditional");
    if (/Send from Gmail/.test(skill)) {
      assert.match(skill, /gmail_connected|Gmail is not connected|Gmail is connected|without Gmail|no Gmail/i, "the skill never says when the Gmail button exists");
    }
  });
});

// ---------------------------------------------------------------- NOT A BUG

describe("NOT A BUG (verified)", () => {
  test("stripping a stray tag keeps a real retrieved citation beside it", async () => {
    const { extra } = withSkill();
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["search_company_knowledge", { query: "payments" }]] },
        { calls: [["recruiting_status", {}]] },
        "Bob owns payments [source:JIRA-1], and the backend search is running [source:recruiting_status].",
      ],
      "who owns payments, and how is hiring going?",
      extra,
    );
    assert.equal(result.answer, "Bob owns payments [source:JIRA-1], and the backend search is running.");
    assert.deepEqual(result.sources.map((source) => source.sourceId), ["JIRA-1"]);
  });

  test("stripping a stray tag at a paragraph end keeps the paragraph break", async () => {
    const { extra } = withSkill();
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_status", {}]] },
        "The search is running [source:recruiting_status].\n\n- Review the pool in the panel below.",
      ],
      "how is hiring going?",
      extra,
    );
    assert.equal(result.answer, "The search is running.\n\n- Review the pool in the panel below.");
  });

  test("three streamed calls all numbered 0, arguments following each id, all run", async () => {
    const { extension, extra } = withSkill();
    const piece = (id: string | undefined, name: string | undefined, args: string) =>
      data({ choices: [{ delta: { tool_calls: [{ index: 0, ...(id ? { id } : {}), type: "function", function: { ...(name ? { name } : {}), arguments: args } }] } }] });
    await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        {
          stream: [
            piece("a", "recruiting_status", "{"), piece(undefined, undefined, "}"),
            piece("b", "recruiting_start", "{\"requirement\":"), piece(undefined, undefined, "\"x\"}"),
            piece("c", "show_recruiting_panel", "{\"view\":\"pool\"}"),
            "data: [DONE]\n\n",
          ],
        },
        streamText("Done; see the panel below."),
      ],
      "hire x",
      extra,
      { onToken: () => {}, onResetTokens: () => {} },
    );
    assert.deepEqual(extension.ran, ["recruiting_status", "recruiting_start", "show_recruiting_panel"]);
  });

  test("a real NUL in message text and metadata is stripped and the metadata still parses", async () => {
    const { pool, stored } = strictPool();
    const store = new PostgresConversationStore(pool);
    await store.appendMessage({
      conversationId: "00000000-0000-0000-0000-000000000001",
      role: "assistant",
      content: "a\u0000b",
      metadata: { toolCalls: [{ name: "recruiting_start", arguments: { requirement: "x\u0000y" } }] },
    });
    assert.equal(stored[0]!.content, "ab");
    assert.deepEqual(stored[0]!.metadata, { toolCalls: [{ name: "recruiting_start", arguments: { requirement: "xy" } }] });
  });

  test("a Chinese translation that drops a stray tag beside a skill replaces the English answer", async () => {
    const { extra } = withSkill();
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_status", {}]] },
        "The search is confirmed and running [source:recruiting_status]. Open the panel to review people.",
        "搜索已经确认并在进行中。打开面板查看候选人。",
      ],
      "招聘进展怎么样？",
      extra,
    );
    assert.equal(result.answer, "搜索已经确认并在进行中。打开面板查看候选人。");
  });
});
