/**
 * The grader. It never talks to the agent: it receives the agent's answer
 * text and the benchmark criteria, and decides yes or no for each.
 *
 * Memora's published protocol uses three judges at temperature 0 with a
 * majority vote. This harness uses a single judge, which is a declared
 * deviation recorded in the report.
 */
import type { EvaluationCriterion } from "./dataset.js";

export interface JudgedCriterion extends EvaluationCriterion {
  judged: "yes" | "no";
  correct: boolean;
}

export interface QuestionScore {
  memoryPresenceAccuracy: number;
  forgettingAbsenceAccuracy: number;
  lambda: number;
  fama: number;
  criteria: JudgedCriterion[];
}

export interface JudgeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const judgePrompt = [
  "You are grading one criterion about an assistant's answer.",
  "Read the answer, then answer the criterion question with exactly one word: yes or no.",
  "Judge only what the answer actually says. Do not infer what the assistant might have meant.",
  "Reply with the single word and nothing else.",
].join("\n");

export async function judgeCriterion(
  options: JudgeOptions,
  answer: string,
  criterion: EvaluationCriterion,
): Promise<"yes" | "no"> {
  const response = await fetch(`${options.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0,
      messages: [
        { role: "system", content: judgePrompt },
        {
          role: "user",
          content: [
            "ANSWER:",
            answer,
            "",
            "CRITERION:",
            criterion.evaluation_question,
          ].join("\n"),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Judge request failed with ${response.status}`);
  }

  const body = (await response.json()) as {
    choices: { message: { content: string | null } }[];
  };
  const text = (body.choices[0]?.message?.content ?? "").toLowerCase();
  // A judge that will not commit counts as "no": an unsupported criterion is
  // not evidence that the answer satisfied it.
  return /\byes\b/.test(text) && !/\bno\b/.test(text) ? "yes" : "no";
}

/**
 * Memora's per-question scores.
 *
 *   MPA    = correct memory_presence criteria / memory_presence criteria
 *   FAA    = correct forgetting_absence criteria / forgetting_absence criteria
 *   lambda = N_forget / (N_presence + N_forget)
 *   FAMA   = max(0, MPA - lambda * (1 - FAA))
 *
 * A question with no forgetting criteria has lambda 0, so its FAMA is its MPA.
 */
export function scoreQuestion(criteria: JudgedCriterion[]): QuestionScore {
  const presence = criteria.filter(
    (criterion) => criterion.evaluation_type === "memory_presence",
  );
  const forgetting = criteria.filter(
    (criterion) => criterion.evaluation_type === "forgetting_absence",
  );

  const ratio = (subset: JudgedCriterion[]) =>
    subset.length === 0
      ? 1
      : subset.filter((criterion) => criterion.correct).length / subset.length;

  const memoryPresenceAccuracy = ratio(presence);
  const forgettingAbsenceAccuracy = ratio(forgetting);
  const total = presence.length + forgetting.length;
  const lambda = total === 0 ? 0 : forgetting.length / total;

  return {
    memoryPresenceAccuracy,
    forgettingAbsenceAccuracy,
    lambda,
    fama: Math.max(
      0,
      memoryPresenceAccuracy - lambda * (1 - forgettingAbsenceAccuracy),
    ),
    criteria,
  };
}

export function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}
