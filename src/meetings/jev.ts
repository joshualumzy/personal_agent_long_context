import type { CompanyKnowledge, Evidence } from "../company-domain.js";
import type { ConflictPayload, Decision } from "./domain.js";

/**
 * Jev, TypeSafe's decision model, through Vercel AI Gateway. It writes no
 * text: it answers declared questions (choice, score, boolean) with a
 * probability for every option, which is what makes it useful for the
 * agent's yes/no and which-one calls. See docs/jev-notes for measurements.
 */

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option name -> what it means. At most 255 options. */
  criteria: Record<string, string>;
}

export interface ChoiceAnswer {
  choice: string;
  /** Probability Jev gives the chosen option. */
  probability: number;
}

const ENDPOINT = "https://ai-gateway.vercel.sh/v1/evaluate";

/**
 * Asks every question in one request. The service returns an occasional 503
 * (sometimes in runs); an immediate retry usually succeeds and waiting only
 * adds delay, so `retries` immediate retries are made before giving up.
 */
export async function askJev(
  apiKey: string,
  state: unknown,
  questions: Record<string, ChoiceQuestion>,
  options: { fetchImpl?: typeof fetch; retries?: number; timeoutMs?: number } = {},
): Promise<Record<string, ChoiceAnswer>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = () =>
    fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "typesafe-ai/jev", state, questions }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  let response = await request();
  for (let attempt = 0; attempt < (options.retries ?? 2) && (response.status === 503 || response.status === 429); attempt += 1) {
    response = await request();
  }
  const body = (await response.json()) as {
    answers?: Record<string, { choice?: string; probabilities?: Record<string, number> }>;
    error?: { message?: string };
  };
  if (!response.ok || !body.answers) {
    throw new Error(`Jev request failed (HTTP ${response.status}): ${body.error?.message ?? "no answers"}`);
  }
  return Object.fromEntries(
    Object.entries(body.answers).map(([id, answer]) => [
      id,
      { choice: answer.choice ?? "", probability: answer.choice ? answer.probabilities?.[answer.choice] ?? 0 : 0 },
    ]),
  );
}

export type ConflictChecker = (
  decision: Decision,
  priorDecisions: ReadonlyArray<Decision & { meetingId: string; title: string }>,
  knowledge: CompanyKnowledge,
) => Promise<ConflictPayload | null>;

const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/**
 * Checks a new decision against earlier decisions and related company
 * records with one Jev choice question: which one it contradicts, or none.
 * An answer below `threshold`, or a failed request, goes to `fallback` (the
 * meeting model), so Jev only decides when it is sure.
 */
export function jevConflictChecker(
  apiKey: string,
  fallback: ConflictChecker,
  options: { threshold?: number; fetchImpl?: typeof fetch; onFallback?: (reason: string) => void } = {},
): ConflictChecker {
  const threshold = options.threshold ?? 0.6;
  return async (decision, priorDecisions, knowledge) => {
    const evidence = await knowledge.search(decision.text, 5).catch(() => [] as Evidence[]);
    // The same decision heard in several meetings is one option, not many.
    const seen = new Set<string>();
    const priors = priorDecisions
      .filter((prior) => {
        const key = prior.text.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(-40);
    if (priors.length === 0 && evidence.length === 0) return null;
    const criteria: Record<string, string> = {
      // Not "agrees with them": agreeing with one earlier entry must not hide
      // a contradiction with another.
      none: "it contradicts not a single one of the entries below",
      ...Object.fromEntries(priors.map((prior, index) => [`d${index}`, `it contradicts the earlier decision "${clip(prior.text, 300)}"`])),
      ...Object.fromEntries(evidence.map((item, index) => [`e${index}`, `it contradicts this company record: "${clip(item.excerpt, 300)}"`])),
    };
    let answer: ChoiceAnswer | undefined;
    try {
      answer = (
        await askJev(
          apiKey,
          { newDecision: decision.text },
          { contradicts: { type: "choice", instructions: "Does the new decision contradict any one of the earlier decisions or company records? If it contradicts even one, pick that one, even if it agrees with others.", criteria } },
          options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
        )
      ).contradicts;
    } catch (error) {
      options.onFallback?.(error instanceof Error ? error.message : String(error));
      return fallback(decision, priorDecisions, knowledge);
    }
    if (!answer || answer.probability < threshold || !(answer.choice in criteria)) {
      options.onFallback?.(`Jev unsure (${answer?.choice ?? "no answer"}, ${answer?.probability.toFixed(2) ?? "0"})`);
      return fallback(decision, priorDecisions, knowledge);
    }
    const sure = `checked by Jev, ${Math.round(answer.probability * 100)}% sure`;
    if (answer.choice === "none") return null;
    const index = Number(answer.choice.slice(1));
    if (answer.choice.startsWith("d")) {
      const prior = priors[index]!;
      return {
        statement: decision.text,
        priorDecision: prior.text,
        priorMeetingId: prior.meetingId,
        explanation: `Contradicts the earlier decision in "${prior.title}" (${sure}).`,
      };
    }
    const record = evidence[index]!;
    return {
      statement: decision.text,
      priorDecision: record.excerpt,
      priorSourceId: record.sourceId,
      explanation: `Contradicts the company record "${record.title}" (${sure}).`,
    };
  };
}
