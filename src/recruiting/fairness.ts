/**
 * Hiring criteria must not select on protected characteristics. This follows
 * Singapore's Tripartite Guidelines on Fair Employment Practices, which the
 * Workplace Fairness Act puts on a statutory footing.
 *
 * The check is deliberately a plain pattern list rather than a model call: it
 * has to hold even when the model is persuaded otherwise, and a false positive
 * only costs the founder a rephrase.
 */

interface ProtectedPattern {
  characteristic: string;
  pattern: RegExp;
}

const PROTECTED: readonly ProtectedPattern[] = [
  {
    characteristic: "age",
    pattern:
      /\b(under|below|over|above|younger than|older than)\s+\d{2}\b(?!\s*\+?\s*(years?|yrs)\s+(of\s+)?(\w+\s+)?(experience|exp)\b)|\b\d{2}\s*(-|to)\s*\d{2}\s*(years old|yo)\b|\b(young|youthful|fresh blood|digital native|not too old|too old)\b|年轻|岁以下|岁以上|年龄|太老/i,
  },
  {
    characteristic: "sex or gender",
    pattern:
      /\b(male|female|man|woman|men|women|guy|girl|gender)\b(?![\s-]*(neutral|diverse|hours?|days?))|男性|女性|男生|女生|性别/i,
  },
  {
    characteristic: "race or ethnicity",
    pattern: /\b(race|racial|ethnic(ity)?|caucasian)\b|(?<!\b(in|speak|speaks|speaking|read|write|writes)\s)\b(chinese|malay|indian|tamil)\b(?![\s-]+(market|speaking|speaker|language|customers?|clients?))|种族|华人|马来人|印度人/i,
  },
  {
    characteristic: "religion",
    pattern: /\b(religio(n|us)|christian|muslim|buddhist|hindu|catholic)\b|宗教|信仰/i,
  },
  {
    characteristic: "marital or family status",
    pattern: /\b(married|unmarried|no kids|no children|childless|pregnan(t|cy)|family plans?)\b|已婚|未婚|单身|没孩子|怀孕/i,
  },
  {
    characteristic: "disability",
    pattern: /\b(disab(led|ility)|able-bodied|handicap(ped)?)\b|残疾/i,
  },
  {
    characteristic: "nationality",
    pattern:
      /\b(nationality|citizens?|citizenship|permanent residents?|PRs? only|singaporeans? only|locals? only|foreigners?)\b|\bsingaporeans?\b(?![\s-]+(market|customers?|clients?|users?|companies|startups?|business(es)?))|国籍|公民|永久居民|只要本地人|外国人/i,
  },
];

/** Returns the characteristic a criterion selects on, or null when it is fair. */
export function protectedCharacteristic(text: string): string | null {
  for (const { characteristic, pattern } of PROTECTED) {
    if (pattern.test(text)) return characteristic;
  }
  return null;
}
