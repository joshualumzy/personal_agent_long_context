import type { ActionKind, Tier } from "./domain.js";

/**
 * Deterministic risk tiering for meeting actions. The model that reads the
 * transcript only ever proposes a `kind` and some `details`; it never picks
 * the tier. Everything below is a pure function of that kind (and, for the
 * escalation override, of the candidate's own words), so the same input
 * always gets the same tier and a reviewer can predict it without a model
 * call.
 */

const AUTO_KINDS: ReadonlySet<ActionKind> = new Set(["answer_question", "flag_conflict"]);
const APPROVAL_KINDS: ReadonlySet<ActionKind> = new Set([
  "email_draft",
  "ticket_draft",
  "calendar_draft",
  "hiring_request",
]);

/** Maps a candidate's kind to its risk tier. `details` is accepted for a
 * uniform call signature; the tier for every kind except "escalation" is
 * fixed, and a money/contract candidate is already retagged "escalation" by
 * `mustEscalate` before this runs, so `details` never has to be inspected
 * here. */
export function tierFor(kind: ActionKind, details: Record<string, unknown>): Tier {
  void details;
  if (kind === "blocked") return "blocked";
  if (kind === "escalation") return "escalate";
  if (AUTO_KINDS.has(kind)) return "auto";
  if (APPROVAL_KINDS.has(kind)) return "approval";
  // Exhaustive over ActionKind above; this is unreachable but keeps the
  // function total rather than throwing on a future kind.
  return "approval";
}

/**
 * Words and currency shapes that force a candidate into "escalation"
 * regardless of what kind the model proposed. Anchored to explicit money or
 * contract language, the same discipline `prohibited-data.ts` uses, so
 * ordinary meeting talk about "the ticket price" of a conference or "a
 * contractor we used" does not trip it unless it actually mentions paying,
 * a refund, a discount, a price change, signing a contract, or an amount of
 * money.
 */
const ESCALATION_PHRASE = /\b(paying|payment|refund(?:ing)?|discount(?:ing)?|price change|contract signing)\b/i;

// "sign(ing) [a/the/our + up to 3 words] contract", so "sign the vendor
// contract" and "signing our new supplier contract" both count, without
// matching an unrelated "sign" or "contract" said far apart.
const CONTRACT_SIGNING = /\bsign(?:ing)?\s+(?:the\s+|a\s+|an\s+|our\s+)?(?:[a-z]+\s+){0,3}contract\b/i;

const CURRENCY_AMOUNT =
  /(?:[$€£¥]|US\$|S\$|USD|SGD|EUR|GBP|CNY|RMB)\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:usd|sgd|eur|gbp|cny|rmb|yuan|dollars?)\b/i;

function candidateText(candidate: { summary: string; details: Record<string, unknown> }): string {
  const detailWords = Object.values(candidate.details)
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return `${candidate.summary} ${detailWords}`;
}

/**
 * Returns a human-readable reason when a candidate's own words touch money
 * or a contract, or null when it does not. The caller retags the candidate's
 * kind as "escalation" when this returns non-null; nothing here mutates the
 * candidate.
 */
export function mustEscalate(candidate: { summary: string; details: Record<string, unknown> }): string | null {
  const text = candidateText(candidate);
  const phraseMatch = ESCALATION_PHRASE.exec(text);
  if (phraseMatch) {
    return `Mentions "${phraseMatch[0].toLowerCase()}", which needs a named approver.`;
  }
  const contractMatch = CONTRACT_SIGNING.exec(text);
  if (contractMatch) {
    return `Mentions "${contractMatch[0].toLowerCase()}", which needs a named approver.`;
  }
  if (CURRENCY_AMOUNT.test(text)) {
    return "Mentions a currency amount, which needs a named approver.";
  }
  return null;
}
