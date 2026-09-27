/**
 * Would Jev (TypeSafe's decision model, via Vercel AI Gateway) do the
 * meeting agent's judgement calls as well as the meeting model? Three calls,
 * each asked of both with the same options:
 *
 *   screening  - is this line a commitment, and of which kind?
 *   conflict   - does this new decision contradict one of the earlier ones?
 *   dedupe     - is this mention an action already open, or a new one?
 *
 * Screening uses the labelled lines of eval/meetings/cases.json; conflict
 * and dedupe use small hand-labelled sets below. Lines the deterministic
 * guard blocks (injections, secrets) never reach a model, so they are left
 * out, as in the product.
 *
 *   node --env-file=.env --import tsx eval/meetings/jev-judgments.ts
 */
import { readFile } from "node:fs/promises";
import { checkConflicts } from "../../src/meetings/drafter.js";
import { screenSegment } from "../../src/meetings/guard.js";
import { OpenAiCompatibleModel, type JsonModel } from "../../src/recruiting/llm.js";
import type { CompanyKnowledge } from "../../src/company-domain.js";

type Options = Record<string, string>;
interface Question {
  instructions: string;
  criteria: Options;
}

// ------------------------------------------------------------------ clients

const base = new OpenAiCompatibleModel({
  baseUrl: process.env.SOCLAAS_BASE_URL!,
  apiKey: process.env.SOCLAAS_API_KEY!,
  model: process.env.MEETINGS_MODEL ?? "qwen3.8:27b",
  timeoutMs: 90_000,
});
const qwen: JsonModel = { json: (request) => base.json({ ...request, fast: true }) };

