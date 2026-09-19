export type ProhibitedCategory =
  | "authentication secret"
  | "private key"
  | "payment or bank detail"
  | "government identifier";

interface Detector {
  category: ProhibitedCategory;
  pattern: RegExp;
}

const detectors: Detector[] = [
  {
    category: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  },
  {
    category: "authentication secret",
    pattern:
      /\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)\s*(?:is\s*[:=]?|[:=])[ \t]*\S{6,}/i,
  },
  {
    category: "payment or bank detail",
    pattern:
      /\b(?:card number|credit card|bank account|iban)\s*(?:is|=|:)[ \t]*[A-Z0-9][A-Z0-9 -]{7,33}\b/i,
  },
  {
    category: "government identifier",
    pattern: /\b\d{3}-\d{2}-\d{4}\b|\b[STFGM]\d{7}[A-Z]\b/i,
  },
];

export function detectProhibitedData(text: string): ProhibitedCategory | null {
  return detectors.find(({ pattern }) => pattern.test(text))?.category ?? null;
}
