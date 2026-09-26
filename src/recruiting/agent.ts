import type {
  CandidateProfile,
  CriteriaOperation,
  Criterion,
  CriterionKind,
  Draft,
  Message,
  Verdict,
  VerdictValue,
} from "./domain.js";
import type { JsonModel } from "./llm.js";
import { RecruitingError } from "./domain.js";

/**
 * Every model task the recruiting agent performs. Each one validates the reply
 * instead of trusting its shape, because a malformed verdict silently moving a
 * candidate between tiers would be worse than a visible failure.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

/** must or nice, from the ways a model writes them; null when it is neither. */
function kindOrNull(value: unknown): CriterionKind | null {
  const said = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_]+/g, "-") : "";
  if (["must", "must-have", "required", "requirement", "hard"].includes(said)) return "must";
  if (["nice", "nice-to-have", "optional", "bonus", "plus", "preferred", "soft"].includes(said)) return "nice";
  return null;
}

/** For new criteria a missing kind defaults to must, the core-skill reading. */
function kind(value: unknown): CriterionKind {
  return kindOrNull(value) ?? "must";
}

function verdictValue(value: unknown): VerdictValue {
  return value === "yes" || value === "no" ? value : "unclear";
}

function profileForModel(profile: CandidateProfile) {
  return {
    id: profile.id,
    name: profile.name,
    headline: profile.headline,
    location: profile.location,
    work: profile.workHistory.map(
      (entry) =>
        `${entry.title} at ${entry.company}${entry.from ? ` (${entry.from} to ${entry.to ?? "present"})` : ""}`,
    ),
    education: profile.educationHistory.map(
      (entry) => `${entry.degree}, ${entry.institution}`,
    ),
    summary: profile.summary.slice(0, 4000),
  };
}

function criteriaForModel(criteria: readonly Criterion[]) {
  return criteria
    .filter((criterion) => criterion.active)
    .map(({ id, text: criterionText, kind: criterionKind }) => ({
      id,
      text: criterionText,
      kind: criterionKind,
    }));
}

/**
 * How to phrase people-search queries. Measured on Exa: an abstract label such
 * as "career switcher from a non-CS background" found 5 matching people in 40;
 * the same need phrased with a concrete degree field found 10, and four such
 * queries together found 22.
 */
const QUERY_RULES = [
  "Each query is one plain English sentence of at most 20 words describing a person the way their profile reads: job title, company, and location, plus at most one concrete detail.",
  "A concrete detail is a word that literally appears on profiles: a degree field (\"bachelor's degree in economics\"), a technology, a past employer, a program (\"coding bootcamp\", \"Master of Computing\").",
  "Never use abstract labels such as \"career switcher\", \"non-CS background\", \"strong\", \"passionate\", or \"ideal candidate\". Never say the same thing twice in one query.",
  "Keep the location in every query when there is one.",
].join("\n");

function queriesFrom(reply: unknown, previous: readonly string[] = []): string[] {
  if (!isRecord(reply)) return [];
  const listed = Array.isArray(reply.queries) ? reply.queries : [reply.query];
  const seen = new Set(previous.map((query) => query.toLowerCase()));
  return listed
    .map((query) => text(query))
    .filter((query) => query && !seen.has(query.toLowerCase()) && seen.add(query.toLowerCase()))
    .slice(0, 4);
}

export interface Brief {
  title: string;
  criteria: { text: string; kind: CriterionKind }[];
  queries: string[];
}

export async function extractBrief(model: JsonModel, requirement: string): Promise<Brief> {
  const reply = await model.json<unknown>({
    task: "criteria extraction",
    system: [
      "You help a small-company founder hire for one role.",
      "Split the founder's hiring requirement into 3 to 6 criteria that can be checked against a public professional profile (work history, education, headline, location).",
      "Mark each criterion must (a dealbreaker) or nice (a plus). When the founder does not say, prefer must for the core skill and nice for the rest.",
      "Write each criterion as a short checkable phrase in the founder's language, for example \"3+ years building production backends\".",
      "Also write 3 or 4 people-search queries. They share the core (title, company, location) and each adds a different concrete detail aimed at the must criterion hardest to find. When no criterion needs that, vary the skill or seniority instead.",
      QUERY_RULES,
      "The title is a short job title of 2 to 5 words in the founder's language (for example \"Backend Engineer\" or \"产品经理\"), never the whole requirement.",
      'Reply as {"title": string, "criteria": [{"text": string, "kind": "must"|"nice"}], "queries": [string]}.',
      'If the text does not describe anyone to hire (code, a test string, a greeting, a question), reply {"notARole": true} instead of inventing a role.',
    ].join("\n"),
    input: { requirement },
  });
  if (isRecord(reply) && reply.notARole === true) {
    throw new RecruitingError("not_a_role", "That does not describe a role to hire for. Nothing was opened; ask the founder what they want to hire for.");
  }
  if (!isRecord(reply) || !Array.isArray(reply.criteria)) {
    throw new Error("The model did not return criteria.");
  }
  const criteria = reply.criteria
    .filter(isRecord)
    .map((entry) => ({ text: text(entry.text), kind: kind(entry.kind) }))
    .filter((entry) => entry.text.length > 0)
    .slice(0, 6);
  if (criteria.length === 0) throw new Error("The model returned no usable criteria.");
  return {
    title: text(reply.title, "Open role"),
    criteria,
    queries: queriesFrom(reply),
  };
}

