import { createHash } from "node:crypto";
import type { CompanyAnswer, CompanyQuestion, Evidence } from "../company-domain.js";

/**
 * Meeting actions (S2). While a meeting runs, the agent listens to the
 * transcript, recognises commitments and questions, and turns each into a
 * Proposed Action backed by Company Evidence. Read-only work happens at once;
 * anything that changes the world waits for the employee's Approval of that
 * exact, unchanged payload.
 */

// ------------------------------------------------------------------ transcript

export interface TranscriptSegment {
  /** Position in the meeting, starting at 0. Stable once assigned. */
  index: number;
  speaker: string;
  text: string;
  /** ISO time the segment was heard, when known. */
  at?: string;
}

export interface Decision {
  text: string;
  segmentIndex: number;
  speaker: string;
  at: string;
}

export type MeetingStatus = "live" | "ended";

export interface MeetingSummary {
  meetingId: string;
  title: string;
  status: MeetingStatus;
  startedAt: string;
  /** The OrgForge zoom_transcript this meeting replays, when it is a replay. */
  sourceId?: string;
  actionCount: number;
}

export interface MeetingState {
  meetingId: string;
  title: string;
  /** The employee the agent works for; owner of drafts and approvals. */
  employeeId: string;
  status: MeetingStatus;
  startedAt: string;
  endedAt?: string;
  sourceId?: string;
  segments: TranscriptSegment[];
  /** Decisions heard in this meeting, used to spot conflicts in later ones. */
  decisions: Decision[];
  actions: ProposedAction[];
  trace: TraceEvent[];
}

// --------------------------------------------------------------------- actions

export type ActionKind =
  | "answer_question"
  | "flag_conflict"
  | "email_draft"
  | "hiring_request"
  | "ticket_draft"
  | "calendar_draft"
  | "message_draft"
  | "doc_draft"
  | "sheet_draft"
  | "escalation"
  | "blocked";

/**
 * Risk tier, decided by deterministic policy (never by the model):
 * - auto: read-only, runs at once;
 * - approval: changes something, waits for the employee;
 * - escalate: beyond the employee's authority (money, contracts); only a named approver may act;
 * - blocked: refused, for example a transcript line that tries to instruct the agent.
 */
export type Tier = "auto" | "approval" | "escalate" | "blocked";

export type ActionStatus =
  | "proposed" // waiting for approval
  | "executing"
  | "executed"
  | "failed"
  | "rejected"
  | "escalated" // waiting on someone above the employee
  | "blocked"
  | "superseded"; // a later mention replaced it (same dedupeKey)

export interface AnswerPayload {
  question: string;
  answer: string;
  citedSourceIds: string[];
}

export interface ConflictPayload {
  statement: string;
  priorDecision: string;
  /** Where the prior decision lives: a Company Artifact or an earlier meeting. */
  priorSourceId?: string;
  priorMeetingId?: string;
  explanation: string;
}

export interface EmailPayload {
  to: string;
  subject: string;
  body: string;
}

export interface HiringPayload {
  /** Plain-language hiring need, handed to the recruiting agent (S3) as is. */
  requirement: string;
}

export interface TicketPayload {
  title: string;
  description: string;
  assignee?: string;
  due?: string;
  project?: string;
}

export interface CalendarPayload {
  title: string;
  attendees: string[];
  /** ISO start when the meeting named one; otherwise the employee picks. */
  proposedStart?: string;
  durationMinutes: number;
  notes?: string;
}

export interface MessagePayload {
  /** Who the chat message is for, as named in the meeting. */
  recipient: string;
  /** Phone number or email for the recipient, only when one literally appeared; otherwise empty. */
  address: string;
  text: string;
}

export interface DocPayload {
  title: string;
  /** Markdown the employee pastes into a new, blank document. */
  body: string;
}

export interface SheetPayload {
  title: string;
  /** First row is the header. Pasted into a new, blank spreadsheet as tab-separated text. */
  rows: string[][];
}

export interface EscalationPayload {
  subject: string;
  reason: string;
  /** Role that must approve, for example "Founder" or "Finance lead". */
  requiredApprover: string;
}

export interface BlockedPayload {
  reason: string;
}

export type ActionPayload =
  | AnswerPayload
  | ConflictPayload
  | EmailPayload
  | HiringPayload
  | TicketPayload
  | CalendarPayload
  | MessagePayload
  | DocPayload
  | SheetPayload
  | EscalationPayload
  | BlockedPayload;

export interface ActionTrigger {
  segmentIndex: number;
  speaker: string;
  /** Verbatim words from the transcript that caused the action. */
  quote: string;
}

export interface ActionResult {
  summary: string;
  /** True when the effect is only recorded here (no real Jira or calendar exists for OrgForge). */
  simulated: boolean;
  externalRef?: string;
  /** Prefilled link that opens the action in the employee's own signed-in tool; their click performs it. */
  handoffUrl?: string;
  /** Text the page copies to the clipboard before opening handoffUrl, for tools that cannot be prefilled by link. */
  handoffCopy?: string;
}

