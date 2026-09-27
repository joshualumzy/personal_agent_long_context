/**
 * Does the knowledge-gap feature leak OrgForge's answer key into answers?
 *
 * The 17 benchmark questions built on knowledge_gap_detected, employee_hired
 * and the gap-related causal links are checked against everything the feature
 * can put in front of the agent: the hiring_proposals tool's payload, built
 * exactly as src/soclaas-company-agent.ts builds it. The payload is read on
 * two days: the question's own day, and the present (the corporate date,
 * which is what the benchmark runs at).
 *
 * Two checks per question and day:
 *   simulator fields  names or values only knowledge_gap_detected carries
 *                     (gap_classification, detection_method, documented_pct,
 *                     days_since_departure, ...) — must never appear
 *   answer ids        the question's ground-truth artifacts and events; if one
 *                     appears, is it also what plain search returns for the
 *                     question on that day? If so the feature added nothing
 *                     the agent could not already retrieve.
 *
 *   DATABASE_URL=... node --import tsx eval/orgforge/gap_contamination.ts
 *   # writes docs/evaluation/gap-contamination.md
 *
 * No model is called: this audits what the tools hand the model, which is
 * the only way the feature can change an answer.
 */
import { readFile, writeFile } from "node:fs/promises";
import { PostgresCompanyKnowledge } from "../../src/adapters/postgres-company-knowledge.js";
import { resolveAsOf, type AsOf } from "../../src/as-of.js";
import { GapHiring, MemoryGapLedger } from "../../src/gap-hiring.js";
import { getCalendarDateForSimulationDay } from "./temporal.js";

const root = new URL("../../", import.meta.url);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const GAP_TYPES = new Set([
  "knowledge_gap_detected", "employee_hired", "async_gap_detected", "pr_gap_detected",
  "doc_gap_detected", "involves_gap", "hire_fills_knowledge_gap",
]);

/** Field names, and the label values, that exist only in knowledge_gap_detected. */
const SIMULATOR_ONLY = [
  /gap_classification/i, /detection_method/i, /documented_pct/i, /days_since_departure/i,
  /live_documentation_coverage/i, /semantic_score/i, /is_genesis_gap/i, /genesis/i,
  /embedding_similarity/i, /async_thread_classification/i, /author_self_audit/i, /reviewer_audit/i,
  /escalation_harder/i, /orphaned_domains/i, /knowledge_gap_detected/i, /\bEVT-/,
];

interface Question {
  question_id: string;
  question_type: string;
  question_text: string;
  link_type?: string;
  trigger_event_type?: string;
  day?: number;
  trigger_day?: number;
  expected_search_space?: string[];
  ground_truth: Record<string, unknown>;
}

function answerIds(question: Question): string[] {
  const truth = question.ground_truth;
  const ids = new Set<string>(question.expected_search_space ?? []);
  const chain = truth.evidence_chain_artifacts as { cause?: string[]; effect?: string[] } | undefined;
  for (const id of [...(chain?.cause ?? []), ...(chain?.effect ?? [])]) ids.add(id);
  const link = truth.causal_link_value;
  if (typeof link === "string" && /^[A-Za-z]+[-_][A-Za-z0-9_:.-]+$/.test(link)) ids.add(link);
  return [...ids];
}

const questions = (await readFile(new URL("eval/orgforge/questions.jsonl", root), "utf8"))
  .split("\n").filter(Boolean).map((line) => JSON.parse(line) as Question)
  .filter((q) => GAP_TYPES.has(q.link_type ?? "") || GAP_TYPES.has(q.trigger_event_type ?? ""));

const knowledge = new PostgresCompanyKnowledge(databaseUrl);
try {
  const days = await knowledge.workingDays();
  const present = days.at(-1)! as AsOf;
  const gaps = new GapHiring(knowledge, new MemoryGapLedger());

  /** The hiring_proposals tool's payload on a day, as the agent builds it. */
  async function payload(day: AsOf) {
    const dated = knowledge.asOf(day);
    const proposals = await gaps.list(day);
    const cited = [...new Set(proposals.flatMap((p) => p.evidence))];
    const citable = new Set((await dated.sources(cited)).map((item) => item.sourceId));
    return JSON.stringify({
      date: day,
      proposals: proposals.map((p) => ({
        id: p.id, domain: p.name, status: p.status, open_since: p.openedOn,
        reasons: p.reasons.map((r) => r.text), suggested_title: p.suggestedTitle,
        cite: p.evidence.filter((id) => citable.has(id)),
      })),
    });
  }

  const rows: string[] = [];
  let leaks = 0;
  let newIds = 0;
  for (const question of questions) {
    const simDay = question.day ?? question.trigger_day;
    const calendar = simDay === undefined ? undefined : getCalendarDateForSimulationDay(simDay);
    const own = calendar ? resolveAsOf(calendar < days[0]! ? days[0]! : calendar, days) : null;
    const checkDays = [...new Set([own?.ok ? own.day : null, present].filter(Boolean))] as AsOf[];
    for (const day of checkDays) {
      const text = await payload(day);
      const fields = SIMULATOR_ONLY.filter((pattern) => pattern.test(text)).map(String);
      const found = answerIds(question).filter((id) => text.includes(id));
      const bySearch = new Set((await knowledge.asOf(day).search(question.question_text, 12)).map((e) => e.sourceId));
      const added = found.filter((id) => !bySearch.has(id));
      leaks += fields.length;
      newIds += added.length;
      const proposals = (JSON.parse(text) as { proposals: Array<{ domain: string }> }).proposals.map((p) => p.domain);
      rows.push(`| ${question.question_id} | ${day}${day === present ? " (present)" : ""} | ${proposals.join(", ") || "none"} | ${fields.join(" ") || "none"} | ${found.length ? found.map((id) => (added.includes(id) ? `**${id}** (not found by search)` : `${id} (also found by search)`)).join(", ") : "none"} |`);
    }
  }

  const report = [
    "# Knowledge-gap feature: contamination check",
    "",
    "Generated by `eval/orgforge/gap_contamination.ts`. It covers the benchmark questions built on `knowledge_gap_detected`, `employee_hired` and the gap-related causal links, checked against the `hiring_proposals` tool's payload (the only way the feature reaches an answer), on the question's own day and on the present.",
    "",
    "No model was called: the model endpoints are not reachable from where this ran. The check is on what the tool hands the model, which bounds what the feature can add to an answer.",
    "",
    "## Result",
    "",
    `- ${questions.length} questions, ${rows.length} question-days checked.`,
    `- Simulator-only fields or labels in the payload: **${leaks}**.`,
    `- Ground-truth artifacts the payload names that plain search for the question does not return: **${newIds}**.`,
    "",
    "## Per question",
    "",
    "| Question | Day | Proposals in the payload | Simulator-only fields | Ground-truth ids in the payload |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "## What the payload does carry",
    "",
    "Departures by name and day, from the roster (\"Morgan, who owned kubernetes-deploy, left on 2026-02-17\"), and who owns a domain, from the dated owner history. Both are approved projections (`docs/mvp.md`). Several of these questions name the departed person themselves (Bill, Sharon, Jordan, Morgan), so the fact that someone left is not the answer to any of them. The answers are about whether a page was written, what caused an incident, or whether a hire filled a gap.",
    "",
  ];
  await writeFile(new URL("docs/evaluation/gap-contamination.md", root), `${report.join("\n")}\n`, "utf8");
  console.log(`${questions.length} questions, ${rows.length} question-days; simulator fields ${leaks}; new ground-truth ids ${newIds}`);
} finally {
  await knowledge.close();
}
