import type { OrgForgeBenchmarkQuestion } from "./dataset.js";
import { getExpectedArtifacts, getReferenceAnswer } from "./dataset.js";

export interface JudgeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface QuestionEvaluationResult {
  questionId: string;
  questionType: string;
  questionText: string;
  groundedQuestion?: string;
  actor?: string;
  /** The ground truth as a reference conclusion (or "evidence_grounded" when there is none). */
  expectedAnswer: string;
  /** The judge's verdict against the reference: agrees / disagrees / inconclusive. */
  judgedAnswer: string;
  answerCorrect: boolean;
  expectedArtifacts: string[];
  citedArtifacts: string[];
  retrievedArtifacts: string[];
  citationRecall: number; // fraction of expected artifacts that were cited
  citationIntegrity: boolean; // all cited artifacts were actually in the retrieved set
  agentStatus: string;
  agentAnswer: string;
  latencyMs: number;
  toolCalls: Array<{ name: string; arguments: unknown }>;
}

export type Verdict = "agrees" | "disagrees" | "inconclusive";

const judgePrompt = [
  "You are an objective evaluator grading an AI assistant's answer to a workplace question against a reference answer.",
  "Decide whether the assistant's final conclusion agrees with the reference answer's conclusion.",
  "Judge the conclusion only, not the evidence, citations, style, or extra detail. The question may be phrased negatively",
  "(e.g. 'would X have been outside the visibility of...') or as an either/or; compare meaning, not the literal words yes/no.",
  "If the assistant does not commit to a conclusion (says it cannot determine, or hedges both ways), answer 'inconclusive'.",
  "Reply with exactly one word: agrees, disagrees, or inconclusive.",
].join("\n");

/** Reads the judge's one-word reply; anything else is inconclusive rather than guessed at. */
export function parseVerdict(raw: string): Verdict {
  const word = raw.trim().toLowerCase().match(/^[^a-z]*([a-z]+)/)?.[1];
  if (word === "agrees" || word === "agree") return "agrees";
  if (word === "disagrees" || word === "disagree") return "disagrees";
  return "inconclusive";
}

export async function judgeAgainstReference(
  options: JudgeOptions,
  questionText: string,
  reference: string,
  answerText: string,
): Promise<Verdict> {
  const res = await fetch(`${options.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0,
      max_tokens: 20,
      ...(/qwen/i.test(options.model)
        ? { chat_template_kwargs: { enable_thinking: false } }
        : {}),
      messages: [
        { role: "system", content: judgePrompt },
        {
          role: "user",
          content: [
            `QUESTION: ${questionText}`,
            "",
            `REFERENCE ANSWER: ${reference}`,
            "",
            `ASSISTANT ANSWER: ${answerText}`,
            "",
            "Does the assistant's conclusion agree with the reference answer?",
          ].join("\n"),
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Judge request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return parseVerdict(data.choices?.[0]?.message?.content ?? "");
}

/** The judge used for every run, whichever model is under test, so runs are comparable. */
export function judgeOptionsFromEnvironment(env: Record<string, string | undefined>): JudgeOptions {
  const apiKey = env.JUDGE_API_KEY ?? env.SOCLAAS_API_KEY;
  if (!apiKey) throw new Error("JUDGE_API_KEY or SOCLAAS_API_KEY is required for the judge.");
  return {
    apiKey,
    baseUrl: (env.JUDGE_BASE_URL ?? env.SOCLAAS_BASE_URL ?? "https://soclaas-api.comp.nus.edu.sg/v1").replace(/\/$/, ""),
    model: env.JUDGE_MODEL ?? env.SOCLAAS_COMPANY_MODEL ?? "qwen3.8:27b",
  };
}

export async function evaluateQuestionResponse(
  question: OrgForgeBenchmarkQuestion,
  agentResult: {
    answer: string;
    sources: { sourceId: string; title: string }[];
    status?: string;
    retrievedSources?: { sourceId: string; title: string }[];
    toolCalls?: Array<{ name: string; arguments: unknown }>;
  },
  latencyMs: number,
  judgeOptions?: JudgeOptions,
  groundedQuestion?: string,
): Promise<QuestionEvaluationResult> {
  const expectedArtifacts = getExpectedArtifacts(question);
  const reference = getReferenceAnswer(question);

  const citedIds = agentResult.sources.map((s) => s.sourceId);
  const retrievedIds = (agentResult.retrievedSources && agentResult.retrievedSources.length > 0)
    ? agentResult.retrievedSources.map((s) => s.sourceId)
    : citedIds;

  // Citation recall: exact artifact ID match fraction
  let exactHits = 0;
  for (const exp of expectedArtifacts) {
    if (citedIds.some((id) => id.toLowerCase() === exp.toLowerCase())) {
      exactHits++;
    }
  }
  // When no expected artifacts are specified, recall is 0 rather than artificially inflated 1.0
  const citationRecall = expectedArtifacts.length > 0 ? exactHits / expectedArtifacts.length : 0;

  // Citation integrity: all cited IDs must actually exist in the retrieved set
  const citationIntegrity = citedIds.length === 0 || (
    retrievedIds.length > 0 &&
    citedIds.every((cited) =>
      retrievedIds.some((r) => r.toLowerCase() === cited.toLowerCase()),
    )
  );

  let judgedAnswer: string = "inconclusive";
  let answerCorrect = false;

  if (reference !== null) {
    if (judgeOptions) {
      judgedAnswer = await judgeAgainstReference(judgeOptions, question.question_text, reference, agentResult.answer);
    }
    answerCorrect = judgedAnswer === "agrees";
  } else {
    // If not a simple boolean, check whether expected artifacts were cited
    answerCorrect = citationRecall > 0;
    judgedAnswer = citationRecall > 0 ? "grounded" : "ungrounded";
  }

  return {
    questionId: question.question_id,
    questionType: question.question_type,
    questionText: question.question_text,
    groundedQuestion,
    actor: question.actor ?? question.actors?.[0],
    expectedAnswer: reference ?? "evidence_grounded",
    judgedAnswer,
    answerCorrect,
    expectedArtifacts,
    citedArtifacts: citedIds,
    retrievedArtifacts: retrievedIds,
    citationRecall,
    citationIntegrity,
    agentStatus: agentResult.status ?? "answered",
    agentAnswer: agentResult.answer,
    latencyMs,
    toolCalls: agentResult.toolCalls ?? [],
  };
}
