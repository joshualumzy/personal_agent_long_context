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

const NATIONALITIES =
  "singaporeans?|malaysians?|chinese|indians?|indonesians?|filipinos?|vietnamese|thais?|japanese|koreans?|americans?|british|australians?|europeans?|locals?|foreigners?";

/**
 * Job-related uses of words that also name a protected characteristic. These
 * are removed before the check, so "business-level Chinese", "Indian
 * enterprises", "women's health products" or "a young startup" pass while
 * "Chinese only" or "young candidates" do not.
 */
const JOB_CONTEXT: readonly RegExp[] = [
  // Languages as skills.
  /\b(business[- ]level|fluent|fluency in|native[- ]level|conversational|written|spoken|proficient in|proficiency in|speaks?|speaking|reads?|writes?|in)\s+(mandarin\s+)?(chinese|malay|tamil|hindi|japanese|korean|thai|vietnamese|indonesian|english)\b/gi,
  /\b(chinese|malay|tamil|hindi|japanese|korean|thai|vietnamese|indonesian)[\s-]+(proficiency|fluency|language|speakers?|speaking|writing|literacy|translation|characters|localization|hsk\b[^,;]*)/gi,
  // Markets, customers, companies, and fields.
  new RegExp(
    String.raw`\b(${NATIONALITIES}|singapore)[\s-]+(markets?|customers?|clients?|users?|consumers?|enterprises?|companies|smes?|business(es)?|founded|startups?|regulations?|regulators?|government|agencies|media|law|laws|tax|accounts?|partners?|suppliers?)\b`,
    "gi",
  ),
  /\btraditional chinese medicine\b/gi,
  /(中国|新加坡|马来西亚|印度)?籍?(客户|用户|市场|企业|公司|法规)/g,
  // Business terms that contain these words.
  /\bcitizen[\s-]+(developers?|science|scientists?|journalism|data)\b/gi,
  /\bcivic\b/gi,
  /\b(work (passes?|permits?|visas?)|employment pass(es)?|visas?|immigration)\b[^,;.]*/gi,
  /\bpermanent[\s-]+residen(t|ce|cy)[\s-]+(applications?|process(ing)?|cases?|law)\b/gi,
  /\b(PR|public relations)\s+(experience|agency|agencies|campaigns?|firm|work|skills?|background)\b/g,
  // Products and users, not the candidate.
  /\bwomen'?s\s+(health|products?|apparel|fashion|wellness|sports|care|segment|market)\b/gi,
  /\b(pregnancy|maternity|fertility|baby)[\s-]+(tracking|apps?|products?|care|platforms?|features?)\b/gi,
  /\b(accessibility|a11y)\b[^,;.]*/gi,
  /\bfor\s+(disabled|blind|deaf)\s+(users?|people|customers?|patients?)\b/gi,
  // Numbers with a unit are not ages; "young" about a company is not about a person.
  /\b(under|below|over|above|more than|less than)\s+\d+(\.\d+)?\s*(ms|milliseconds?|s|seconds?|minutes?|%|k|m|mb|gb|tb|x|million|billion|engineers?|people|staff|reports?|clients?|customers?|users?|countries|markets|projects?|years? of|yrs? of|enterprise)\b/gi,
  /\byoung\s+(startups?|compan(y|ies)|teams?|products?|brands?|markets?|industry|field|organi[sz]ations?)\b/gi,
];

const PROTECTED: readonly ProtectedPattern[] = [
  {
    characteristic: "age",
    pattern: new RegExp(
      [
        String.raw`\b(under|below|over|above|younger than|older than|no older than|not older than)\s+\d{2}\b`,
        String.raw`\baged?\s*:?\s*\d{2}`,
        String.raw`\bmax(imum)?\.?\s+age\b|\bage\s+(limit|range|cap|requirement)\b`,
        String.raw`\b\d{2}\s*(years?|yrs?)\s*old\b|\b\d{2}\s*(-|to|–)\s*\d{2}\s*(yo|y\.o\.)\b`,
        String.raw`\bborn\s+(after|before|in|between)\s+(19|20)\d{2}`,
        String.raw`\b(young|youthful|fresh blood|digital natives?|not too old|too old)\b`,
        String.raw`年轻|岁以下|岁以上|年龄|太老|\d{2}\s*岁|[2-9]0多岁|(?<!\d)[0-9]0后`,
      ].join("|"),
      "i",
    ),
  },
  {
    characteristic: "sex or gender",
    pattern:
      /\b(male|female|man|woman|men|women|guys?|girls?|ladies|lady|gentlemen|gender)\b(?![\s-]*(neutral|diverse|hours?|days?))|男性|女性|男生|女生|男士|女士|限男|限女|性别/i,
  },
  {
    characteristic: "race or ethnicity",
    pattern: /\b(race|racial|ethnic(ity)?|caucasian|chinese|malay|indian|tamil)\b|种族|华人|马来人|印度人/i,
  },
  {
    characteristic: "religion",
    pattern: /\b(religio(n|us)|christian|muslim|buddhist|hindu|catholic)\b|宗教|信仰/i,
  },
  {
    characteristic: "marital or family status",
    pattern:
      /\b(married|unmarried|single parents?|no kids|no children|childless|pregnan(t|cy)|family plans?|must be a (mother|father|parent|mom|mum|dad)|(mothers|fathers|parents) only)\b|已婚|未婚|单身|没孩子|怀孕|已育|未育/i,
  },
  {
    characteristic: "disability",
    pattern: /\b(disab(led|ility)|able-bodied|handicap(ped)?)\b|残疾/i,
  },
  {
    characteristic: "nationality",
    pattern: new RegExp(
      [
        String.raw`\b(nationality|citizens?|citizenship|passport holders?|permanent residents?|foreigners?)\b`,
        String.raw`\b(sc\s*/\s*pr|pr\s+only|prs\s+only|singapore\s+prs?)\b`,
        String.raw`\b(${NATIONALITIES})\s+(only|preferred|candidates only|applicants only)\b`,
        String.raw`\blocal\s+(candidates?|applicants?|hires?|talent|people)\s+only\b`,
        String.raw`国籍|公民|永久居民|(新加坡|马来西亚|本地|本国|外国|中国|印度)人`,
      ].join("|"),
      "i",
    ),
  },
];

/** Returns the characteristic a criterion selects on, or null when it is fair. */
export function protectedCharacteristic(text: string): string | null {
  let rest = text;
  for (const context of JOB_CONTEXT) rest = rest.replace(context, " ");
  for (const { characteristic, pattern } of PROTECTED) {
    if (pattern.test(rest)) return characteristic;
  }
  return null;
}
