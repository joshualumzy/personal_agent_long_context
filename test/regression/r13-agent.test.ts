// Round 13 hunt: the chat agent loop and its "nothing to cite" exemption, the recruiting tools as
// the model uses them, and a model outage in the middle of a turn.
// "BUG" tests fail today; "NOT A BUG" tests pass. The model is always a scripted fetch; nothing
// touches the network.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentExtension, ChatBlock } from "../../src/agent-extension.js";
import type { CompanyKnowledge, Evidence } from "../../src/company-domain.js";
import { recruitingExtension as realRecruitingExtension } from "../../src/recruiting/chat-tools.js";
import type { CandidateProfile } from "../../src/recruiting/domain.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel } from "../../src/recruiting/llm.js";
import { MemoryRoleRepository, RoleBoard } from "../../src/recruiting/roles.js";
import { RecruitingService } from "../../src/recruiting/service.js";
import type { CandidateSource } from "../../src/recruiting/sources.js";
import { parseSkill } from "../../src/skills.js";
import { SoCLaaSCompanyAgent, type SoCLaaSCompanyAgentOptions } from "../../src/soclaas-company-agent.js";

const JIRA: Evidence = { sourceId: "JIRA-1", sourceType: "jira", title: "Payments", excerpt: "Payments service owned by Bob" };
const FALLBACK = /^(Insufficient Evidence|证据不足)/i;

function knowledge(): CompanyKnowledge {
  return {
    async employee() { return { employeeId: "jax", displayName: "Jax", currentAssignments: [] }; },
    async search() { return [JIRA]; },
    async related() { return []; },
    async sources() { return []; },
  };
}

type Reply = string | { calls: Array<[string, object]>; content?: string };

