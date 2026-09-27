import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresCompanyKnowledge } from "../../src/adapters/postgres-company-knowledge.js";
import { embeddingProviderFromEnvironment } from "../../src/embeddings.js";
import { SoCLaaSCompanyAgent } from "../../src/soclaas-company-agent.js";
import {
  getExpectedArtifacts,
  getExpectedBooleanAnswer,
  getQuestionActor,
  loadBenchmarkQuestions,
  type OrgForgeBenchmarkQuestion,
} from "./dataset.js";
import { evaluateQuestionResponse, type QuestionEvaluationResult } from "./judge.js";
import { groundBenchmarkQuestion } from "./temporal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface RunConfig {
  limit: number;
  offset?: number;
  random?: boolean;
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
  let offset = 0;
  let random = false;
  let type: "PERSPECTIVE" | "SILENCE" | "COUNTERFACTUAL" | undefined;
  let actor: string | undefined;
  let saveReport = true;
  let providerOrModel = "soclaas";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--all") {
      limit = 78;
    } else if (arg === "--limit" && args[i + 1]) {
      limit = Number.parseInt(args[++i], 10);
    } else if (arg === "--offset" && args[i + 1]) {
      offset = Number.parseInt(args[++i], 10);
    } else if (arg === "--random") {
      random = true;
    } else if (arg === "--type" && args[i + 1]) {
      type = args[++i].toUpperCase() as "PERSPECTIVE" | "SILENCE" | "COUNTERFACTUAL";
    } else if (arg === "--actor" && args[i + 1]) {
      actor = args[++i];
    } else if (arg === "--no-save") {
      saveReport = false;
    } else if ((arg === "--provider" || arg === "--model") && args[i + 1]) {
      providerOrModel = args[++i].toLowerCase();
    }
  }

  const isSonnet = providerOrModel.includes("sonnet") || providerOrModel.includes("claude");
  const databaseUrl = process.env.DATABASE_URL;
  const gatewayUrl = (process.env.LLM_GATEWAY_URL || process.env.LM_GATEWAY_URL)?.replace(/\/$/, "");
  const apiKey = isSonnet
    ? (process.env.LLM_GATEWAY_API_KEY || process.env.LM_GATEWAY_API_KEY)
    : process.env.SOCLAAS_API_KEY;
  const baseUrl = isSonnet
    ? (gatewayUrl ? `${gatewayUrl}/v1` : "https://api.softwaresystems.app/v1")
    : (process.env.SOCLAAS_BASE_URL ?? "https://soclaas-api.comp.nus.edu.sg/v1");
  const model = isSonnet
    ? (process.env.LLM_MODEL ?? "global.anthropic.claude-sonnet-4-5-20250929-v1:0")
    : (process.env.SOCLAAS_COMPANY_MODEL ?? "qwen3.8:27b");

  if (!databaseUrl) throw new Error("DATABASE_URL is required in .env");
  if (!apiKey) {
    throw new Error(isSonnet ? "LLM_GATEWAY_API_KEY is required in .env for Sonnet evaluation" : "SOCLAAS_API_KEY is required in .env");
  }

  return {
    limit,
    offset,
    random,
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
  if (config.offset) console.log(`Offset:        ${config.offset}`);
  if (config.random) console.log(`Random Sample: true`);
  if (config.type) console.log(`Filter Type:   ${config.type}`);
  if (config.actor) console.log(`Filter Actor:  ${config.actor}`);
  console.log("------------------------------------------------------------------\n");

  const allQuestions = await loadBenchmarkQuestions({
    type: config.type,
    limit: config.limit,
    offset: config.offset,
    random: config.random,
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
    corporateDate: "2026-03-25",
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

      const groundedQuestion = groundBenchmarkQuestion(q.question_text, q.day);
      const startTime = Date.now();
      let agentResult: { answer: string; sources: { sourceId: string; title: string }[]; retrievedSources?: { sourceId: string; title: string }[] };

      try {
        agentResult = await companyAgent.answer({
          employeeId,
          question: groundedQuestion,
        });
      } catch (err) {
        console.log(`\n    ❌ Error during agent execution: ${err instanceof Error ? err.message : String(err)}`);
        results.push({
          questionId: q.question_id,
          questionType: q.question_type,
          questionText: q.question_text,
          groundedQuestion,
          actor: actorName,
          expectedAnswer: getExpectedBooleanAnswer(q),
          judgedAnswer: "error",
          answerCorrect: false,
          expectedArtifacts: getExpectedArtifacts(q),
          citedArtifacts: [],
          retrievedArtifacts: [],
          citationRecall: 0,
          citationIntegrity: false,
          agentStatus: "error",
          agentAnswer: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
          latencyMs: Date.now() - startTime,
        });
        continue;
      }

      const elapsed = Date.now() - startTime;

      const evalResult = await evaluateQuestionResponse(
        q,
        agentResult,
        elapsed,
        judgeOptions,
        groundedQuestion,
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

  const targetQuestions = results.filter((r) => r.expectedArtifacts && r.expectedArtifacts.length > 0);
  const avgTargetRecall = targetQuestions.length > 0
    ? Math.round(
        (targetQuestions.reduce((acc, r) => acc + r.citationRecall, 0) / targetQuestions.length) * 100,
      )
    : 0;

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
  console.log(`Target Evidence Recall:   ${avgTargetRecall}% (exact match across ${targetQuestions.length} questions with targets)`);
  console.log(`Citation Integrity:       ${integrityPct}% (all cited IDs verified in retrieved set)`);
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
      const subTargetQuestions = subset.filter((r) => r.expectedArtifacts && r.expectedArtifacts.length > 0);
      const subRecall = subTargetQuestions.length > 0
        ? Math.round(
            (subTargetQuestions.reduce((acc, r) => acc + r.citationRecall, 0) / subTargetQuestions.length) * 100,
          )
        : 0;
      console.log(
        `  • ${t.padEnd(16)}: ${subAcc}% Accuracy (${subCorrect}/${subset.length}) | ${subRecall}% Exact Recall (${subTargetQuestions.length} targets)`,
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

    let commitSha = "unknown";
    try {
      const { execSync } = await import("node:child_process");
      commitSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    } catch {
      // ignore
    }

    const report = {
      timestamp: new Date().toISOString(),
      commitSha,
      model: config.model,
      summary: {
        totalQuestions: total,
        accuracyPct,
        targetCitationRecallPct: avgTargetRecall,
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