/** Queries for the role as its criteria stand, different from ones already run. */
export async function writeQueries(
  model: JsonModel,
  role: string,
  criteria: readonly Criterion[],
  previous: readonly string[] = [],
  count = 3,
): Promise<string[]> {
  const reply = await model.json<unknown>({
    task: "search query",
    system: [
      `Write ${count} people-search queries that find candidates for the role from its criteria. Weight must criteria over nice ones.`,
      "They share the core (title, company, location) and each adds a different concrete detail aimed at the must criterion hardest to find.",
      "Do not repeat any of the previous queries or their concrete details; take new angles.",
      QUERY_RULES,
      'Reply as {"queries": [string]}.',
    ].join("\n"),
    input: { role, criteria: criteriaForModel(criteria), previous },
  });
  const queries = queriesFrom(reply, previous);
  if (queries.length === 0) throw new Error("The model returned no new search query.");
  return queries.slice(0, count);
}

/** A role title that matches the criteria as they stand now. */
export async function retitle(
  model: JsonModel,
  currentTitle: string,
  criteria: readonly Criterion[],
): Promise<string> {
  const reply = await model.json<unknown>({
    task: "role title",
    fast: true,
    system: [
      "Name the role these hiring criteria describe, in at most 8 words, in the language of the criteria.",
      "Keep the current title if it still fits; change it only when the criteria no longer match it.",
      'Reply as {"title": string}.',
    ].join("\n"),
    input: { currentTitle, criteria: criteriaForModel(criteria) },
  });
  return (isRecord(reply) && text(reply.title)) || currentTitle;
}

export async function judge(
  model: JsonModel,
  profile: CandidateProfile,
  criteria: readonly Criterion[],
): Promise<Verdict[]> {
  if (criteria.length === 0) return [];
  const reply = await model.json<unknown>({
    task: "criterion judgement",
    fast: true,
    system: [
      "Judge one candidate's public professional profile against each hiring criterion.",
      "For each criterion answer yes (the profile shows it), no (the profile shows it is not met), or unclear (the profile does not say).",
      "Do not guess beyond the profile. Absence of evidence is unclear, not no, unless the history clearly rules it out.",
      "For numeric thresholds, work the numbers out before answering. \"X years or more\", \"at least X years\" and \"X年以上\" all include exactly X; 7 years 10 months meets a 7-year threshold.",
      "Give a reason of at most 20 words that cites the profile.",
      'Reply as {"verdicts": [{"criterionId": string, "satisfied": "yes"|"no"|"unclear", "reasoning": string}]} with one entry per criterion.',
    ].join("\n"),
    input: {
      profile: profileForModel(profile),
      criteria: criteria.map(({ id, text: criterionText }) => ({ id, text: criterionText })),
    },
  });
  const entries = isRecord(reply) && Array.isArray(reply.verdicts) ? reply.verdicts : [];
  const byId = new Map<string, Verdict>();
  for (const entry of entries.filter(isRecord)) {
    // Ids can be all digits, and a model may send them back as numbers.
    const criterionId = typeof entry.criterionId === "number" ? String(entry.criterionId) : text(entry.criterionId);
    if (!criteria.some((criterion) => criterion.id === criterionId)) continue;
    byId.set(criterionId, {
      criterionId,
      satisfied: verdictValue(entry.satisfied),
      reasoning: text(entry.reasoning),
    });
  }
  // A criterion the model skipped is unclear, never silently yes.
  return criteria.map(
    (criterion) =>
      byId.get(criterion.id) ?? {
        criterionId: criterion.id,
        satisfied: "unclear",
        reasoning: "Not assessed.",
      },
  );
}

