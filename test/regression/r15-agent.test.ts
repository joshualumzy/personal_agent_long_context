// Round 15 hunt: the round 14 lost-model note (acted / readsOnly by name and error shape), the
// closing-offer exemption, the chat tool's link normalisation, and the paths around them.
// "BUG" tests fail today; "NOT A BUG" tests pass. The model is always a scripted fetch; nothing
// touches the network.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentExtension, ChatBlock } from "../../src/agent-extension.js";
import type { CompanyKnowledge, Evidence } from "../../src/company-domain.js";
import { recruitingExtension } from "../../src/recruiting/chat-tools.js";
import type { RoleBoard } from "../../src/recruiting/roles.js";
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

type Reply = string | { calls: Array<[string, object | string]>; content?: string };

/** A model that answers from a script; `undefined` means the endpoint is unreachable from then on. */
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
              function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
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

function afterSearch(reply: string, question: string) {
  return run([{ calls: [["search_company_knowledge", { query: question }]] }, reply, reply, reply, reply], question);
}

const recruitingSkill = parseSkill("---\nname: recruiting\ndescription: Hiring.\n---\nBody.");
const withSkill = (extension: AgentExtension) => ({ skills: [recruitingSkill], extensions: [extension] });

/** A recruiting extension whose tools answer as the real ones do. */
function fakeRecruiting(): AgentExtension & { ran: string[] } {
  const ran: string[] = [];
  const names = ["recruiting_status", "recruiting_start", "show_recruiting_panel"];
  return {
    ran,
    skill: "recruiting",
    tools: names.map((name) => ({ type: "function" as const, function: { name, description: name, parameters: { type: "object", properties: {} } } })),
    async run(name) {
      ran.push(name);
      if (name === "show_recruiting_panel") return { content: "Shown.", block: { type: "recruiting", view: "criteria", roleId: "r1" } };
      if (name === "recruiting_start") return { content: JSON.stringify({ role_id: "r1", result: { title: "Backend Engineer" } }) };
      return { content: JSON.stringify({ roles: [{ id: "r1", title: "Backend Engineer", confirmed: true }], role_id: "r1", status: { criteria: [] } }) };
    },
  };
}

