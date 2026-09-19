/**
 * The Memora evaluation harness.
 *
 * It drives the same application interface the browser uses, so the thing
 * under test is the product, not a parallel code path. Each persona timeline
 * runs against its own user identifier, which routes to its own Letta agent
 * and therefore its own isolated Memory.
 *
 *   npm run eval:memora
 *
 * Configuration comes from the environment; see docs/evaluation/README.md.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { CONSENT_POLICY_VERSION } from "../../src/domain.js";
import {
  answerPrompt,
  ingestPrompt,
} from "../../src/adapters/letta-memory.js";
import {
  loadQuestions,
  loadTimeline,
  selectMutationHeavy,
  type SelectedQuestion,
} from "./dataset.js";
import {
  judgeCriterion,
  mean,
  scoreQuestion,
  type JudgedCriterion,
  type QuestionScore,
} from "./judge.js";

const config = {
  dataDir: process.env.MEMORA_DATA_DIR ?? "",
  commit: process.env.MEMORA_COMMIT ?? "a6493188efc836d6511ed5e4163fe3ba87da30ff",
  split: process.env.MEMORA_SPLIT ?? "weekly",
  personas: (process.env.MEMORA_PERSONAS ?? "software_engineer,academic_researcher")
    .split(",")
    .map((persona) => persona.trim())
    .filter(Boolean),
  appBaseUrl: process.env.APP_BASE_URL ?? "http://127.0.0.1:3000",
  judgeBaseUrl: process.env.SOCLAAS_BASE_URL ?? "",
  judgeApiKey: process.env.SOCLAAS_API_KEY ?? "",
  judgeModel: process.env.MEMORA_JUDGE_MODEL ?? "qwen3.6:35b",
  agentModel: process.env.LETTA_MODEL ?? "unknown",
  runId: process.env.MEMORA_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-"),
};

if (!config.dataDir) {
  throw new Error(
    "Set MEMORA_DATA_DIR to the data directory of a geniesinc/Memora checkout.",
  );
}
if (!config.judgeBaseUrl || !config.judgeApiKey) {
  throw new Error("Set SOCLAAS_BASE_URL and SOCLAAS_API_KEY for the grader.");
}

async function packageVersion(name: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(`node_modules/${name}/package.json`, "utf8"),
  ) as { version: string };
  return manifest.version;
}

async function post(path: string, body: unknown) {
  const started = Date.now();
  const response = await fetch(`${config.appBaseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: parsed, elapsedMs: Date.now() - started };
}

interface QuestionRun {
  persona: string;
  category: string;
  questionId: string;
  question: string;
  answer: string;
  correlationId: string;
  runRef: string | null;
  sources: string[];
  latencyMs: number;
  score: QuestionScore;
}

interface TimelineRun {
  persona: string;
  userId: string;
  transcripts: {
    sourceId: string;
    recordedAt: string;
    chars: number;
    sessionIds: number[];
    status: number;
    correlationId: string;
    latencyMs: number;
  }[];
  questions: QuestionRun[];
}

const output = {
  runId: config.runId,
  startedAt: new Date().toISOString(),
  dataset: { repository: "geniesinc/Memora", commit: config.commit, split: config.split },
  configuration: {
    agentModel: config.agentModel,
    judgeModel: config.judgeModel,
    judges: 1,
    lettaAgentSdk: await packageVersion("@letta-ai/letta-agent-sdk"),
    lettaCode: await packageVersion("@letta-ai/letta-code"),
    appBaseUrl: config.appBaseUrl,
    transcriptGrouping: "one Transcript per persona day, split at 40,000 characters",
  },
  prompts: {
    ingest: ingestPrompt({
      userId: "<user>",
      sourceId: "<source>",
      recordedAt: "<recorded>",
      receivedAt: "<received>",
      transcript: "<transcript text>",
      attestation: "uploader_only_identifiable_speaker",
      policyVersion: CONSENT_POLICY_VERSION,
      correlationId: "<correlation>",
    }),
    answer: answerPrompt({
      userId: "<user>",
      question: "<question>",
      correlationId: "<correlation>",
      receivedAt: "<received>",
    }),
  },
  timelines: [] as TimelineRun[],
  selection: {
    rationale:
      "The weekly split is the shortest published horizon and fits the compute budget. Within each persona every question that carries forgetting_absence criteria is selected, because such criteria exist only where the timeline added something and later updated or deleted it.",
    personas: config.personas,
  },
  finishedAt: null as string | null,
};

const outputPath = `docs/evaluation/memora-run-${config.runId}.json`;
await mkdir("docs/evaluation", { recursive: true });

async function checkpoint() {
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
}

for (const persona of config.personas) {
  const userId = `memora-${config.split}-${persona}-${config.runId}`;
  const timeline: TimelineRun = { persona, userId, transcripts: [], questions: [] };
  output.timelines.push(timeline);

  const chunks = await loadTimeline(config.dataDir, config.split, persona);
  const selected: SelectedQuestion[] = selectMutationHeavy(
    config.split,
    persona,
    await loadQuestions(config.dataDir, config.split, persona),
  );

  console.log(
    `\n=== ${persona}: ${chunks.length} Transcripts, ${selected.length} questions`,
  );

  for (const [index, chunk] of chunks.entries()) {
    const result = await post("/api/v1/transcripts", {
      userId,
      sourceId: chunk.sourceId,
      recordedAt: chunk.recordedAt,
      transcript: chunk.text,
      attestation: "uploader_only_identifiable_speaker",
      policyVersion: CONSENT_POLICY_VERSION,
    });
    timeline.transcripts.push({
      sourceId: chunk.sourceId,
      recordedAt: chunk.recordedAt,
      chars: chunk.text.length,
      sessionIds: chunk.sessionIds,
      status: result.status,
      correlationId: String(result.body.correlationId ?? ""),
      latencyMs: result.elapsedMs,
    });
    console.log(
      `  ingest ${index + 1}/${chunks.length} ${chunk.sourceId} -> ${result.status} in ${(result.elapsedMs / 1000).toFixed(0)}s`,
    );
    if (result.status !== 202) {
      throw new Error(
        `Ingestion failed for ${chunk.sourceId}: ${String(result.body.code)}`,
      );
    }
    await checkpoint();
  }

  for (const candidate of selected) {
    const asked = await post("/api/v1/questions", {
      userId,
      question: candidate.question.question,
    });
    const answer = String(asked.body.answer ?? "");

    const judged: JudgedCriterion[] = [];
    for (const criterion of candidate.question.evaluation.evaluation_questions) {
      const verdict = await judgeCriterion(
        {
          baseUrl: config.judgeBaseUrl,
          apiKey: config.judgeApiKey,
          model: config.judgeModel,
        },
        answer,
        criterion,
      );
      judged.push({
        ...criterion,
        judged: verdict,
        correct: verdict === criterion.expected_answer,
      });
    }

    const score = scoreQuestion(judged);
    timeline.questions.push({
      persona,
      category: candidate.category,
      questionId: candidate.question.question_id,
      question: candidate.question.question,
      answer,
      correlationId: String(asked.body.correlationId ?? ""),
      runRef: (asked.body.runRef as string | undefined) ?? null,
      sources: ((asked.body.sources as { sourceId: string }[] | undefined) ?? []).map(
        (source) => source.sourceId,
      ),
      latencyMs: asked.elapsedMs,
      score,
    });
    console.log(
      `  ${candidate.question.question_id}: MPA ${(score.memoryPresenceAccuracy * 100).toFixed(0)} FAA ${(score.forgettingAbsenceAccuracy * 100).toFixed(0)} FAMA ${(score.fama * 100).toFixed(0)}`,
    );
    await checkpoint();
  }
}

output.finishedAt = new Date().toISOString();
await checkpoint();

const questions = output.timelines.flatMap((timeline) => timeline.questions);
console.log(
  `\nQuestions: ${questions.length}  MPA ${(mean(questions.map((q) => q.score.memoryPresenceAccuracy)) * 100).toFixed(1)}  FAA ${(mean(questions.map((q) => q.score.forgettingAbsenceAccuracy)) * 100).toFixed(1)}  FAMA ${(mean(questions.map((q) => q.score.fama)) * 100).toFixed(1)}`,
);
console.log(`Run written to ${outputPath}`);