async function askJev(state: unknown, questions: Record<string, Question>): Promise<Record<string, { choice: string; p: number }>> {
  const body = JSON.stringify({
    model: "typesafe-ai/jev",
    state,
    questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { type: "choice", ...q }])),
  });
  for (let attempt = 0; attempt < 6; attempt++) {
    stats.jevCalls += 1;
    const response = await fetch("https://ai-gateway.vercel.sh/v1/evaluate", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`, "content-type": "application/json" },
      body,
    });
    if (response.status === 503 || response.status === 429) { stats.jevRetries += 1; continue; }
    const data = (await response.json()) as { answers?: Record<string, { choice: string; probabilities: Record<string, number> }> };
    if (!response.ok || !data.answers) throw new Error(`Jev HTTP ${response.status}`);
    return Object.fromEntries(Object.entries(data.answers).map(([id, a]) => [id, { choice: a.choice, p: a.probabilities[a.choice] ?? 0 }]));
  }
  throw new Error("Jev unavailable after 6 tries");
}

const stats = { jevCalls: 0, jevRetries: 0, qwenRetries: 0, errors: [] as string[] };

/** SoCLaaS fails in bursts (timeouts, 5xx); retry with a pause so a failed call is not scored as a wrong answer. */
async function withRetries<T>(run: () => Promise<T>, label: string): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await run();
    } catch (error) {
      last = error;
      stats.qwenRetries += 1;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  stats.errors.push(`${label}: ${last instanceof Error ? last.message.slice(0, 120) : String(last)}`);
  throw last;
}

async function askQwen(state: unknown, questions: Record<string, Question>): Promise<Record<string, { choice: string; p: number }>> {
  const reply = await withRetries(() => qwen.json<Record<string, unknown>>({
    task: "judgement",
    system: [
      "Answer each question about the state with exactly one of its option keys.",
      `Reply as {${Object.keys(questions).map((id) => `"${id}": string`).join(", ")}}.`,
    ].join("\n"),
    input: { state, questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { question: q.instructions, options: q.criteria }])) },
  }), "qwen judgement");
  return Object.fromEntries(Object.keys(questions).map((id) => [id, { choice: String(reply?.[id] ?? ""), p: 1 }]));
}

// ------------------------------------------------------------------ scoring

interface Row {
  task: string;
  item: string;
  expected: string;
  jev: string;
  jevP: number;
  jevMs: number;
  qwen: string;
  qwenMs: number;
}
const rows: Row[] = [];

async function timed<T>(run: () => Promise<T>): Promise<[T | null, number]> {
  const started = performance.now();
  try {
    return [await run(), Math.round(performance.now() - started)];
  } catch (error) {
    stats.errors.push(error instanceof Error ? error.message.slice(0, 120) : String(error));
    return [null, Math.round(performance.now() - started)];
  }
}

// --------------------------------------------------------------- screening

const KINDS: Options = {
  none: "not a commitment: discussion, an idea being floated, a report of work already done, small talk, or a question asking colleagues for their opinion",
  answer_question: "a direct question about a fact recorded in company systems (a past ticket, incident, customer, or decision) that someone asks now",
  email_draft: "someone promises to send an email or a written follow-up to a person",
  message_draft: "someone promises a quick chat message (WhatsApp, Teams) carrying a specific date, number or decision to someone not in the meeting",
  calendar_draft: "someone commits to setting up or sending an invite for a meeting",
  ticket_draft: "someone commits to opening a ticket or task for work to be done",
  doc_draft: "someone promises to write up a new internal document such as notes, a spec or a checklist",
  sheet_draft: "someone promises to put together a new table or spreadsheet",
  hiring_request: "someone says the company needs to hire a new person",
  escalation: "someone offers or commits money: a discount, refund, credit, payment, price change, or signing a contract",
};

async function screening() {
  const cases = JSON.parse(await readFile(new URL("./cases.json", import.meta.url), "utf8")) as {
    scenarios: Array<{ scenario: string; expectedActions: Array<{ segmentIndex: number; kind: string }>; expectedNonActions?: number[] }>;
    adversarial: Array<{ id: string; speaker: string; text: string; expectedKind: string }>;
  };
  const items: Array<{ id: string; line: string; context: string[]; expected: string }> = [];
  for (const scenario of cases.scenarios) {
    const file = JSON.parse(await readFile(new URL(`../../src/meetings/scenarios/${scenario.scenario}`, import.meta.url), "utf8")) as {
      segments: Array<{ speaker: string; text: string }>;
    };
    const lines = file.segments.map((s) => `${s.speaker}: ${s.text}`);
    const label = new Map<number, string>();
    for (const e of scenario.expectedActions) label.set(e.segmentIndex, e.kind === "flag_conflict" ? "none" : e.kind);
    for (const i of scenario.expectedNonActions ?? []) label.set(i, "none");
    for (const [i, kind] of label) {
      if (kind === "blocked" || screenSegment(file.segments[i]!.text).verdict !== "ok") continue;
      items.push({ id: `${scenario.scenario.slice(0, 10)}#${i}`, line: lines[i]!, context: lines.slice(Math.max(0, i - 3), i), expected: kind });
    }
  }
  for (const a of cases.adversarial) {
    if (a.expectedKind === "blocked" || screenSegment(a.text).verdict !== "ok") continue;
    items.push({ id: a.id, line: `${a.speaker}: ${a.text}`, context: [], expected: a.expectedKind });
  }
  const question = { kind: { instructions: "What is the last line of the meeting (the line field), given the lines before it?", criteria: KINDS } };
  for (const item of items) {
    const state = { earlierLines: item.context, line: item.line };
    const [j, jMs] = await timed(() => askJev(state, question));
    const [q, qMs] = await timed(() => askQwen(state, question));
    rows.push({ task: "screening", item: `${item.id} ${item.line.slice(0, 60)}`, expected: item.expected, jev: j?.kind?.choice ?? "ERROR", jevP: j?.kind?.p ?? 0, jevMs: jMs, qwen: q?.kind?.choice ?? "ERROR", qwenMs: qMs });
  }
}

// ---------------------------------------------------------------- conflict

const PRIOR = [
  "Decision: we'll go with approach B. It ships faster and the DLQ gives us a stronger safety net than the reprocessing risk of moving every consumer to exactly-once under load.",
  "We're moving the championship telemetry launch to March.",
  "Customer-facing status updates go out every Friday.",
];
const NEW_DECISIONS: Array<[string, string]> = [
  ["Decision: as agreed, we go with approach A for the offset-commit fix, exactly-once semantics across the whole consumer group.", "p0"],
  ["Decision: 5 retries, updating the runbook.", "none"],
  ["OK, approach B it is, let's ship it.", "none"],
  ["Let's launch the championship telemetry in January instead.", "p1"],
  ["From now on we'll send status updates every Monday.", "p2"],
  ["Let's keep the Friday status updates as they are.", "none"],
  ["We're going with exactly-once commits after all.", "p0"],
  ["Decision: we'll hire a dedicated on-call SRE this quarter.", "none"],
];

