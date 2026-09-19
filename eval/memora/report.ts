/**
 * Turns a recorded Memora run into the Markdown report.
 *
 *   npm run eval:memora:report            # newest run in docs/evaluation
 *   npm run eval:memora:report -- <path>  # a specific run file
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mean } from "./judge.js";

interface RunFile {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  dataset: { repository: string; commit: string; split: string };
  configuration: Record<string, unknown>;
  selection: { rationale: string; personas: string[] };
  timelines: {
    persona: string;
    userId: string;
    transcripts: { chars: number; latencyMs: number; status: number }[];
    questions: {
      category: string;
      questionId: string;
      question: string;
      answer: string;
      correlationId: string;
      runRef: string | null;
      sources: string[];
      latencyMs: number;
      score: {
        memoryPresenceAccuracy: number;
        forgettingAbsenceAccuracy: number;
        lambda: number;
        fama: number;
        criteria: { evaluation_type: string; correct: boolean }[];
      };
    }[];
  }[];
}

const directory = "docs/evaluation";
const explicit = process.argv[2];
const runPath =
  explicit ??
  path.join(
    directory,
    (await readdir(directory))
      .filter((name) => name.startsWith("memora-run-") && name.endsWith(".json"))
      .sort()
      .at(-1)!,
  );

const run = JSON.parse(await readFile(runPath, "utf8")) as RunFile;
const questions = run.timelines.flatMap((timeline) => timeline.questions);
if (questions.length === 0) throw new Error(`No questions recorded in ${runPath}`);

const pct = (value: number) => (value * 100).toFixed(1);
const seconds = (value: number) => (value / 1000).toFixed(0);

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

const askLatencies = questions.map((question) => question.latencyMs);
const ingestLatencies = run.timelines.flatMap((timeline) =>
  timeline.transcripts.map((transcript) => transcript.latencyMs),
);
const totalChars = run.timelines.flatMap((timeline) =>
  timeline.transcripts.map((transcript) => transcript.chars),
);

const byCategory = new Map<string, typeof questions>();
for (const question of questions) {
  byCategory.set(question.category, [
    ...(byCategory.get(question.category) ?? []),
    question,
  ]);
}

const overall = {
  mpa: mean(questions.map((question) => question.score.memoryPresenceAccuracy)),
  faa: mean(questions.map((question) => question.score.forgettingAbsenceAccuracy)),
  fama: mean(questions.map((question) => question.score.fama)),
};

const presenceCriteria = questions.flatMap((question) =>
  question.score.criteria.filter(
    (criterion) => criterion.evaluation_type === "memory_presence",
  ),
);
const forgettingCriteria = questions.flatMap((question) =>
  question.score.criteria.filter(
    (criterion) => criterion.evaluation_type === "forgetting_absence",
  ),
);
const staleViolations = forgettingCriteria.filter(
  (criterion) => !criterion.correct,
).length;

const adequate = overall.fama >= 0.5 && overall.faa >= 0.6;

const lines: string[] = [
  "# Memora evaluation: native Letta Memory",
  "",
  `Run \`${run.runId}\`, started ${run.startedAt}, finished ${run.finishedAt ?? "(incomplete)"}.`,
  "",
  "This is the MVP's evaluation gate. It asks one question: is Letta-owned",
  "Memory good enough to keep, or does the product need its own memory store?",
  "It is not a reproduction of the published Memora results and must not be",
  "read as one.",
  "",
  "## What was run",
  "",
  `- Dataset: \`${run.dataset.repository}\` at commit \`${run.dataset.commit}\`, \`${run.dataset.split}\` split, used as released and not regenerated.`,
  `- Timelines: ${run.timelines.map((timeline) => `\`${timeline.persona}\``).join(", ")}, each against its own user identifier and therefore its own Letta agent and Memory.`,
  `- Questions: ${questions.length}.`,
  `- Agent model: \`${String(run.configuration.agentModel)}\`; Letta Agent SDK \`${String(run.configuration.lettaAgentSdk)}\`, Letta Code \`${String(run.configuration.lettaCode)}\`.`,
  `- Grader: \`${String(run.configuration.judgeModel)}\`, ${String(run.configuration.judges)} judge at temperature 0.`,
  `- Transcript grouping: ${String(run.configuration.transcriptGrouping)}.`,
  "",
  "## Selection",
  "",
  run.selection.rationale,
  "",
  "Selected question identifiers:",
  "",
  ...run.timelines.map(
    (timeline) =>
      `- \`${timeline.persona}\`: ${timeline.questions.map((question) => `\`${question.questionId}\``).join(", ")}`,
  ),
  "",
  "## Results",
  "",
  "| Scope | Questions | MPA | FAA | FAMA |",
  "| --- | --- | --- | --- | --- |",
  `| All | ${questions.length} | ${pct(overall.mpa)} | ${pct(overall.faa)} | ${pct(overall.fama)} |`,
  ...[...byCategory.entries()].map(([category, group]) => {
    const mpa = mean(group.map((question) => question.score.memoryPresenceAccuracy));
    const faa = mean(group.map((question) => question.score.forgettingAbsenceAccuracy));
    const fama = mean(group.map((question) => question.score.fama));
    return `| ${category} | ${group.length} | ${pct(mpa)} | ${pct(faa)} | ${pct(fama)} |`;
  }),
  ...run.timelines.map((timeline) => {
    const group = timeline.questions;
    const mpa = mean(group.map((question) => question.score.memoryPresenceAccuracy));
    const faa = mean(group.map((question) => question.score.forgettingAbsenceAccuracy));
    const fama = mean(group.map((question) => question.score.fama));
    return `| ${timeline.persona} | ${group.length} | ${pct(mpa)} | ${pct(faa)} | ${pct(fama)} |`;
  }),
  "",
  "MPA is Memory Presence Accuracy, FAA is Forgetting Absence Accuracy, and",
  "FAMA is `max(0, MPA - lambda * (1 - FAA))` with `lambda = N_forget / (N_presence + N_forget)`.",
  "MPA and FAA are reported separately because a combined score can hide stale",
  "memory behind correct recall.",
  "",
  `Stale-memory violations: ${staleViolations} of ${forgettingCriteria.length} forgetting criteria, where the answer surfaced something the timeline had updated or deleted.`,
  `Recall criteria: ${presenceCriteria.filter((criterion) => criterion.correct).length} of ${presenceCriteria.length} satisfied.`,
  "",
  "## Latency and cost",
  "",
  `- Ingestion: ${ingestLatencies.length} Transcripts, median ${seconds(percentile(ingestLatencies, 0.5))}s, p90 ${seconds(percentile(ingestLatencies, 0.9))}s, for ${(totalChars.reduce((sum, value) => sum + value, 0) / 1000).toFixed(0)}k characters of conversation.`,
  `- Questions: median ${seconds(percentile(askLatencies, 0.5))}s, p90 ${seconds(percentile(askLatencies, 0.9))}s.`,
  `- Wall clock for the whole run: ${run.finishedAt ? `${((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 60000).toFixed(0)} minutes` : "incomplete"}.`,
  "- Money cost: none. Inference ran on the NUS School of Computing SoCLaaS gateway, which is free for SoC users and rate limited rather than billed.",
  "- The practical constraint is wall clock, not money. Ingestion dominates it, because every Transcript is an agent turn that reads and rewrites Memory.",
  "",
  "## Verdict",
  "",
  adequate
    ? "Native Letta Memory is adequate for the MVP. Keep it, and do not build an application-owned memory store."
    : "Native Letta Memory is not clearly adequate on this sample. The failures below are the evidence a separate architectural decision would rest on; this ticket does not make that decision.",
  "",
  "## Failures worth naming",
  "",
];

const worst = [...questions]
  .sort((left, right) => left.score.fama - right.score.fama)
  .slice(0, 5);
for (const question of worst) {
  lines.push(
    `### \`${question.questionId}\` (FAMA ${pct(question.score.fama)})`,
    "",
    `- Question: ${question.question}`,
    `- Answer: ${question.answer.replace(/\s+/g, " ").slice(0, 400)}`,
    `- MPA ${pct(question.score.memoryPresenceAccuracy)}, FAA ${pct(question.score.forgettingAbsenceAccuracy)}`,
    `- Correlation \`${question.correlationId}\`${question.runRef ? `, run \`${question.runRef}\`` : ""}`,
    "",
  );
}

lines.push(
  "## Deviations from the published protocol",
  "",
  "- One judge, not three with a majority vote.",
  "- A declared subset of one split, not the full 600-question benchmark.",
  "- Conversations are grouped into dated Transcripts, because the product's unit is a Transcript rather than a chat session.",
  "- Both speakers' turns are submitted as the Transcript text.",
  "",
  "Operation labels, `share_memory` flags, memory evidence, forgetting evidence,",
  "and expected answers never reach the agent. They are read by",
  "`eval/memora/dataset.ts` and used only by the grader.",
  "",
  "## Reproducing",
  "",
  "See `docs/evaluation/README.md`. The raw run, including every answer,",
  `correlation identifier, and judged criterion, is in \`${path.basename(runPath)}\`.`,
  "",
);

const reportPath = path.join(directory, "memora-report.md");
await writeFile(reportPath, `${lines.join("\n")}\n`);
console.log(`Report written to ${reportPath}`);
console.log(
  `${questions.length} questions  MPA ${pct(overall.mpa)}  FAA ${pct(overall.faa)}  FAMA ${pct(overall.fama)}`,
);
