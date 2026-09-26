import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresCompanyKnowledge } from "../../src/adapters/postgres-company-knowledge.js";
import { embeddingProviderFromEnvironment } from "../../src/embeddings.js";
import { SoCLaaSCompanyAgent } from "../../src/soclaas-company-agent.js";
import {
  getQuestionActor,
  loadBenchmarkQuestions,
  type OrgForgeBenchmarkQuestion,
} from "./dataset.js";
import { evaluateQuestionResponse, type QuestionEvaluationResult } from "./judge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface RunConfig {
  limit: number;
  type?: "PERSPECTIVE" | "SILENCE" | "COUNTERFACTUAL";
  actor?: string;
  saveReport: boolean;
  model: string;
  baseUrl: string;
  apiKey: string;
  databaseUrl: string;
}

function parseCliArgs(): RunConfig {
  const args = process.argv.slice(2);
  let limit = 5;
  let type: "PERSPECTIVE" | "SILENCE" | "COUNTERFACTUAL" | undefined;
  let actor: string | undefined;
  let saveReport = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--all") {
      limit = 78;
    } else if (arg === "--limit" && args[i + 1]) {
      limit = Number.parseInt(args[++i], 10);
    } else if (arg === "--type" && args[i + 1]) {
      type = args[++i].toUpperCase() as "PERSPECTIVE" | "SILENCE" | "COUNTERFACTUAL";
    } else if (arg === "--actor" && args[i + 1]) {
      actor = args[++i];
    } else if (arg === "--no-save") {
      saveReport = false;
    }
  }

  const databaseUrl = process.env.DATABASE_URL;
  const apiKey = process.env.SOCLAAS_API_KEY;
  const baseUrl = process.env.SOCLAAS_BASE_URL ?? "https://soclaas-api.comp.nus.edu.sg/v1";
  const model = process.env.SOCLAAS_COMPANY_MODEL ?? "qwen3.8:27b";

  if (!databaseUrl) throw new Error("DATABASE_URL is required in .env");
  if (!apiKey) throw new Error("SOCLAAS_API_KEY is required in .env");

  return {
    limit,
    type,
    actor,
    saveReport,
    model,
    baseUrl,
    apiKey,
    databaseUrl,
  };
}