/** The real chat tools over a one-role board whose service records what it was asked. */
function realTools(sayResult: object = { intent: "unknown", message: "I could not tell whether that changes the criteria, judges a candidate, or relays a reply. Try rephrasing." }) {
  const imported: string[][] = [];
  const said: string[] = [];
  const snapshot = {
    role: { title: "Backend Engineer", confirmed: true },
    criteria: [],
    integrations: { source: "sample", gmail: false },
    rounds: [],
    busy: false,
    candidates: [],
    proposals: [],
    lastError: null,
  };
  const service = {
    async snapshot() { return snapshot; },
    async say(text: string) { said.push(text); return sayResult; },
    async importProfiles(urls: string[]) {
      imported.push(urls);
      // The service's own check (service.ts importProfiles).
      const invalid = urls.find((url) => !/^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[^/?#\s]+\/?$/i.test(url.replace(/[?#].*$/, "")));
      if (invalid !== undefined || urls.length === 0) {
        const { RecruitingError } = await import("../../src/recruiting/domain.js");
        throw new RecruitingError("invalid_request", `Not a LinkedIn profile link: ${invalid}`);
      }
      return { intent: "import", message: `Added ${urls.length}. Scoring now.` };
    },
  };
  const board = {
    async list() { return [{ id: "r1", title: "Backend Engineer", confirmed: true }]; },
    async get() { return service; },
  } as unknown as RoleBoard;
  return { extension: recruitingExtension(board), imported, said };
}

const CLAIMS_DONE = /\bwas done\b|\bwere done\b|\bdone\b|已经完成|完成了/i;

// ------------------------------------------------------------------------------------------------
describe("BUG: common closing offers after a thank-you still become 'Insufficient Evidence'", () => {
  // soclaas-company-agent.ts:276 lists a handful of exact closing offers ("Let me know if you need
  // anything else."). The most common model phrasings are not among them: "Let me know if you have
  // any other questions." / "If you have any other questions, feel free to ask." / "如果还有其他问题，
  // 随时问我。". Step 0 must call a tool, so a search runs and retrieved > 0; the reply is then an
  // "uncited factual answer", the repair repeats it, and the founder's "thanks" is answered with
  // the canned "Insufficient Evidence: I could not find retrieved Company Evidence…".
  test("1a \"You're welcome! Let me know if you have any other questions.\" to 'thanks!' becomes 'Insufficient Evidence'", async () => {
    const { result } = await afterSearch("You're welcome! Let me know if you have any other questions.", "thanks!");
    assert.doesNotMatch(result.answer, FALLBACK);
  });

  test("1b '不客气！如果还有其他问题，随时问我。' to '谢谢' becomes '证据不足'", async () => {
    const { result } = await afterSearch("不客气！如果还有其他问题，随时问我。", "谢谢");
    assert.doesNotMatch(result.answer, FALLBACK);
  });
});

describe("BUG: the lost-model note says 'That was done' after recruiting_update changed nothing", () => {
  // soclaas-company-agent.ts:589-590 counts any non-read tool whose content is not {"error": …} as
  // having acted. recruiting_update (chat-tools.ts:357-358) wraps every say() outcome in
  // {"result": …, "status": …}, including intent "unknown" ("I could not tell whether that …
  // Try rephrasing."), which changed nothing. If the endpoint then drops, the note (line 728) says
  // "That was done, but I lost the connection…": the founder believes the pass was recorded.
  test("2 'Pass on Alice' not understood by the interpreter, endpoint lost: the note claims it was done", async () => {
    const { extension, said } = realTools();
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_update", { role_id: "r1", text: "Pass on Alice, not senior enough" }]] },
        undefined,
      ],
      "Pass on Alice, not senior enough",
      withSkill(extension),
    );
    assert.deepEqual(said, ["Pass on Alice, not senior enough"]);
    assert.doesNotMatch(result.answer, CLAIMS_DONE);
  });
});

describe("BUG: an empty last step after a role was opened tells the founder to ask again", () => {
  // soclaas-company-agent.ts:785-792: when the model answers nothing on the last step, the turn
  // ends with "I could not finish that one. Could you ask again…" even though recruiting_start
  // already opened the role. Round 13/14 made the lost-model path say that the step was done for
  // exactly this reason ("try again" repeats it); this path still invites the repeat, and a
  // second identical role opens.
  test("3 recruiting_start succeeded, then two empty replies: the answer asks to try again without saying the role exists", async () => {
    const extension = fakeRecruiting();
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_start", { requirement: "A backend engineer who knows Go" }]] },
        "",
        "",
      ],
      "Hire a backend engineer who knows Go",
      { ...withSkill(extension), maxSteps: 4 },
    );
    assert.deepEqual(extension.ran, ["recruiting_start"]);
    const invitesRepeat = /ask again|try again|再问|再试/i.test(result.answer);
    assert.ok(!invitesRepeat || CLAIMS_DONE.test(result.answer), `answer: ${result.answer}`);
  });
});

describe("BUG: the lost-model note keeps a stray [source:…] tag the normal path drops", () => {
  // soclaas-company-agent.ts:733 keeps what the model said beside its panel as is. The normal
  // path (line 780) drops tags naming nothing retrieved beside a skill ("[source:recruiting_start]",
  // rounds 9-10); the fallback does not, so the page draws a citation button for a source that
  // does not exist.
  test("4 '[source:recruiting_start]' beside the panel survives into the fallback answer", async () => {
    const extension = fakeRecruiting();
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_start", { requirement: "A backend engineer who knows Go" }]] },
        {
          calls: [["show_recruiting_panel", { role_id: "r1", view: "criteria" }]],
          content: "I've opened the Backend Engineer role and drafted its criteria [source:recruiting_start]. Review them in the panel below.",
        },
        undefined,
      ],
      "Hire a backend engineer who knows Go",
      withSkill(extension),
    );
    assert.ok(result.blocks?.length, "panel kept");
    assert.match(result.answer, /Backend Engineer role/);
    assert.doesNotMatch(result.answer, /\[sources?\s*[:：]/i);
  });
});

