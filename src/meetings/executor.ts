import { randomUUID } from "node:crypto";
import {
  MeetingError,
  type ActionExecutor,
  type ActionPayload,
  type ActionResult,
  type CalendarPayload,
  type EmailPayload,
  type EmailSender,
  type HiringHandoff,
  type HiringPayload,
  type MeetingState,
  type ProposedAction,
  type TicketPayload,
} from "./domain.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** One row appended to the executor's record of a simulated effect. */
export interface RecordedEffect {
  meetingId: string;
  actionId: string;
  kind: "ticket_draft" | "calendar_draft";
  summary: string;
  payload: ActionPayload;
  externalRef: string;
}

export interface DispatchingExecutorDeps {
  /** S2's own outbound mail. Absent or disconnected means email_draft cannot run. */
  email?: EmailSender | null;
  /** S3, the recruiting agent. Absent means hiring_request cannot run. */
  hiring?: HiringHandoff | null;
  /** Optional sink for simulated effects (ticket_draft, calendar_draft), for anyone who wants to list them later. */
  record?: (entry: RecordedEffect) => Promise<void>;
}

/**
 * Performs an approved ProposedAction. Called only after the employee has
 * approved (see MeetingActions.approve in domain.ts); still refuses
 * "escalation" and "blocked" outright as defence in depth, since those tiers
 * should never reach an executor in the first place.
 *
 * OrgForge (the synthetic company this hackathon targets) has no real Jira or
 * calendar to call, so ticket_draft and calendar_draft are simulated: they are
 * only ever recorded here, never sent anywhere, and their ActionResult says so
 * with `simulated: true`.
 */
export class DispatchingExecutor implements ActionExecutor {
  constructor(private readonly deps: DispatchingExecutorDeps) {}

  async execute(action: ProposedAction, _meeting: MeetingState): Promise<ActionResult> {
    switch (action.kind) {
      case "email_draft":
        return this.sendEmail(action);
      case "hiring_request":
        return this.startHiring(action);
      case "ticket_draft":
        return this.recordSimulated(action, "SIM-TKT", "Recorded ticket");
      case "calendar_draft":
        return this.recordSimulated(action, "SIM-CAL", "Recorded calendar hold");
      case "answer_question":
      case "flag_conflict":
        return { summary: "Read-only; nothing to execute.", simulated: false };
      case "escalation":
      case "blocked":
        throw new MeetingError(
          "not_executable",
          `"${action.kind}" actions are never executed; they wait on a human above the employee.`,
          409,
        );
      default: {
        const exhaustive: never = action.kind;
        throw new MeetingError("unknown_kind", `Unknown action kind: ${String(exhaustive)}`, 400);
      }
    }
  }

  private async sendEmail(action: ProposedAction): Promise<ActionResult> {
    const payload = action.payload as EmailPayload;
    if (!EMAIL_RE.test(payload.to)) {
      throw new MeetingError("invalid_email", `"${payload.to}" is not a plausible email address.`, 400);
    }
    if (!this.deps.email || !(await this.deps.email.connected())) {
      throw new MeetingError("email_not_connected", "Connect email first, or send this by hand.", 409);
    }
    const sent = await this.deps.email.send({ to: payload.to, subject: payload.subject, body: payload.body });
    return { summary: `Sent to ${payload.to}`, simulated: false, externalRef: sent.threadId };
  }

  private async startHiring(action: ProposedAction): Promise<ActionResult> {
    const payload = action.payload as HiringPayload;
    if (!this.deps.hiring) {
      throw new MeetingError("hiring_not_connected", "The recruiting agent is not available.", 503);
    }
    const result = await this.deps.hiring.start(payload.requirement);
    return { summary: result.message, simulated: false, externalRef: "/recruiting" };
  }

  private async recordSimulated(
    action: ProposedAction,
    refPrefix: "SIM-TKT" | "SIM-CAL",
    summaryPrefix: string,
  ): Promise<ActionResult> {
    const payload = action.payload as TicketPayload | CalendarPayload;
    const label = "title" in payload ? payload.title : "";
    const externalRef = `${refPrefix}-${randomUUID().slice(0, 8)}`;
    const summary = label ? `${summaryPrefix}: ${label}` : summaryPrefix;
    if (this.deps.record) {
      await this.deps.record({
        meetingId: action.meetingId,
        actionId: action.id,
        kind: action.kind as "ticket_draft" | "calendar_draft",
        summary,
        payload,
        externalRef,
      });
    }
    return { summary, simulated: true, externalRef };
  }
}
