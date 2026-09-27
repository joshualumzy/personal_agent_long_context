import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface OrgForgeBenchmarkQuestion {
  question_id: string;
  question_type: "PERSPECTIVE" | "SILENCE" | "COUNTERFACTUAL";
  difficulty?: string;
  question_text: string;
  actors?: string[];
  actor?: string;
  day?: number;
  ground_truth: {
    could_actor_have_known?: boolean;
    answer?: boolean;
    outcome_changed?: boolean;
    outcome?: string;
    reason?: string;
    evidence_artifacts?: string[];
    expected_search_space?: string[];
    evidence_chain_artifacts?: { cause?: string[]; effect?: string[] };
    [key: string]: unknown;
  };
}

export interface LoadQuestionFilter {
  limit?: number;
  offset?: number;
  random?: boolean;
  type?: "PERSPECTIVE" | "SILENCE" | "COUNTERFACTUAL";
  questionId?: string;
}

export async function loadBenchmarkQuestions(
  filter: LoadQuestionFilter = {},
): Promise<OrgForgeBenchmarkQuestion[]> {
  const filePath = path.join(__dirname, "questions.jsonl");
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);

  let questions: OrgForgeBenchmarkQuestion[] = lines.map((line) => {
    const q = JSON.parse(line) as OrgForgeBenchmarkQuestion;
    // Normalize unicode non-breaking spaces
    q.question_text = q.question_text.replace(/[\u202f\u00a0\u2000-\u200b]/g, " ").trim();
    return q;
  });

  if (filter.type) {
    questions = questions.filter((q) => q.question_type === filter.type);
  }

  if (filter.questionId) {
    questions = questions.filter((q) => q.question_id === filter.questionId);
  }

  if (filter.random) {
    for (let i = questions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = questions[i]!;
      questions[i] = questions[j]!;
      questions[j] = temp;
    }
  }

  const offset = filter.offset ?? 0;
  if (filter.limit && filter.limit > 0) {
    questions = questions.slice(offset, offset + filter.limit);
  } else if (offset > 0) {
    questions = questions.slice(offset);
  }

  return questions;
}

export function getExpectedArtifacts(question: OrgForgeBenchmarkQuestion): string[] {
  const gt = question.ground_truth;
  const artifacts: string[] = [];

  if (Array.isArray(gt.evidence_artifacts)) {
    artifacts.push(...gt.evidence_artifacts);
  }
  if (Array.isArray(gt.expected_search_space)) {
    artifacts.push(...gt.expected_search_space);
  }
  if (gt.evidence_chain_artifacts) {
    if (Array.isArray(gt.evidence_chain_artifacts.cause)) {
      artifacts.push(...gt.evidence_chain_artifacts.cause);
    }
    if (Array.isArray(gt.evidence_chain_artifacts.effect)) {
      artifacts.push(...gt.evidence_chain_artifacts.effect);
    }
  }

  return Array.from(new Set(artifacts));
}

/**
 * The ground truth stated as a conclusion a reader can compare an answer against.
 *
 * Questions are phrased every which way — "would X have known", "would X have been
 * outside the visibility of", "was it a consequence of A, or would it have happened
 * regardless" — so reducing an answer to yes/no and flipping by keyword cannot be
 * scored reliably. Stating what the answer should conclude sidesteps the phrasing.
 */
export function getReferenceAnswer(question: OrgForgeBenchmarkQuestion): string | null {
  const gt = question.ground_truth;
  if (typeof gt.could_actor_have_known === "boolean") {
    return gt.could_actor_have_known
      ? "The person could have known about this: it was within their visibility through the systems and channels available to them by that time."
      : "The person could not have known about this: it was outside their visibility by that time (a blind spot).";
  }
  if (typeof gt.answer === "boolean") {
    return gt.answer
      ? "Yes: the response the question asks about was created / did happen."
      : "No: the response the question asks about was never created / did not happen.";
  }
  if (typeof gt.outcome_changed === "boolean") {
    const detail = typeof gt.outcome === "string" && gt.outcome.trim() ? ` Specifically: ${gt.outcome.trim()}.` : "";
    return gt.outcome_changed
      ? `The cause described in the question mattered: without it, the outcome would have been different.${detail}`
      : `The outcome would have happened anyway, regardless of the cause described in the question.${detail}`;
  }
  return null;
}

export function getQuestionActor(
  question: OrgForgeBenchmarkQuestion,
  validEmployees?: Set<string>,
): string {
  const check = (name: string | undefined): string | null => {
    if (!name) return null;
    const lower = name.toLowerCase().trim();
    if (!validEmployees || validEmployees.has(lower)) {
      return lower;
    }
    return null;
  };

  const direct = check(question.actor);
  if (direct) return direct;

  if (Array.isArray(question.actors)) {
    for (const a of question.actors) {
      const match = check(a);
      if (match) return match;
    }
  }

  const triggerActors = (question.ground_truth as { trigger_actors?: string[] })?.trigger_actors;
  if (Array.isArray(triggerActors)) {
    for (const a of triggerActors) {
      const match = check(a);
      if (match) return match;
    }
  }

  if (validEmployees) {
    for (const emp of validEmployees) {
      const regex = new RegExp(`\\b${emp}\\b`, "i");
      if (regex.test(question.question_text)) {
        return emp;
      }
    }
  }

  return "jax";
}