export type Instruction =
  | { intent: "criteria"; operations: CriteriaOperation[]; summary: string }
  | {
      intent: "feedback";
      candidateId: string;
      decision: "keep" | "pass";
      reason: string;
    }
  | { intent: "reply"; candidateId: string | null; text: string }
  | { intent: "question"; question: string }
  | { intent: "unknown"; summary: string };

export async function interpret(
  model: JsonModel,
  said: string,
  criteria: readonly Criterion[],
  candidates: readonly { id: string; name: string }[],
): Promise<Instruction> {
  const reply = await model.json<unknown>({
    task: "instruction interpretation",
    system: [
      "A founder is talking to their recruiting agent. Classify what they said and extract the details.",
      "intent criteria: they change what they are looking for, including retracting something said before (for example \"remote is fine after all\"). Express it as operations on the current criteria: add {op, text, kind}, remove {op, id}, set_kind {op, id, kind}, edit {op, id, text}.",
      "intent feedback: they give a verdict on one named candidate. decision is keep or pass; reason is their reason in their words, or empty.",
      "intent reply: they relay what a candidate answered (for example \"Alex replied, free Tuesday afternoon\"). candidateId is the matching candidate or null; text is the reply content.",
      "intent question: they ask something about the search or its history.",
      "Otherwise intent unknown.",
      'Reply as {"intent": string, "summary": string, "operations": [...], "candidateId": string|null, "decision": string, "reason": string, "text": string, "question": string}; include only the fields the intent needs plus summary.',
    ].join("\n"),
    input: {
      said,
      criteria: criteriaForModel(criteria),
      candidates,
    },
  });
  if (!isRecord(reply)) return { intent: "unknown", summary: "" };
  const summary = text(reply.summary);
  const knownCandidate = (value: unknown) => {
    const id = text(value);
    return candidates.some((candidate) => candidate.id === id) ? id : null;
  };

  switch (reply.intent) {
    case "criteria":
      return {
        intent: "criteria",
        operations: parseOperations(reply.operations, criteria),
        summary,
      };
    case "feedback": {
      const candidateId = knownCandidate(reply.candidateId);
      // Passing closes a candidate, so it is never the default for an unclear decision.
      if (!candidateId || (reply.decision !== "keep" && reply.decision !== "pass")) {
        return { intent: "unknown", summary };
      }
      return {
        intent: "feedback",
        candidateId,
        decision: reply.decision,
        reason: text(reply.reason),
      };
    }
    case "reply":
      return {
        intent: "reply",
        candidateId: knownCandidate(reply.candidateId),
        text: text(reply.text, said),
      };
    case "question":
      return { intent: "question", question: text(reply.question, said) };
    default:
      return { intent: "unknown", summary };
  }
}

export function parseOperations(
  value: unknown,
  criteria: readonly Criterion[],
): CriteriaOperation[] {
  if (!Array.isArray(value)) return [];
  const known = new Set(criteria.filter((c) => c.active).map((c) => c.id));
  const operations: CriteriaOperation[] = [];
  for (const entry of value.filter(isRecord)) {
    const id = text(entry.id);
    if (entry.op === "add" && text(entry.text)) {
      operations.push({ op: "add", text: text(entry.text), kind: kind(entry.kind) });
    } else if (entry.op === "remove" && known.has(id)) {
      operations.push({ op: "remove", id });
    } else if (entry.op === "set_kind" && known.has(id)) {
      // Changing a kind needs a kind we understood; a guess could flip nice to must.
      const understood = kindOrNull(entry.kind);
      if (understood) operations.push({ op: "set_kind", id, kind: understood });
    } else if (entry.op === "edit" && known.has(id) && text(entry.text)) {
      operations.push({ op: "edit", id, text: text(entry.text) });
    }
  }
  return operations;
}

export async function inferReason(
  model: JsonModel,
  profile: CandidateProfile,
  decision: "keep" | "pass",
  criteria: readonly Criterion[],
  statedReason: string | undefined,
): Promise<string> {
  const reply = await model.json<unknown>({
    task: "reason inference",
    fast: true,
    system: [
      `The founder chose to ${decision} this candidate.`,
      "State in at most 10 words the profile trait that most plausibly drove the decision, phrased as a reusable trait (for example \"only consulting experience, no product work\").",
      "If the founder gave a reason, restate it as such a trait.",
      'Reply as {"reason": string}.',
    ].join("\n"),
    input: {
      profile: profileForModel(profile),
      criteria: criteriaForModel(criteria),
      statedReason: statedReason ?? null,
    },
  });
  return (isRecord(reply) && text(reply.reason)) || statedReason || "unspecified";
}

