/**
 * Memora dataset loading and sample selection.
 *
 * Only conversation text and its date ever leave this module toward the
 * agent. Operation labels, `share_memory` flags, memory evidence, forgetting
 * evidence, and expected answers stay here and in the grader, which is what
 * makes the result a measurement of Memory rather than of metadata leakage.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface EvaluationCriterion {
  evaluation_question_id: string;
  evaluation_question: string;
  expected_answer: "yes" | "no";
  evaluation_type: "memory_presence" | "forgetting_absence";
}

export interface MemoraQuestion {
  question_id: string;
  question: string;
  question_date: string;
  evaluation: { evaluation_questions: EvaluationCriterion[] };
}

export interface SelectedQuestion {
  persona: string;
  split: string;
  category: string;
  question: MemoraQuestion;
  presenceCriteria: number;
  forgettingCriteria: number;
}

/** A dated block of conversation text, the only thing the agent receives. */
export interface TranscriptChunk {
  sourceId: string;
  recordedAt: string;
  text: string;
  sessionIds: number[];
}

interface SessionFile {
  session_id: number;
  date: string;
  conversation: { turn: number; speaker: string; message: string }[];
}

/**
 * Product limit in src/application.ts is 50,000 characters. The smaller
 * default keeps each ingestion turn inside the App Server timeout: a
 * 48,000-character Transcript exceeded 180 seconds and was rejected.
 */
const chunkCharBudget = Number(process.env.MEMORA_CHUNK_CHARS ?? 20_000);

export async function loadQuestions(
  dataDir: string,
  split: string,
  persona: string,
): Promise<{ category: string; question: MemoraQuestion }[]> {
  const file = path.join(
    dataDir,
    split,
    persona,
    `evaluation_questions_${persona}.json`,
  );
  const parsed = JSON.parse(await readFile(file, "utf8")) as {
    questions: Record<string, MemoraQuestion[]>;
  };

  return Object.entries(parsed.questions).flatMap(([category, questions]) =>
    questions.map((question) => ({ category, question })),
  );
}

/**
 * Selects the questions that carry forgetting criteria. A forgetting
 * criterion exists only where the timeline added something and later updated
 * or deleted it, so this is the mutation-heavy subset by construction.
 */
export function selectMutationHeavy(
  split: string,
  persona: string,
  questions: { category: string; question: MemoraQuestion }[],
): SelectedQuestion[] {
  return questions
    .map(({ category, question }) => {
      const criteria = question.evaluation.evaluation_questions;
      return {
        split,
        persona,
        category,
        question,
        presenceCriteria: criteria.filter(
          (criterion) => criterion.evaluation_type === "memory_presence",
        ).length,
        forgettingCriteria: criteria.filter(
          (criterion) => criterion.evaluation_type === "forgetting_absence",
        ).length,
      };
    })
    .filter((candidate) => candidate.forgettingCriteria > 0)
    .sort((left, right) =>
      left.question.question_id.localeCompare(right.question.question_id),
    );
}

/**
 * Reads a persona's sessions in chronological order and groups them into
 * dated Transcripts. A day becomes one Transcript unless it exceeds the
 * character budget, in which case it is split into parts that preserve
 * order. This is a declared adaptation: the product's unit is a Transcript,
 * and one day of conversation is the closest natural unit to it.
 */
export async function loadTimeline(
  dataDir: string,
  split: string,
  persona: string,
): Promise<TranscriptChunk[]> {
  const directory = path.join(dataDir, split, persona, "conversations");
  const files = (await readdir(directory))
    .filter((name) => name.startsWith("session_") && name.endsWith(".json"))
    .sort(
      (left, right) =>
        Number(left.replace(/\D/g, "")) - Number(right.replace(/\D/g, "")),
    );

  const sessions: SessionFile[] = [];
  for (const name of files) {
    sessions.push(
      JSON.parse(await readFile(path.join(directory, name), "utf8")) as SessionFile,
    );
  }
  sessions.sort((left, right) => left.session_id - right.session_id);

  const chunks: TranscriptChunk[] = [];
  let current: TranscriptChunk | null = null;
  let partsForDay = 0;

  for (const session of sessions) {
    const text = session.conversation
      .map((turn) => `${turn.speaker === "ai_agent" ? "assistant" : "me"}: ${turn.message}`)
      .join("\n");

    const startsNewDay = current === null || !current.sourceId.includes(session.date);
    const wouldOverflow =
      current !== null && current.text.length + text.length + 2 > chunkCharBudget;

    if (startsNewDay || wouldOverflow) {
      partsForDay = startsNewDay ? 1 : partsForDay + 1;
      current = {
        sourceId: `${split}-${persona}-${session.date}-part${partsForDay}`,
        // Midday UTC keeps the recorded date unambiguous in any timezone.
        recordedAt: `${session.date}T12:00:00.000Z`,
        text,
        sessionIds: [session.session_id],
      };
      chunks.push(current);
      continue;
    }

    current!.text += `\n\n${text}`;
    current!.sessionIds.push(session.session_id);
  }

  return chunks;
}
