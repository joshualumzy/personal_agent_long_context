import { randomUUID } from "node:crypto";
import {
  MeetingError,
  type ActionExecutor,
  type ActionPayload,
  type ActionResult,
  type CalendarPayload,
  type DocPayload,
  type EmailPayload,
  type EmailSender,
  type HiringHandoff,
  type HiringPayload,
  type MeetingState,
  type MessagePayload,
  type SheetPayload,
  type ProposedAction,
  type TicketPayload,
} from "./domain.js";
import {
  docClipboardText,
  githubIssueLink,
  gmailComposeLink,
  googleCalendarLink,
  NEW_DOC_URL,
  NEW_SHEET_URL,
  outlookCalendarLink,
  outlookComposeLink,
  sheetClipboardText,
  teamsChatLink,
  whatsappLink,
} from "./handoff.js";

/** Which office suite the employee's calendar, mail, and documents live in. */
export type OfficeSuite = "google" | "microsoft";
/** Where quick chat messages go. Teams needs the recipient's email; without one it falls back to WhatsApp. */
export type ChatApp = "whatsapp" | "teams";

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
  /** "owner/name" of a GitHub repo; set, ticket_draft hands off to a prefilled new-issue page instead of simulating. */
  ticketRepo?: string;
  /** Defaults to "google". */
  suite?: OfficeSuite;
  /** Defaults to "whatsapp", what most Singapore SMEs chat on. */
  chat?: ChatApp;
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
        return this.deps.ticketRepo
          ? this.handOff(action, githubIssueLink(this.deps.ticketRepo, action.payload as TicketPayload), "GitHub")
          : this.recordSimulated(action, "SIM-TKT", "Recorded ticket");
      case "calendar_draft":
        return this.microsoft
          ? this.handOff(action, outlookCalendarLink(action.payload as CalendarPayload), "Outlook")
          : this.handOff(action, googleCalendarLink(action.payload as CalendarPayload), "Google Calendar");
      case "message_draft":
        return this.handOffMessage(action);
      case "doc_draft": {
        const payload = action.payload as DocPayload;
        const tool = this.microsoft ? "Word" : "Google Docs";
        return {
          ...this.handOff(action, NEW_DOC_URL[this.microsoft ? "microsoft" : "google"], tool),
          summary: `Ready to paste into a new ${tool} document: ${payload.title}`,
          handoffCopy: docClipboardText(payload),
        };
      }
      case "sheet_draft": {
        const payload = action.payload as SheetPayload;
        const tool = this.microsoft ? "Excel" : "Google Sheets";
        return {
          ...this.handOff(action, NEW_SHEET_URL[this.microsoft ? "microsoft" : "google"], tool),
          summary: `Ready to paste into a new ${tool} spreadsheet: ${payload.title}`,
          handoffCopy: sheetClipboardText(payload),
        };
      }
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
      return this.microsoft
        ? this.handOff(action, outlookComposeLink(payload), "Outlook")
        : this.handOff(action, gmailComposeLink(payload), "Gmail");
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

  private get microsoft(): boolean {
    return this.deps.suite === "microsoft";
  }

  private handOffMessage(action: ProposedAction): ActionResult {
    const payload = action.payload as MessagePayload;
    const teams = this.deps.chat === "teams" ? teamsChatLink(payload) : null;
    const who = payload.recipient ? `message to ${payload.recipient}` : "message";
    return teams
      ? { ...this.handOff(action, teams, "Teams"), summary: `Ready in Teams: ${who}` }
      : { ...this.handOff(action, whatsappLink(payload), "WhatsApp"), summary: `Ready in WhatsApp: ${who}` };
  }

  /** The effect happens when the employee opens the link and confirms in their own account. */
  private handOff(action: ProposedAction, handoffUrl: string, tool: string): ActionResult {
    const payload = action.payload as EmailPayload | TicketPayload | CalendarPayload | DocPayload | SheetPayload;
    const label = "title" in payload ? payload.title : "subject" in payload ? payload.subject : "";
    return { summary: `Ready in ${tool}: ${label}`, simulated: false, handoffUrl };
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