export interface PatternFinding {
  text: string;
  kind: CriterionKind;
  rationale: string;
  supportingCandidateIds: string[];
}

export async function findPattern(
  model: JsonModel,
  decision: "keep" | "pass",
  decisions: readonly { candidateId: string; reason: string; profile: CandidateProfile }[],
  criteria: readonly Criterion[],
  threshold: number,
): Promise<PatternFinding | null> {
  const reply = await model.json<unknown>({
    task: "preference pattern",
    system: [
      `The founder chose to ${decision} each of these candidates. Look for one trait shared by at least ${threshold} of them that the current criteria do not already cover.`,
      decision === "pass"
        ? "If found, propose a new criterion that would have screened them out, phrased positively as what the founder wants (for example \"has shipped a product, not only consulting\")."
        : "If found, propose a new nice-to-have criterion that captures what they share.",
      'Reply as {"found": boolean, "text": string, "kind": "must"|"nice", "rationale": string, "supportingCandidateIds": [string]}. rationale is one sentence for the founder.',
    ].join("\n"),
    input: {
      decisions: decisions.map(({ candidateId, reason, profile }) => ({
        candidateId,
        reason,
        profile: profileForModel(profile),
      })),
      criteria: criteriaForModel(criteria),
    },
  });
  if (!isRecord(reply) || reply.found !== true || !text(reply.text)) return null;
  const known = new Set(decisions.map((entry) => entry.candidateId));
  const supportingCandidateIds = Array.isArray(reply.supportingCandidateIds)
    ? [...new Set(reply.supportingCandidateIds.map((id) => text(id)).filter((id) => known.has(id)))]
    : [];
  if (supportingCandidateIds.length < threshold) return null;
  return {
    text: text(reply.text),
    kind: decision === "keep" ? "nice" : kind(reply.kind),
    rationale: text(reply.rationale),
    supportingCandidateIds,
  };
}

export const EXPANSION_LADDER = [
  {
    name: "Widen location",
    guidance:
      "Widen the location: accept remote or nearby regions. Drop the location from the query; if a location criterion is a must, make it nice or edit it to include remote.",
  },
  {
    name: "Drop background filters",
    guidance:
      "Drop filters on company type, industry, or pedigree (for example \"startup experience\" or \"top university\"). Remove or demote those criteria and leave them out of the query.",
  },
  {
    name: "Demote one must",
    guidance:
      "Pick the single must criterion that is least essential to doing the job and make it nice. Keep the core skill a must.",
  },
] as const;

export async function planExpansion(
  model: JsonModel,
  step: number,
  role: string,
  criteria: readonly Criterion[],
  previousQuery: string,
): Promise<{ query: string; operations: CriteriaOperation[]; rationale: string }> {
  const rung = EXPANSION_LADDER[step]!;
  const reply = await model.json<unknown>({
    task: "pool expansion",
    system: [
      "Hiring has stalled, so the candidate pool must grow. Apply exactly this step:",
      rung.guidance,
      "Express criteria changes as operations: remove {op, id}, set_kind {op, id, kind}, edit {op, id, text}. Write one new people-search query.",
      QUERY_RULES,
      'Reply as {"query": string, "operations": [...], "rationale": string}. rationale is one sentence for the founder proposing the change and why, as a suggestion that has not happened yet (for example "Accept remote candidates too, since nobody in Singapore has replied in a week?"), never in the past tense.',
    ].join("\n"),
    input: { role, criteria: criteriaForModel(criteria), previousQuery },
  });
  if (!isRecord(reply)) throw new Error("The model returned no expansion plan.");
  return {
    query: text(reply.query, previousQuery),
    operations: parseOperations(reply.operations, criteria).filter(
      (operation) => operation.op !== "add",
    ),
    rationale: text(reply.rationale, rung.name),
  };
}

