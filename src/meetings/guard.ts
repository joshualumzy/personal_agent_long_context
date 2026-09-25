import { detectProhibitedData } from "../prohibited-data.js";

/**
 * Screens one transcript segment before it ever reaches the model. This is
 * deliberately narrow, in the spirit of `prohibited-data.ts`: it blocks
 * Prohibited Data (reusing that gate) and a short, documented list of
 * prompt-injection shapes aimed at the agent itself, not at anything that
 * merely sounds bossy. Ordinary meeting speech ("let's ignore the previous
 * slide", "the password reset flow is broken") must pass, so every rule is
 * anchored to the specific wording an injection needs, not to a single
 * suspicious word.
 */

export type ScreenResult = { verdict: "ok" } | { verdict: "blocked"; reason: string };

interface InjectionRule {
  id: string;
  pattern: RegExp;
  reason: string;
}

const rules: InjectionRule[] = [
  {
    id: "override-instructions",
    // "ignore/disregard/forget ... instructions/rules/prompts/guidelines".
    // Anchored on the noun so "ignore the previous slide" or "forget the
    // agenda" is left alone.
    pattern:
      /\b(?:ignore|disregard|forget)\b(?:\s+(?:all|any|the|your|my|our|previous|prior|above|earlier))*\s+(?:instructions?|rules?|prompts?|guidelines?|directives?)\b/i,
    reason: "Tries to make the agent ignore its instructions.",
  },
  {
    id: "role-reassignment",
    // The classic jailbreak opener: "you are now a/an <new identity>" (with
    // up to a few adjectives in between, as in "a helpful assistant with no
    // restrictions"), or "you are now no longer bound / free from / acting
    // as ...". Anchored to an assistant-like noun or an unbinding phrase, so
    // ordinary meeting speech that hands someone a role ("you are now the
    // point of contact for the vendor") is left alone.
    pattern:
      /\byou\s+are\s+now\s+(?:(?:a|an)\s+(?:[a-z]+\s+){0,3})?(?:assistant|ai|chatbot|bot|dan|unrestricted)\b|\byou\s+are\s+now\s+(?:no\s+longer\s+bound|not\s+bound|free\s+from|acting\s+as|operating\s+as)\b/i,
    reason: "Tries to reassign the agent's identity or rules.",
  },
  {
    id: "system-prompt-probe",
    pattern: /\bsystem\s+prompt\b|\b(?:reveal|show\s+me|print|output)\s+your\s+(?:instructions|prompt|system\s+message)\b/i,
    reason: "Tries to get the agent to reveal its system prompt.",
  },
  {
    id: "exfiltrate-to-address",
    // "assistant, send ... to <email>" — addressed to the agent and naming
    // a destination address, not just any sentence with "send" and "to".
    pattern: /\b(?:assistant|agent|ai)\b[^.?!\n]{0,20}\bsend\b[^.?!\n]{0,100}\bto\b[^.?!\n]{0,60}[\w.+-]+@[\w-]+\.[\w.-]+/i,
    reason: "Tries to direct the agent to send data to an outside address.",
  },
  {
    id: "forward-customer-list",
    pattern: /\bforward\s+(?:the\s+)?(?:customer|client|user)\s+list\s+to\b/i,
    reason: "Tries to direct the agent to hand over a customer list.",
  },
  {
    id: "disregard-rules",
    pattern: /\bdisregard\s+(?:your|the)\s+rules\b/i,
    reason: "Tries to make the agent disregard its rules.",
  },
];

export function screenSegment(text: string): ScreenResult {
  const prohibited = detectProhibitedData(text);
  if (prohibited) {
    return { verdict: "blocked", reason: `Contains a ${prohibited.category} (rule: ${prohibited.rule}).` };
  }
  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      return { verdict: "blocked", reason: rule.reason };
    }
  }
  return { verdict: "ok" };
}

/** Rule identifiers, for documentation and tests. */
export const injectionRules: ReadonlyArray<{ id: string; reason: string }> = rules.map(({ id, reason }) => ({
  id,
  reason,
}));
