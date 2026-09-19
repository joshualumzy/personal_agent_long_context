/**
 * Basic Prohibited Data detection.
 *
 * This is a deliberately narrow, documented gate, not comprehensive PII
 * classification. It targets the categories that
 * `docs/research/pii-privacy-policy.md` says must never reach agent memory,
 * prompts, or logs: authentication secrets, private keys, payment or bank
 * details, and government identifiers.
 *
 * Two design rules keep it from swallowing ordinary Useful Personal Context:
 *
 * 1. Every rule is anchored to a nearby label ("my password is", "card number:")
 *    or to a structurally unmistakable token (a PEM header, a vendor key
 *    prefix). A bare number or the word "password" on its own is not enough.
 * 2. Card-like digit runs must pass a Luhn check before they count, so order
 *    numbers, flight numbers, and years are left alone.
 *
 * Each rule carries an id so a rejection can be explained without quoting the
 * detected value.
 */

export type ProhibitedCategory =
  | "authentication secret"
  | "private key"
  | "payment or bank detail"
  | "government identifier";

export interface ProhibitedMatch {
  category: ProhibitedCategory;
  rule: string;
}

interface Rule {
  id: string;
  category: ProhibitedCategory;
  pattern: RegExp;
  /** Extra check applied to capture group 1 before the rule counts as a match. */
  confirm?: (captured: string) => boolean;
}

const secretLabel =
  "password|passphrase|passwd|pin(?: code| number)?|api[ _-]?key|secret[ _-]?key|access[ _-]?token|refresh[ _-]?token|bearer[ _-]?token|auth(?:entication)?[ _-]?token|client[ _-]?secret|one[ _-]?time[ _-]?(?:code|password)|otp|2fa[ _-]?code|verification[ _-]?code|security[ _-]?code|recovery[ _-]?code";

function luhn(digits: string): boolean {
  const cleaned = digits.replace(/[^\d]/g, "");
  if (cleaned.length < 13 || cleaned.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let index = cleaned.length - 1; index >= 0; index -= 1) {
    let digit = cleaned.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function nricChecksum(identifier: string): boolean {
  // Singapore NRIC/FIN: prefix letter, seven digits, checksum letter.
  const match = /^([STFGM])(\d{7})([A-Z])$/i.exec(identifier);
  if (!match) return false;

  const [, prefix, digits, checksum] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  const weights = [2, 7, 6, 5, 4, 3, 2];
  let total = weights.reduce(
    (running, weight, index) => running + weight * Number(digits[index]),
    0,
  );
  const upperPrefix = prefix.toUpperCase();
  if (upperPrefix === "T" || upperPrefix === "G") total += 4;
  if (upperPrefix === "M") total += 3;

  const tables: Record<string, string[]> = {
    S: ["J", "Z", "I", "H", "G", "F", "E", "D", "C", "B", "A"],
    T: ["J", "Z", "I", "H", "G", "F", "E", "D", "C", "B", "A"],
    F: ["X", "W", "U", "T", "R", "Q", "P", "N", "M", "L", "K"],
    G: ["X", "W", "U", "T", "R", "Q", "P", "N", "M", "L", "K"],
    M: ["X", "W", "U", "T", "R", "Q", "P", "N", "J", "L", "K"],
  };
  const table = tables[upperPrefix];
  return table !== undefined && table[total % 11] === checksum.toUpperCase();
}

const rules: Rule[] = [
  {
    id: "pem-private-key",
    category: "private key",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/i,
  },
  {
    id: "putty-private-key",
    category: "private key",
    pattern: /PuTTY-User-Key-File-\d/i,
  },
  {
    id: "labelled-secret",
    category: "authentication secret",
    pattern: new RegExp(
      `\\b(?:${secretLabel})\\b[ \\t]*(?:(?:is|was|=|:)[ \\t]*)+["']?(\\S{4,})`,
      "i",
    ),
  },
  {
    id: "vendor-key-prefix",
    category: "authentication secret",
    pattern:
      /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|clsk_[A-Za-z0-9]{4,}_[A-Za-z0-9_-]{8,})\b/,
  },
  {
    id: "recovery-phrase",
    category: "authentication secret",
    pattern:
      /\b(?:recovery|seed|mnemonic|backup)[ _-]?phrase\b[ \t]*(?:is|was|=|:)[ \t]*(\S+(?:[ \t]+\S+){5,})/i,
  },
  {
    id: "payment-card",
    category: "payment or bank detail",
    pattern:
      /\b(?:card(?: number)?|credit[ -]?card|debit[ -]?card|visa|mastercard|amex)\b[^\n]{0,24}?\b((?:\d[ -]?){12,18}\d)\b/i,
    confirm: luhn,
  },
  {
    id: "bare-card-number",
    category: "payment or bank detail",
    pattern: /\b(\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4})\b/,
    confirm: luhn,
  },
  {
    id: "card-security-code",
    category: "payment or bank detail",
    pattern: /\b(?:cvv|cvc|cid|card security code)\b[ \t]*(?:is|=|:)?[ \t]*(\d{3,4})\b/i,
  },
  {
    id: "bank-account",
    category: "payment or bank detail",
    pattern:
      /\b(?:bank account|account number|acct(?: no)?|sort code|routing number|iban|swift(?: code)?|bic)\b[ \t]*(?:is|was|=|:)?[ \t]*([A-Z0-9][A-Z0-9 -]{6,33})\b/i,
  },
  {
    id: "us-social-security-number",
    category: "government identifier",
    pattern: /\b(\d{3}-\d{2}-\d{4})\b/,
  },
  {
    id: "singapore-nric-fin",
    category: "government identifier",
    pattern: /\b([STFGM]\d{7}[A-Z])\b/i,
    confirm: nricChecksum,
  },
  {
    id: "labelled-government-identifier",
    category: "government identifier",
    pattern:
      /\b(?:passport(?: number| no)?|nric|fin number|national id(?:entity)?(?: number)?|driver'?s licence(?: number)?|driver'?s license(?: number)?|tax file number|social security number)\b[ \t]*(?:is|was|=|:)?[ \t]*([A-Z0-9-]{6,})\b/i,
  },
];

export function detectProhibitedData(text: string): ProhibitedMatch | null {
  for (const rule of rules) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    const captured = match[1];
    if (rule.confirm && (captured === undefined || !rule.confirm(captured))) {
      continue;
    }
    return { category: rule.category, rule: rule.id };
  }
  return null;
}

/** Rule identifiers, for documentation and tests. */
export const prohibitedDataRules: ReadonlyArray<{
  id: string;
  category: ProhibitedCategory;
}> = rules.map(({ id, category }) => ({ id, category }));