/** A model that answers from a script; `undefined` in the script means the endpoint is unreachable from then on. */
function scriptedFetch(replies: Array<Reply | undefined>, counter: { calls: number }): typeof fetch {
  return (async () => {
    counter.calls += 1;
    if (replies.length === 0) throw new Error("script exhausted");
    const reply = replies.shift();
    if (reply === undefined) {
      replies.unshift(undefined);
      throw new TypeError("fetch failed");
    }
    const message =
      typeof reply === "string"
        ? { content: reply }
        : {
            content: reply.content ?? null,
            tool_calls: reply.calls.map(([name, args], index) => ({
              id: `c${counter.calls}-${index}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            })),
          };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  }) as typeof fetch;
}

async function run(replies: Array<Reply | undefined>, question: string, extra: Partial<SoCLaaSCompanyAgentOptions> = {}) {
  const counter = { calls: 0 };
  const agent = new SoCLaaSCompanyAgent(knowledge(), { apiKey: "k", retryBaseMs: 1, fetch: scriptedFetch(replies, counter), ...extra });
  const result = await agent
    .answer({ employeeId: "jax", question })
    .catch((error: Error) => ({ answer: `THREW: ${error.message}`, sources: [] as Evidence[], blocks: undefined as ChatBlock[] | undefined }));
  return { result, calls: counter.calls };
}

/** Step 0 must call a tool, so a greeting or a thank-you costs a search; asked to repair, the model says the same again. */
function afterSearch(reply: string, question: string) {
  return run([{ calls: [["search_company_knowledge", { query: question }]] }, reply, reply, reply, reply], question);
}

const recruitingSkill = parseSkill("---\nname: recruiting\ndescription: Hiring.\n---\nBody.");

function fakeRecruiting(): AgentExtension & { ran: string[] } {
  const ran: string[] = [];
  const names = ["recruiting_start", "recruiting_status", "show_recruiting_panel"];
  return {
    ran,
    skill: "recruiting",
    tools: names.map((name) => ({ type: "function" as const, function: { name, description: name, parameters: { type: "object", properties: {} } } })),
    async run(name) {
      ran.push(name);
      if (name === "show_recruiting_panel") {
        const block: ChatBlock = { type: "recruiting", view: "criteria", roleId: "r1" };
        return { content: "Shown.", block };
      }
      if (name === "recruiting_start") return { content: JSON.stringify({ role_id: "r1", result: { title: "Backend Engineer" } }) };
      return { content: JSON.stringify({ roles: [] }) };
    },
  };
}

// A real role board, for the recruiting tools as the chat model calls them.
const profile = (id: string): CandidateProfile => ({
  id,
  name: `Person ${id}`,
  headline: "typescript engineer",
  location: "Singapore",
  profileUrl: `https://www.linkedin.com/in/${id}`,
  workHistory: [{ title: "Engineer", company: `Company ${id}` }],
  educationHistory: [],
  summary: "typescript engineer",
});

function fakeModel(): JsonModel {
  return {
    async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
      const data = input as Record<string, any>;
      switch (task) {
        case "criteria extraction":
          return { title: "Founding backend engineer", criteria: [{ text: "typescript", kind: "must" }], query: "typescript engineer" } as T;
        case "criterion judgement":
          return {
            verdicts: data.criteria.map((criterion: { id: string; text: string }) => ({
              criterionId: criterion.id,
              satisfied: data.profile.summary.includes(criterion.text) ? "yes" : "no",
              reasoning: "keyword",
            })),
          } as T;
        case "search query":
          return { queries: ["typescript engineer"] } as T;
        default:
          throw new Error(`Unscripted task ${task}`);
      }
    },
  };
}

async function confirmedRole() {
  const fetched: string[][] = [];
  const source: CandidateSource = {
    name: "fake",
    async search() { return [profile("a")]; },
    async fetchProfiles(urls: string[]) {
      fetched.push(urls);
      return urls.map((url) => profile(url.replace(/.*\/in\//, "").replace(/\/$/, "")));
    },
  };
  const board = new RoleBoard(
    new MemoryRoleRepository(),
    (store) =>
      new RecruitingService({
        model: fakeModel(),
        source,
        store,
        memory: new LocalIntentMemory(),
        contactFinders: [],
        gmail: null,
        clock: () => new Date("2026-09-23T02:00:00.000Z"),
        settings: { resultsPerQuery: 6 },
      }),
  );
  const { id, service } = board.create();
  await service.start("We need a backend engineer who knows TypeScript.");
  await service.confirm();
  return { tools: realRecruitingExtension(board), roleId: id, fetched };
}

// ------------------------------------------------------------------------------------------------
describe("BUG: a Chinese time-of-day greeting back ('早上好！…') is replaced by '证据不足'", () => {
  // statesNoFacts (soclaas-company-agent.ts:278-279): the greeting pattern knows "good morning /
  // afternoon / evening" but, in Chinese, only 你好/您好/嗨 (and 谢谢, 不客气 ...). "早上好", "下午好" and
  // "晚上好" are neither greetings, acknowledgements nor questions, so the reply is not exempt; after
  // the step-0 search it counts as an uncited answer, is repaired, and falls back to 证据不足.
  // The same reply in English passes (NOT A BUG below).
  test("1 '早上好，Jax！今天想先看什么？' to '早上好' becomes '证据不足'", async () => {
    const { result, calls } = await afterSearch("早上好，Jax！今天想先看什么？", "早上好");
    assert.doesNotMatch(result.answer, FALLBACK, `(${calls} model calls) got: ${result.answer}`);
  });

  test("2 '晚上好！有什么可以帮你的吗？' to '晚上好' becomes '证据不足'", async () => {
    const { result, calls } = await afterSearch("晚上好！有什么可以帮你的吗？", "晚上好");
    assert.doesNotMatch(result.answer, FALLBACK, `(${calls} model calls) got: ${result.answer}`);
  });
});

describe("BUG: a thank-you reply that does not end in a question is replaced by 'Insufficient Evidence'", () => {
  // statesNoFacts (soclaas-company-agent.ts:274-275) requires the last sentence to be a question.
  // Round 9 exempted "You're welcome! Anything else I can help with?", but the equally ordinary
  // "You're welcome! Let me know if you need anything else." / "不客气！有需要随时找我。" end in a
  // statement, so a plain "thanks" gets the Insufficient Evidence fallback.
  test("3 \"You're welcome, Jax! Let me know if you need anything else.\" to 'thanks!' becomes 'Insufficient Evidence'", async () => {
    const { result, calls } = await afterSearch("You're welcome, Jax! Let me know if you need anything else.", "thanks!");
    assert.doesNotMatch(result.answer, FALLBACK, `(${calls} model calls) got: ${result.answer}`);
  });

  test("4 '不客气！有需要随时找我。' to '谢谢' becomes '证据不足'", async () => {
    const { result, calls } = await afterSearch("不客气！有需要随时找我。", "谢谢");
    assert.doesNotMatch(result.answer, FALLBACK, `(${calls} model calls) got: ${result.answer}`);
  });
});

describe("BUG: a LinkedIn link pasted as LinkedIn shows it ('linkedin.com/in/…') is refused in the chat", () => {
  // recruiting_import_profiles (src/recruiting/chat-tools.ts:403-405) passes the model's urls
  // straight to importProfiles, which accepts only https:// links (service.ts:494). The hiring page
  // turns "linkedin.com/in/x" (how LinkedIn's contact info shows a profile) into a https link before
  // importing (public/recruiting.js:1159-1163); the chat does not, so the tool answers "Not a
  // LinkedIn profile link" and the model tells the founder their link is wrong.
  test("5 'linkedin.com/in/alice-tan' is answered 'Not a LinkedIn profile link' and nobody is added", async () => {
    const { tools, roleId, fetched } = await confirmedRole();
    const out = await tools.run("recruiting_import_profiles", { role_id: roleId, urls: ["linkedin.com/in/alice-tan"] });
    assert.doesNotMatch(out.content, /Not a LinkedIn profile link/, out.content);
    assert.equal(fetched.length, 1, `the profile was never fetched: ${out.content}`);
  });
});

describe("BUG: when the model endpoint drops after a recruiting tool acted, the turn fails as if nothing happened", () => {
  // Only a cut stream is asked for again (soclaas-company-agent.ts:688-696). A model call that
  // throws or answers non-OK after the retry budget (lines 668-687) rejects the whole turn, although
  // recruiting_start already opened the role and a panel was collected. The founder sees "could not
  // complete this question. Please try again." with no panel, and trying again works on a role they
  // were not told exists. (The save-failure path, http-app.ts:321-346, already follows the rule that
  // an answer whose tools acted must not be lost.)
  test("6 a role is opened, the endpoint then goes down: the turn rejects and the panel is lost", async () => {
    const extension = fakeRecruiting();
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_start", { requirement: "backend engineer who knows TypeScript" }]] },
        { calls: [["show_recruiting_panel", { view: "criteria", role_id: "r1" }]] },
        undefined,
      ],
      "hire a backend engineer who knows TypeScript",
      { skills: [recruitingSkill], extensions: [extension] },
    );
    assert.deepEqual(extension.ran, ["recruiting_start", "show_recruiting_panel"]);
    assert.doesNotMatch(result.answer, /^THREW/, "the turn failed after the role was opened");
    assert.ok(result.blocks?.length, "the panel for the opened role was lost");
  });
});

// ------------------------------------------------------------------------------------------------
describe("NOT A BUG (verified)", () => {
  test("the English 'Good morning, Jax! What would you like to look at first?' is exempt", async () => {
    const { result } = await afterSearch("Good morning, Jax! What would you like to look at first?", "good morning");
    assert.equal(result.answer, "Good morning, Jax! What would you like to look at first?");
  });

  test("'你好，Jax！有什么可以帮你的吗？' is exempt", async () => {
    const { result } = await afterSearch("你好，Jax！有什么可以帮你的吗？", "你好");
    assert.equal(result.answer, "你好，Jax！有什么可以帮你的吗？");
  });

  test("a thank-you reply carrying an uncited company claim is still checked", async () => {
    const { result } = await afterSearch("You're welcome! Bob owns the payments service.", "thanks");
    assert.match(result.answer, FALLBACK);
  });

  test("a full https LinkedIn link imports through the chat tool", async () => {
    const { tools, roleId, fetched } = await confirmedRole();
    const out = await tools.run("recruiting_import_profiles", { role_id: roleId, urls: ["https://www.linkedin.com/in/alice-tan"] });
    assert.equal(fetched.length, 1, out.content);
    assert.doesNotMatch(out.content, /"error"/);
  });

  test("an endpoint down before any tool acted still fails the turn (nothing to lose)", async () => {
    const { result } = await run([undefined], "who owns payments?");
    assert.match(result.answer, /^THREW/);
  });

  test("a brief outage inside the retry budget is ridden out", async () => {
    let down = 2;
    const counter = { calls: 0 };
    const inner = scriptedFetch(
      [{ calls: [["search_company_knowledge", { query: "payments" }]] }, "Bob owns payments [source:JIRA-1]."],
      counter,
    );
    const agent = new SoCLaaSCompanyAgent(knowledge(), {
      apiKey: "k",
      retryBaseMs: 1,
      fetch: (async (...args: Parameters<typeof fetch>) => {
        if (counter.calls === 1 && down-- > 0) throw new TypeError("fetch failed");
        return inner(...args);
      }) as typeof fetch,
    });
    const result = await agent.answer({ employeeId: "jax", question: "who owns payments?" });
    assert.equal(result.answer, "Bob owns payments [source:JIRA-1].");
  });
});
