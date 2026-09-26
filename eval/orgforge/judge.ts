import type { OrgForgeBenchmarkQuestion } from "./dataset.js";
import { getExpectedArtifacts, getExpectedBooleanAnswer } from "./dataset.js";

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
  expectedAnswer: boolean | string | null;
  judgedAnswer: boolean | string | "inconclusive";
  answerCorrect: boolean;
  expectedArtifacts: string[];
  citedArtifacts: string[];
  retrievedArtifacts: string[];
  citationRecall: number; // fraction of expected artifacts that were cited
  citationIntegrity: boolean; // all cited artifacts were actually in the retrieved set
  agentStatus: string;
  agentAnswer: string;
  latencyMs: number;
}

const judgePrompt = [
  "You are an objective evaluator assessing an AI assistant's answer to a workplace question.",
  "Based on the assistant's answer, determine if the assistant concluded YES (affirmative) or NO (negative).",
  "Respond with ONLY the single word 'yes' or 'no'. If the assistant concluded insufficient evidence or inconclusive, respond 'inconclusive'.",
].join("\n");

export async function judgeBooleanAnswer(
  options: JudgeOptions,
  question: OrgForgeBenchmarkQuestion,
  answerText: string,
): Promise<"yes" | "no" | "inconclusive"> {
  if (!options.apiKey || !options.baseUrl) {
    return fallbackRegexJudge(answerText);
  }

  try {
    const res = await fetch(`${options.baseUrl}/chat/completions`, {
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
              `QUESTION: ${question.question_text}`,
              "",
              `ASSISTANT ANSWER: ${answerText}`,
              "",
              "Did the assistant conclude YES or NO?",
            ].join("\n"),
          },
        ],
      }),
    });

    if (!res.ok) {
      return fallbackRegexJudge(answerText);
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content?.trim().toLowerCase() ?? "";

    if (raw.includes("yes")) return "yes";
    if (raw.includes("no")) return "no";
    return fallbackRegexJudge(answerText);
  } catch {
    return fallbackRegexJudge(answerText);
  }
}

function fallbackRegexJudge(text: string): "yes" | "no" | "inconclusive" {
  const lower = text.toLowerCase();
  if (/\b(insufficient evidence|not enough evidence|cannot be determined)\b/.test(lower)) {
    return "inconclusive";
  }
  const yesMatches = (lower.match(/\b(yes|would have learned|could have known|did create|was created|true)\b/g) ?? []).length;
  const noMatches = (lower.match(/\b(no|would not have|could not have|was not created|did not create|false)\b/g) ?? []).length;

  if (yesMatches > noMatches) return "yes";
  if (noMatches > yesMatches) return "no";
  return "inconclusive";
}

export async function evaluateQuestionResponse(
  question: OrgForgeBenchmarkQuestion,
  agentResult: {
    answer: string;
    sources: { sourceId: string; title: string }[];
    status?: string;
    retrievedSources?: { sourceId: string; title: string }[];
  },
  latencyMs: number,
  judgeOptions?: JudgeOptions,
  groundedQuestion?: string,
): Promise<QuestionEvaluationResult> {
  const expectedArtifacts = getExpectedArtifacts(question);
  const expectedBool = getExpectedBooleanAnswer(question);

  const citedIds = agentResult.sources.map((s) => s.sourceId);
  const retrievedIds = agentResult.retrievedSources?.map((s) => s.sourceId) ?? citedIds;

  // Citation recall: what fraction of expected artifacts were cited?
  let hits = 0;
  for (const exp of expectedArtifacts) {
    if (citedIds.some((id) => id.toLowerCase().includes(exp.toLowerCase()) || exp.toLowerCase().includes(id.toLowerCase()))) {
      hits++;
    }
  }
  const citationRecall = expectedArtifacts.length > 0 ? hits / expectedArtifacts.length : 1.0;

  // Citation integrity: all cited IDs must be in retrieved set
  const citationIntegrity = citedIds.every((cited) =>
    retrievedIds.some((r) => r.toLowerCase() === cited.toLowerCase()),
  );

  let judgedAnswer: boolean | string | "inconclusive" = "inconclusive";
  let answerCorrect = false;

  if (expectedBool !== null) {
    let judgeVerdict: "yes" | "no" | "inconclusive" = "inconclusive";
    if (judgeOptions) {
      judgeVerdict = await judgeBooleanAnswer(judgeOptions, question, agentResult.answer);
    } else {
      judgeVerdict = fallbackRegexJudge(agentResult.answer);
    }

    if (judgeVerdict === "yes") judgedAnswer = true;
    else if (judgeVerdict === "no") judgedAnswer = false;
    else judgedAnswer = "inconclusive";

    answerCorrect = judgedAnswer === expectedBool;
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
    expectedAnswer: expectedBool ?? "evidence_grounded",
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
  };
}