describe("BUG: LinkedIn links sent as a JSON-encoded list are refused", () => {
  // chat-tools.ts:405 accepts `urls` as one string and splits it on spaces and commas. A model
  // that encodes the array as a string ("[\"linkedin.com/in/a\", \"linkedin.com/in/b\"]", a known
  // Qwen tool-call quirk) gets pieces like '["linkedin.com/in/a"' that the normaliser (line 408)
  // cannot match, and the whole import is refused as "Not a LinkedIn profile link".
  test("5 urls: '[\"linkedin.com/in/alice-tan\", \"linkedin.com/in/bob-lee\"]' imports nobody", async () => {
    const { extension, imported } = realTools();
    const outcome = await extension.run("recruiting_import_profiles", {
      role_id: "r1",
      urls: JSON.stringify(["linkedin.com/in/alice-tan", "linkedin.com/in/bob-lee"]),
    });
    assert.doesNotMatch(outcome.content, /"error"/, outcome.content);
    assert.deepEqual(imported.at(-1), ["https://linkedin.com/in/alice-tan", "https://linkedin.com/in/bob-lee"]);
  });
});

// ------------------------------------------------------------------------------------------------
describe("NOT A BUG (verified)", () => {
  test("recruiting_start then the endpoint lost: the note says it was done and keeps the panel", async () => {
    const extension = fakeRecruiting();
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_start", { requirement: "A backend engineer" }]] },
        { calls: [["show_recruiting_panel", { role_id: "r1", view: "criteria" }]] },
        undefined,
      ],
      "Hire a backend engineer",
      withSkill(extension),
    );
    assert.match(result.answer, CLAIMS_DONE);
    assert.equal(result.blocks?.length, 1);
  });

  test("only a panel shown, then the endpoint lost: the note does not claim anything was done", async () => {
    const extension = fakeRecruiting();
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["show_recruiting_panel", { role_id: "r1", view: "pool" }]] },
        undefined,
      ],
      "Show me the pool",
      withSkill(extension),
    );
    assert.doesNotMatch(result.answer, CLAIMS_DONE);
    assert.equal(result.blocks?.length, 1);
  });

  test("the chat tool turns 'linkedin.com/in/x', 'www…' and 'http://…' into https links", async () => {
    const { extension, imported } = realTools();
    const outcome = await extension.run("recruiting_import_profiles", {
      role_id: "r1",
      urls: ["linkedin.com/in/alice-tan", "www.linkedin.com/in/bob-lee", "http://sg.linkedin.com/in/cara-ng?trk=share"],
    });
    assert.doesNotMatch(outcome.content, /"error"/);
    assert.deepEqual(imported[0], [
      "https://linkedin.com/in/alice-tan",
      "https://www.linkedin.com/in/bob-lee",
      "https://sg.linkedin.com/in/cara-ng?trk=share",
    ]);
  });

  test("a single string of links separated by '，' and spaces is split", async () => {
    const { extension, imported } = realTools();
    await extension.run("recruiting_import_profiles", { role_id: "r1", urls: "linkedin.com/in/a，linkedin.com/in/b https://www.linkedin.com/in/c" });
    assert.deepEqual(imported[0], ["https://linkedin.com/in/a", "https://linkedin.com/in/b", "https://www.linkedin.com/in/c"]);
  });

  test("a claim before '有问题随时问我。' is still checked", async () => {
    const { result } = await afterSearch("支付服务由Bob负责。有问题随时问我。", "支付谁负责？");
    assert.match(result.answer, FALLBACK);
  });

  test("a claim wrapped as a closing offer is not exempt", async () => {
    const { result } = await afterSearch("Payments shuts down next month, so let me know if you need anything else.", "what about payments?");
    assert.match(result.answer, FALLBACK);
  });

  test("a Chinese question gets the Chinese note after a role was opened", async () => {
    const extension = fakeRecruiting();
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_start", { requirement: "招一个后端工程师" }]] },
        undefined,
      ],
      "帮我招一个会Go的后端工程师",
      withSkill(extension),
    );
    assert.match(result.answer, /操作已经完成/);
  });
});
