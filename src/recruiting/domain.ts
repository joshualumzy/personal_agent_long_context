/**
 * Recruiting direction (S3). See `docs/s3-recruiting.md` for the decisions
 * these types encode.
 */

export type CriterionKind = "must" | "nice";

/** Where a criterion came from, so the founder can see why it exists. */
export type CriterionOrigin = "stated" | "inferred" | "relaxed";

export interface Criterion {
  id: string;
  text: string;
  kind: CriterionKind;
  origin: CriterionOrigin;
  active: boolean;
  createdAt: string;
}

export type VerdictValue = "yes" | "no" | "unclear";

/** Same shape as an Exa Websets criterion evaluation. */
export interface Verdict {
  criterionId: string;
  satisfied: VerdictValue;
  reasoning: string;
}

export type Tier = 100 | 75 | 50 | "out" | "pending";

export const STAGES = [
  "discovered",
  "scored",
  "drafted",
  "contacted",
  "replied",
  "scheduling",
  "closed",
] as const;

export type Stage = (typeof STAGES)[number];

export type ClosedReason = "passed" | "cold" | "declined" | "hired" | "withdrawn";

export interface WorkEntry {
  title: string;
  company: string;
  from?: string;
  to?: string;
}

export interface EducationEntry {
  degree: string;
  institution: string;
  from?: string;
  to?: string;
}

/** Public professional fields only. Nothing else about a candidate is kept. */
export interface CandidateProfile {
  id: string;
  name: string;
  headline: string;
  location: string;
  profileUrl: string;
  workHistory: WorkEntry[];
  educationHistory: EducationEntry[];
  summary: string;
}

export type EmailStatus = "verified" | "found";

export interface ContactDetails {
  email: string;
  status: EmailStatus;
  /** "founder" when the founder typed the address in. */
  provider: "hunter" | "prospeo" | "founder";
}

export interface Draft {
  kind: "intro" | "follow_up" | "scheduling";
  subject: string;
  body: string;
  createdAt: string;
  /** Present when the draft mentions something the founder said privately. */
  warnings: string[];
  /** Set while it is being sent; a draft that is sending cannot be sent again or edited. */
  sending?: boolean;
}

export interface Message {
  direction: "outbound" | "inbound";
  channel: "email" | "linkedin" | "pasted";
  /** On the simulated clock, which the fast-forward control moves. */
  at: string;
  /** On the real clock, which outside services such as Gmail use. */
  realAt?: string;
  text: string;
}

export interface Candidate {
  profile: CandidateProfile;
  poolRound: number;
  /** "referral" when the founder added this person by link rather than search. */
  origin?: "search" | "referral";
  discoveredAt: string;
  stage: Stage;
  closedReason?: ClosedReason;
  closedAt?: string;
  /** Founder pinned this person with a keep verdict. */
  kept: boolean;
  verdicts: Record<string, Verdict>;
  contact?: ContactDetails;
  draft?: Draft;
  messages: Message[];
  lastContactedAt?: string;
  followUps: number;
  gmailThreadId?: string;
}

export interface FeedbackEntry {
  candidateId: string;
  decision: "keep" | "pass";
  /** What the founder said, if anything. Private: never goes into outreach. */
  statedReason?: string;
  /** What the agent believes drove the decision. */
  inferredReason: string;
  at: string;
}

export type CriteriaOperation =
  | { op: "add"; text: string; kind: CriterionKind }
  | { op: "remove"; id: string }
  | { op: "set_kind"; id: string; kind: CriterionKind }
  | { op: "edit"; id: string; text: string };

export interface CriterionProposal {
  id: string;
  type: "criterion";
  status: "pending" | "accepted" | "declined";
  createdAt: string;
  text: string;
  kind: CriterionKind;
  rationale: string;
  supportingCandidateIds: string[];
}

export interface ExpansionProposal {
  id: string;
  type: "expansion";
  status: "pending" | "accepted" | "declined";
  createdAt: string;
  step: number;
  stepName: string;
  rationale: string;
  query: string;
  operations: CriteriaOperation[];
}

export type Proposal = CriterionProposal | ExpansionProposal;

export interface PoolRound {
  round: number;
  /** The first query, kept for rounds saved before there were several. */
  query: string;
  queries?: string[];
  at: string;
  found: number;
  added: number;
}

export interface Role {
  title: string;
  requirement: string;
  confirmed: boolean;
  createdAt: string;
}

export interface HiringEvent {
  at: string;
  kind: string;
  summary: string;
}

export interface RecruitingState {
  version: 1;
  role: Role | null;
  criteria: Criterion[];
  candidates: Record<string, Candidate>;
  feedback: FeedbackEntry[];
  proposals: Proposal[];
  rounds: PoolRound[];
  expansionStep: number;
  /** Simulated days added to the real clock by the fast-forward control. */
  clockOffsetDays: number;
  events: HiringEvent[];
  /** Who outreach for this role is from, when the founder said so in the chat. */
  sender?: { name?: string; company?: string };
}

/** A candidate's verdict on one criterion. Own keys only: an id like "toString" must not match Object.prototype. */
export function verdictFor(candidate: Candidate, criterionId: string): Verdict | undefined {
  return Object.hasOwn(candidate.verdicts, criterionId) ? candidate.verdicts[criterionId] : undefined;
}

export function emptyState(): RecruitingState {
  return {
    version: 1,
    role: null,
    criteria: [],
    candidates: {},
    feedback: [],
    proposals: [],
    rounds: [],
    expansionStep: 0,
    clockOffsetDays: 0,
    events: [],
  };
}

export class RecruitingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