export async function draftMessage(
  model: JsonModel,
  draftKind: Draft["kind"],
  context: {
    role: string;
    company?: string;
    companyPitch?: string;
    founderName?: string;
    channel: "email" | "linkedin";
    profile: CandidateProfile;
    matched: string[];
    messages: Message[];
  },
): Promise<{ subject: string; body: string }> {
  const limit = context.channel === "linkedin" ? 60 : 90;
  const purpose = {
    intro: `a first cold message about the ${context.role} role.`,
    follow_up: "a one or two line nudge on the earlier message that got no answer. Make it easy to say no.",
    scheduling: "a reply that thanks them briefly and offers two or three 30-minute slots next week, Singapore time, or asks when suits them if they already gave times.",
  }[draftKind];
  const reply = await model.json<unknown>({
    task: "outreach draft",
    system: [
      `Write ${purpose} It goes out as a ${context.channel === "linkedin" ? "LinkedIn direct message" : "short email"}, at most ${limit} words.`,
      "Write the way a busy founder actually texts a stranger they want to hire: plain, direct, a little informal, like one person talking to another.",
      "Greet them by first name. Then give the hook: ONE specific piece of work from their history (a project, a system, a problem they solved), never a degree, school, or job title on its own. Say in plain words why that work matters for what the company builds. Do not introduce yourself first.",
      "Then one short sentence on the role, then the question.",
      "Example of the voice, for a different company and person; copy the tone, not the content: \"Hi Priya, saw you built the offline sync for Grab's driver app. We're making a smart ring that has to cope with patchy Bluetooth, so that problem is basically our week. We're hiring our first backend engineer. Up for a 15 minute call?\\n\\nMichael\"",
      "Never read their CV back to them, never list several of their achievements, never restate the hiring criteria.",
      "Banned: \"I'm writing\", \"writing because\", \"stood out\",\"impressed\", \"caught my eye\", \"relevant\", \"combination\", \"background matches\", \"I'd love to\", \"reach out\", \"opportunity\", \"passionate\", \"exciting\", \"I hope this finds you well\", em dashes, emojis, exclamation marks.",
      "Say what the company does in at most one short clause, using only the pitch given. If there is no pitch, do not invent one.",
      "If the pitch names a backer or funding, mention it in a few words (for example \"backed by MiraclePlus\"): it answers the reader's first question, whether this is real.",
      "The link between their work and the product must be specific: name what in the product needs it (for example voice, sensors, on-device models), not \"that work is what we need\".",
      "End with one easy question they can answer in a line, such as whether they are open to a quick call. Sign with the founder's first name only.",
      "Use only facts from the input. Do not mention scoring, tiers, or other candidates.",
      context.channel === "linkedin"
        ? 'Reply as {"subject": "", "body": string}.'
        : 'Reply as {"subject": string, "body": string}. The subject is at most 6 plain words, not a headline.',
    ].join("\n"),
    input: {
      role: context.role,
      company: context.company ?? null,
      companyPitch: context.companyPitch ?? null,
      founderName: context.founderName ?? null,
      candidate: profileForModel(context.profile),
      whyTheyFit: context.matched,
      conversation: context.messages.slice(-6),
    },
  });
  if (!isRecord(reply) || !text(reply.body)) throw new Error("The model returned no draft.");
  return { subject: text(reply.subject), body: text(reply.body) };
}

export interface ReplyReading {
  candidateId: string | null;
  interested: boolean | null;
  wantsToSchedule: boolean;
  summary: string;
}

export async function readReply(
  model: JsonModel,
  replyText: string,
  candidates: readonly { id: string; name: string }[],
  knownCandidateId: string | null,
): Promise<ReplyReading> {
  const reply = await model.json<unknown>({
    task: "reply reading",
    fast: true,
    system: [
      "Read a message a candidate sent back to the founder, or the founder's account of it.",
      "Identify which candidate it is (by id from the list, or null), whether they are interested (true, false, or null if unclear), whether they are ready to set a time, and a one-sentence summary.",
      'Reply as {"candidateId": string|null, "interested": boolean|null, "wantsToSchedule": boolean, "summary": string}.',
    ].join("\n"),
    input: { message: replyText, candidates, knownCandidateId },
  });
  if (!isRecord(reply)) throw new Error("The model could not read the reply.");
  const id = knownCandidateId ?? text(reply.candidateId);
  return {
    candidateId: candidates.some((candidate) => candidate.id === id) ? id : null,
    interested: typeof reply.interested === "boolean" ? reply.interested : null,
    wantsToSchedule: reply.wantsToSchedule === true,
    summary: text(reply.summary),
  };
}

/**
 * Finds private remarks the founder made that a draft repeats. The founder's
 * reasons stay between the founder and the agent; a draft that echoes one is
 * flagged rather than shown as ready to send.
 */
export function privateRemarksIn(body: string, remarks: readonly string[]): string[] {
  const lower = body.toLowerCase();
  return remarks.filter((remark) => {
    const words = remark
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 3);
    if (words.length === 0) return false;
    const hits = words.filter((word) => lower.includes(word)).length;
    return hits / words.length >= 0.6;
  });
}