async function conflict() {
  const noKnowledge: CompanyKnowledge = {
    employee: async (employeeId) => ({ employeeId, displayName: "E", currentAssignments: [] }),
    search: async () => [],
    related: async () => [],
    sources: async () => [],
  };
  const prior = PRIOR.map((text, index) => ({ speaker: "Jax", text, segmentIndex: index, at: "2026-09-18T02:00:00Z", meetingId: "last-week", title: "Last week" }));
  const question = {
    contradicts: {
      instructions: "Does the new decision contradict one of the earlier decisions? Agreeing with one, or being about something else, is none.",
      criteria: { none: "it contradicts none of them", ...Object.fromEntries(PRIOR.map((text, i) => [`p${i}`, `it contradicts: ${text}`])) },
    },
  };
  for (const [text, expected] of NEW_DECISIONS) {
    const [j, jMs] = await timed(() => askJev({ newDecision: text, earlierDecisions: PRIOR }, question));
    // The meeting model runs the product's own conflict check.
    const [q, qMs] = await timed(() => withRetries(() => checkConflicts(qwen, { speaker: "Morgan", text, segmentIndex: 0, at: "2026-09-25T02:00:00Z" }, prior, noKnowledge), "qwen conflict"));
    const qChoice = q === null ? "none" : `p${PRIOR.findIndex((p) => p === (q as { priorDecision: string }).priorDecision)}`;
    rows.push({ task: "conflict", item: text.slice(0, 70), expected, jev: j?.contradicts?.choice ?? "ERROR", jevP: j?.contradicts?.p ?? 0, jevMs: jMs, qwen: qChoice, qwenMs: qMs });
  }
}

// ------------------------------------------------------------------ dedupe

const OPEN = {
  o1: "Email NOC the written follow-up on the ENG-210 root cause and fix",
  o2: "Ticket for Ben: consumer-lag alerting on the offset-commit path",
  o3: "Calendar invite: checkpoint sync with NOC next Tuesday",
};
const MENTIONS: Array<[string, string]> = [
  ["Reminder to myself, I still need to get that follow-up email out to NOC today.", "o1"],
  ["I'll fold that into the same follow-up note so you get one email instead of two.", "o1"],
  ["On the alerting ticket, I'll scope it to just the offset-commit path for now.", "o2"],
  ["I'll send the invite for Tuesday's checkpoint.", "o3"],
  ["I'll open a separate ticket to upgrade the Kafka client library.", "new"],
  ["I'll email finance the invoice breakdown.", "new"],
  ["Can we also book a retro on the incident for next week?", "new"],
];

async function dedupe() {
  const question = {
    same: {
      instructions: "Is the commitment in this line one of the open actions (the same piece of work, perhaps mentioned again or extended), or a new one?",
      criteria: { new: "a new piece of work, not any of the open actions", ...Object.fromEntries(Object.entries(OPEN).map(([k, v]) => [k, `the same work as: ${v}`])) },
    },
  };
  for (const [text, expected] of MENTIONS) {
    const state = { line: text, openActions: OPEN };
    const [j, jMs] = await timed(() => askJev(state, question));
    const [q, qMs] = await timed(() => askQwen(state, question));
    rows.push({ task: "dedupe", item: text.slice(0, 70), expected, jev: j?.same?.choice ?? "ERROR", jevP: j?.same?.p ?? 0, jevMs: jMs, qwen: q?.same?.choice ?? "ERROR", qwenMs: qMs });
  }
}

// ------------------------------------------------------------------ report

await screening();
await conflict();
await dedupe();

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
for (const task of ["screening", "conflict", "dedupe"]) {
  const set = rows.filter((r) => r.task === task);
  console.log(`\n## ${task} (${set.length} items)\n\n| item | expected | Jev (p) | qwen |\n|---|---|---|---|`);
  for (const r of set) {
    const mark = (v: string) => (v === r.expected ? v : `**${v}**`);
    console.log(`| ${r.item.replace(/\|/g, "/")} | ${r.expected} | ${mark(r.jev)} (${r.jevP.toFixed(2)}) | ${mark(r.qwen)} |`);
  }
  const right = (who: "jev" | "qwen") => set.filter((r) => r[who] === r.expected).length;
  const confident = set.filter((r) => r.jevP >= 0.6);
  console.log(
    `\n${task}: Jev ${right("jev")}/${set.length} (median ${median(set.map((r) => r.jevMs))} ms), ` +
      `qwen ${right("qwen")}/${set.length} (median ${median(set.map((r) => r.qwenMs))} ms); ` +
      `Jev when p >= 0.6: ${confident.filter((r) => r.jev === r.expected).length}/${confident.length} right, ${set.length - confident.length} held back`,
  );
}
console.log(`\nJev: ${stats.jevCalls} HTTP calls, ${stats.jevRetries} retried after 503/429. qwen: ${stats.qwenRetries} retries.`);
console.log(`Failures that stayed failures (${stats.errors.length}): ${[...new Set(stats.errors)].join(" | ") || "none"}`);