async function run(): Promise<void> {
  const config = parseCliArgs();

  console.log("==================================================================");
  console.log("             OrgForge Benchmark Evaluation Harness                ");
  console.log("==================================================================");
  console.log(`Model:         ${config.model} (${config.baseUrl})`);
  console.log(`Database:      Connected via DATABASE_URL`);
  console.log(`Limit:         ${config.limit} question(s)`);
  if (config.type) console.log(`Filter Type:   ${config.type}`);
  if (config.actor) console.log(`Filter Actor:  ${config.actor}`);
  console.log("------------------------------------------------------------------\n");

  const allQuestions = await loadBenchmarkQuestions({
    type: config.type,
    limit: config.limit,
  });

  const questions = config.actor
    ? allQuestions.filter((q) => (q.actor ?? q.actors?.[0])?.toLowerCase() === config.actor?.toLowerCase())
    : allQuestions;

  if (questions.length === 0) {
    console.log("No questions matched the specified criteria.");
    return;
  }

  console.log(`Loaded ${questions.length} benchmark question(s) to evaluate.\n`);

  const companyKnowledge = new PostgresCompanyKnowledge(
    config.databaseUrl,
    embeddingProviderFromEnvironment(process.env),
  );

  const companyAgent = new SoCLaaSCompanyAgent(companyKnowledge, {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  });

  const employeesList = (await companyKnowledge.listEmployees?.()) ?? [];
  const validEmployeeIds = new Set(employeesList.map((e) => e.employeeId.toLowerCase()));

  const judgeOptions = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  };

  const results: QuestionEvaluationResult[] = [];

  try {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const employeeId = getQuestionActor(q, validEmployeeIds);
      const employeeObj = employeesList.find((e) => e.employeeId.toLowerCase() === employeeId);
      const actorName = employeeObj?.displayName ?? employeeId;

      process.stdout.write(
        `[${i + 1}/${questions.length}] ${q.question_type.padEnd(14)} (${actorName.padEnd(8)}) "${q.question_text.slice(0, 48)}…" `,
      );

      const startTime = Date.now();
      let agentResult: { answer: string; sources: { sourceId: string; title: string }[] };

      try {
        agentResult = await companyAgent.answer({
          employeeId,
          question: q.question_text,
        });
      } catch (err) {
        console.log(`\n    ❌ Error during agent execution: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const elapsed = Date.now() - startTime;

      const evalResult = await evaluateQuestionResponse(
        q,
        agentResult,
        elapsed,
        judgeOptions,
      );

      results.push(evalResult);

      const statusIcon = evalResult.answerCorrect ? "✅" : "❌";
      const recallPct = Math.round(evalResult.citationRecall * 100);
      console.log(
        `${statusIcon}  [${(elapsed / 1000).toFixed(1)}s]  Recall: ${recallPct}% (${evalResult.citedArtifacts.length} cited)`,
      );
    }
  } finally {
    await companyKnowledge.close();
  }

  if (results.length === 0) {
    console.log("No questions completed evaluation.");
    return;
  }

  // Compute Metrics
  const total = results.length;
  const correct = results.filter((r) => r.answerCorrect).length;
  const accuracyPct = Math.round((correct / total) * 100);

  const avgRecall =
    Math.round((results.reduce((acc, r) => acc + r.citationRecall, 0) / total) * 100);

  const perfectIntegrity =
    results.filter((r) => r.citationIntegrity).length;
  const integrityPct = Math.round((perfectIntegrity / total) * 100);

  const avgLatency =
    (results.reduce((acc, r) => acc + r.latencyMs, 0) / total / 1000).toFixed(2);

  console.log("\n==================================================================");
  console.log("                  OrgForge Evaluation Scorecard                   ");
  console.log("==================================================================");
  console.log(`Evaluated Questions:      ${total}`);
  console.log(`Factual Accuracy:         ${accuracyPct}% (${correct}/${total})`);
  console.log(`Ground-Truth Recall:      ${avgRecall}%`);
  console.log(`Citation Integrity:       ${integrityPct}% (zero hallucinated source IDs)`);
  console.log(`Mean Turn Latency:        ${avgLatency}s`);
  console.log("------------------------------------------------------------------");

  // Breakdown by question type
  const types = ["PERSPECTIVE", "SILENCE", "COUNTERFACTUAL"] as const;
  console.log("\nBreakdown by Category:");
  for (const t of types) {
    const subset = results.filter((r) => r.questionType === t);
    if (subset.length > 0) {
      const subCorrect = subset.filter((r) => r.answerCorrect).length;
      const subAcc = Math.round((subCorrect / subset.length) * 100);
      const subRecall = Math.round(
        (subset.reduce((acc, r) => acc + r.citationRecall, 0) / subset.length) * 100,
      );
      console.log(
        `  • ${t.padEnd(16)}: ${subAcc}% Accuracy (${subCorrect}/${subset.length}) | ${subRecall}% Citation Recall`,
      );
    }
  }
  console.log("==================================================================\n");

  // Save report
  if (config.saveReport) {
    const outDir = path.join(__dirname, "../../docs/evaluation");
    await mkdir(outDir, { recursive: true });
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(outDir, `orgforge-eval-${runId}.json`);

    const report = {
      timestamp: new Date().toISOString(),
      model: config.model,
      summary: {
        totalQuestions: total,
        accuracyPct,
        citationRecallPct: avgRecall,
        citationIntegrityPct: integrityPct,
        avgLatencySec: Number(avgLatency),
      },
      results,
    };

    await writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`Detailed JSON report saved to:\n  ${outPath}\n`);
  }
}

run().catch((err) => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
