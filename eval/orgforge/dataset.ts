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

export function getExpectedBooleanAnswer(question: OrgForgeBenchmarkQuestion): boolean | null {
  const gt = question.ground_truth;
  if (typeof gt.could_actor_have_known === "boolean") {
    // Questions asking if someone was "outside visibility" or had a "blind spot":
    // If they could NOT have known (false), then YES (true) they were outside visibility / had a blind spot.
    const text = question.question_text.toLowerCase();
    const isNegative = text.includes("outside") || text.includes("blind spot") || text.includes("unaware") || text.includes("lack");
    return isNegative ? !gt.could_actor_have_known : gt.could_actor_have_known;
  }
  if (typeof gt.answer === "boolean") {
    return gt.answer;
  }
  if (typeof gt.outcome_changed === "boolean") {
    // In causal counterfactual questions ("Would X still have occurred without Y?"):
    // outcome_changed = true means without Y, X did NOT occur -> surface answer: false (no).
    // outcome_changed = false means without Y, X STILL occurred -> surface answer: true (yes).
    return !gt.outcome_changed;
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

