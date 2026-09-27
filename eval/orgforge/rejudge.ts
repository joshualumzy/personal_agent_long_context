/**
 * Re-grades saved OrgForge reports with the current judge, without re-running the agent.
 *
 *   node --env-file=.env --import tsx eval/orgforge/rejudge.ts <report.json> [more.json ...]
 *
 * Several reports are pooled into one scorecard (e.g. a run split across --type batches).
 */
import { readFile, writeFile } from "node:fs/promises";
import { loadBenchmarkQuestions, getReferenceAnswer } from "./dataset.js";
import { judgeAgainstReference, judgeOptionsFromEnvironment, type QuestionEvaluationResult } from "./judge.js";

/** 95% Wilson score interval for a proportion. */
function wilson(correct: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  const z = 1.96;
  const p = correct / total;
  const denom = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function line(label: string, results: QuestionEvaluationResult[]): string {
  const correct = results.filter((r) => r.answerCorrect).length;
  const [lo, hi] = wilson(correct, results.length);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return `${label.padEnd(16)}: ${pct(correct / results.length)} (${correct}/${results.length})  95% CI ${pct(lo)}–${pct(hi)}`;
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (paths.length === 0) throw new Error("Pass one or more report JSON paths.");

  const judge = judgeOptionsFromEnvironment(process.env);
  const questions = new Map((await loadBenchmarkQuestions()).map((q) => [q.question_id, q]));
  const pooled: QuestionEvaluationResult[] = [];
  const models = new Set<string>();

  for (const path of paths) {
    const report = JSON.parse(await readFile(path, "utf-8")) as { model?: string; results: QuestionEvaluationResult[] };
    if (report.model) models.add(report.model);
    for (const result of report.results) {
      const question = questions.get(result.questionId);
      const reference = question ? getReferenceAnswer(question) : null;
      if (!question || reference === null || result.agentStatus === "error") {
        pooled.push({ ...result, answerCorrect: false });
        continue;
      }
      const verdict = await judgeAgainstReference(judge, question.question_text, reference, result.agentAnswer);
      pooled.push({ ...result, expectedAnswer: reference, judgedAnswer: verdict, answerCorrect: verdict === "agrees" });
    }
  }

  console.log(`Agent model(s): ${[...models].join(", ") || "unknown"}   Judge: ${judge.model}`);
  console.log(line("OVERALL", pooled));
  for (const type of ["PERSPECTIVE", "SILENCE", "COUNTERFACTUAL"]) {
    const subset = pooled.filter((r) => r.questionType === type);
    if (subset.length) console.log(line(type, subset));
  }
  const inconclusive = pooled.filter((r) => r.judgedAnswer === "inconclusive").length;
  console.log(`Inconclusive verdicts: ${inconclusive}/${pooled.length}`);

  const out = paths[0]!.replace(/\.json$/, `-rejudged.json`);
  await writeFile(out, JSON.stringify({ judge: judge.model, sources: paths, results: pooled }, null, 2));
  console.log(`Saved: ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