export interface ProposedAction {
  id: string;
  meetingId: string;
  kind: ActionKind;
  tier: Tier;
  status: ActionStatus;
  /** One-line label for the approval card. */
  title: string;
  trigger: ActionTrigger;
  payload: ActionPayload;
  /** hashPayload(payload). Approval must present this exact value. */
  payloadHash: string;
  /** Bumped on every edit; an edit sends the action back to "proposed". */
  version: number;
  /** Company Evidence retrieved for this action in this run. */
  evidence: Evidence[];
  /** What the agent still could not find after looking, for the employee to fill in. */
  missing?: string[];
  /** Same commitment mentioned again maps to the same key and updates, not duplicates. */
  dedupeKey: string;
  createdAt: string;
  decidedAt?: string;
  result?: ActionResult;
  error?: string;
}

// ----------------------------------------------------------------------- trace

export type TraceStep =
  | "segment_screened"
  | "extracted"
  | "evidence_retrieved"
  | "looked_up"
  | "drafted"
  | "tiered"
  | "deduplicated"
  | "blocked"
  | "approved"
  | "rejected"
  | "edited"
  | "executed"
  | "failed"
  | "conflict_checked";

export interface TraceEvent {
  at: string;
  step: TraceStep;
  actionId?: string;
  segmentIndex?: number;
  detail: string;
}

/** Pushed to browsers over SSE as the meeting unfolds. */
export type MeetingEvent =
  | { type: "segments"; meetingId: string; segments: TranscriptSegment[] }
  | { type: "action"; meetingId: string; action: ProposedAction }
  | { type: "trace"; meetingId: string; trace: TraceEvent }
  | { type: "meeting"; meetingId: string; status: MeetingStatus }
  | { type: "busy"; meetingId: string; busy: boolean };

// ------------------------------------------------------------------- contracts

/** What the extractor sees each time new segments arrive. */
export interface ExtractionInput {
  meeting: MeetingState;
  newSegments: TranscriptSegment[];
}

/** A commitment or question the model heard, before evidence and drafting. */
export interface CandidateAction {
  kind: Exclude<ActionKind, "blocked">;
  trigger: ActionTrigger;
  /** Short statement of what should happen, in the meeting's language. */
  summary: string;
  dedupeKey: string;
  /** Model-supplied hints for drafting: recipient, assignee, amount, date, question text… */
  details: Record<string, unknown>;
}

export interface ExtractionResult {
  candidates: CandidateAction[];
  decisions: Decision[];
}

export interface CommitmentExtractor {
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

/** S1: the company-context agent. SoCLaaSCompanyAgent satisfies it. */
export interface QuestionAnswerer {
  answer(input: CompanyQuestion): Promise<CompanyAnswer>;
}

/** S3: the recruiting agent. RecruitingService satisfies it. */
export interface HiringHandoff {
  start(requirement: string): Promise<{ message: string }>;
}

/** GmailClient satisfies it. */
export interface EmailSender {
  connected(): Promise<boolean>;
  send(message: { to: string; subject: string; body: string }): Promise<{ threadId: string }>;
}

/**
 * Read-only lookup of people in the employee's own mailbox, used when a
 * draft needs an address the meeting and company records did not give.
 * Returns only names and addresses from message headers, never bodies.
 */
export interface ContactDirectory {
  connected(): Promise<boolean>;
  lookup(name: string): Promise<Evidence[]>;
}

export interface ActionExecutor {
  /** Performs an approved action. Throws on failure; the caller records it. */
  execute(action: ProposedAction, meeting: MeetingState): Promise<ActionResult>;
}

export interface MeetingStore {
  load(meetingId: string): Promise<MeetingState | null>;
  save(state: MeetingState): Promise<void>;
  list(): Promise<MeetingSummary[]>;
  /** Decisions from meetings other than `exceptMeetingId`, newest first. */
  priorDecisions(exceptMeetingId: string, limit: number): Promise<Array<Decision & { meetingId: string; title: string }>>;
}

/** The surface HTTP routes use. */
export interface MeetingActions {
  start(input: { title: string; employeeId: string; sourceId?: string }): Promise<MeetingState>;
  /** Adds heard segments (index assigned by the service) and processes them in the background. */
  append(meetingId: string, segments: Array<{ speaker: string; text: string; at?: string }>): Promise<TranscriptSegment[]>;
  end(meetingId: string): Promise<MeetingState>;
  get(meetingId: string): Promise<MeetingState | null>;
  list(): Promise<MeetingSummary[]>;
  /** Executes only if `payloadHash` matches the current payload and the tier is "approval". */
  approve(meetingId: string, actionId: string, payloadHash: string): Promise<ProposedAction>;
  reject(meetingId: string, actionId: string, reason?: string): Promise<ProposedAction>;
  /** Replaces the payload, bumps version and hash, and returns the action to "proposed". */
  edit(meetingId: string, actionId: string, payload: ActionPayload): Promise<ProposedAction>;
  subscribe(meetingId: string, listener: (event: MeetingEvent) => void): () => void;
  /** Resolves when background processing for the meeting is idle. For tests and replays. */
  idle(meetingId: string): Promise<void>;
}

export class MeetingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------- helpers

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

/** Stable hash of a payload, independent of key order. */
export function hashPayload(payload: ActionPayload): string {
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex").slice(0, 16);
}
