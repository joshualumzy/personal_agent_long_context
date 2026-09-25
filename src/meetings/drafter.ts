import type { CompanyKnowledge, Evidence } from "../company-domain.js";
import type { JsonModel } from "../recruiting/llm.js";
import type {
  ActionPayload,
  AnswerPayload,
  CalendarPayload,
  AvailabilityChecker,
  CandidateAction,
  ConflictPayload,
  ContactDirectory,
  Decision,
  DocPayload,
  EmailPayload,
  EscalationPayload,
  HiringPayload,
  MeetingState,
  MessagePayload,
  QuestionAnswerer,
  SheetPayload,
  TicketPayload,
} from "./domain.js";
import { checkAvailability } from "./availability.js";

/**
 * Turns a candidate commitment into the payload an employee (or, for an
 * escalation, a named approver) will actually see. Every drafting prompt
 * below is told to cite only Company Evidence retrieved in this run as
 * [source:ID]; anything else the model cites is stripped before the payload
 * is stored, so a payload can never point at evidence nobody fetched.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function detailText(details: Record<string, unknown>, key: string): string {
  return text(details[key]);
}

const STOPWORDS = new Set(
  "about after again also because been before being between both could does doing down during each from further have having here into itself just more most other over same should some such than that their them then there these they this those through under until very what when where which while will with would your yours we'll i'll let's going want need make sure today tomorrow next week meeting".split(" "),
);

/**
 * Search terms for one action. Postgres keyword search ANDs every word, so a
 * whole sentence rarely matches anything; instead, record IDs said in the
 * meeting (ENG-210, ZD-101) are searched first as exact hits, then a few
 * distinctive words joined with OR fill the rest.
 */
export function evidenceQueries(focus: string, meetingText: string): string[] {
  const ids = [...new Set(`${focus} ${meetingText}`.match(/\b[A-Z]{2,}-\d+\b/g) ?? [])].slice(0, 6);
  const words = [
    ...new Set(
      focus
        .toLowerCase()
        .match(/[a-z][a-z-]{3,}/g)
        ?.filter((word) => !STOPWORDS.has(word)) ?? [],
    ),
  ].slice(0, 6);
  return [ids.join(" or "), words.join(" or ")].filter(Boolean);
}

async function gatherEvidence(
  knowledge: CompanyKnowledge,
  candidate: CandidateAction,
  meeting: MeetingState,
  limit = 5,
): Promise<Evidence[]> {
  const focus = [candidate.summary, candidate.trigger.quote, detailText(candidate.details, "query")].join(" ");
  const heard = meeting.segments
    .filter((segment) => segment.index <= candidate.trigger.segmentIndex)
    .map((segment) => segment.text)
    .join(" ");
  const found = new Map<string, Evidence>();
  for (const query of evidenceQueries(focus, heard)) {
    for (const item of await knowledge.search(query, limit)) {
      if (!found.has(item.sourceId)) found.set(item.sourceId, item);
    }
    if (found.size >= limit) break;
  }
  return [...found.values()].slice(0, limit);
}

function evidenceForModel(items: Evidence[]) {
  return items.map((item) => ({ sourceId: item.sourceId, title: item.title, excerpt: item.excerpt.slice(0, 600) }));
}

/** Removes a `[source:ID]` marker whose ID was not actually retrieved this
 * run, leaving the rest of the sentence in place. */
function stripUnknownCitations(body: string, retrieved: ReadonlySet<string>): string {
  return body
    .replace(/\[source:([^\]\s]+)\]/gi, (whole, id: string) => (retrieved.has(id) ? whole : ""))
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Every email address that actually appears in the transcript or the
 * retrieved evidence. A drafted "to" is only kept when it is one of these;
 * otherwise it is left for the employee to fill in, never guessed. */
function emailsIn(...texts: string[]): Set<string> {
  const found = new Set<string>();
  for (const value of texts) {
    for (const match of value.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) found.add(match[0].toLowerCase());
  }
  return found;
}

/** Phone numbers that actually appear, reduced to digits with any leading "+". */
function phonesIn(...texts: string[]): Set<string> {
  const found = new Set<string>();
  for (const value of texts) {
    for (const match of value.matchAll(/\+?\d[\d\s()\u2010-\u2015-]{6,}\d/g)) found.add(normalizePhone(match[0]));
  }
  return found;
}

function normalizePhone(value: string): string {
  return value.trim().replace(/(?!^\+)[^\d]/g, "");
}

/** The meeting as heard up to and including the line that triggered the candidate, for drafts that need its facts. */
function heardUpTo(meeting: MeetingState, candidate: CandidateAction): string[] {
  return meeting.segments
    .filter((segment) => segment.index <= candidate.trigger.segmentIndex)
    .slice(-40)
    .map((segment) => `${segment.speaker}: ${segment.text}`);
}

/** "Tuesday 2026-09-29", so "next Tuesday" can be resolved to a date. */
function meetingDate(meeting: MeetingState): string {
  const date = new Date(meeting.startedAt);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() + 8 * 3_600_000);
  const weekday = local.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return `${weekday} ${local.toISOString().slice(0, 10)} (Singapore)`;
}

const SGT_MS = 8 * 3_600_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** The next two weeks as "Wednesday 2026-09-30", so the model reads dates off a list instead of counting. */
function upcomingDays(meeting: MeetingState): string[] {
  const start = new Date(meeting.startedAt);
  if (Number.isNaN(start.getTime())) return [];
  return Array.from({ length: 14 }, (_, offset) => {
    const local = new Date(start.getTime() + SGT_MS + (offset + 1) * 86_400_000);
    return `${WEEKDAYS[local.getUTCDay()]![0]!.toUpperCase()}${WEEKDAYS[local.getUTCDay()]!.slice(1)} ${local.toISOString().slice(0, 10)}`;
  });
}

/**
 * The weekday a proposed start falls on must be the one the meeting named:
 * a model that turns "next Wednesday" into a Thursday is caught here, and the
 * time is left for the employee instead.
 */
export function startMatchesNamedDay(start: string, heard: string): boolean {
  const named = WEEKDAYS.filter((day) => new RegExp(`\\b${day}\\b`, "i").test(heard));
  if (named.length !== 1) return true;
  const local = new Date(new Date(start).getTime() + SGT_MS);
  return WEEKDAYS[local.getUTCDay()] === named[0];
}

/**
 * Replaces an attendee's name with their address when the evidence holds an
 * address whose local part carries that name (lena.gomez@… for "Lena Gomez").
 */
export function resolveAttendees(attendees: string[], evidence: Evidence[]): string[] {
  const addresses = [...new Set(evidence.flatMap((item) => [...item.excerpt.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((m) => m[0].toLowerCase())))];
  return attendees.map((attendee) => {
    if (/@/.test(attendee)) return attendee;
    const words = attendee.toLowerCase().split(/\s+/).filter((word) => word.length >= 3);
    if (words.length === 0) return attendee;
    const match = addresses.find((address) => words.every((word) => address.split("@")[0]!.includes(word)));
    return match ?? attendee;
  });
}

/** Only a real date-time is kept; "next Tuesday at 10am" is left for the employee to fill in. */
function isIsoTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !Number.isNaN(new Date(value).getTime());
}

export interface ActionDrafterDeps {
  model: JsonModel;
  knowledge: CompanyKnowledge;
  answerer?: QuestionAnswerer;
  /** The employee's own mailbox, read-only, for finding a person's address. */
  contacts?: ContactDirectory | null;
  /** Company records searched for a person's address (signatures, contact tables). */
  records?: ContactDirectory | null;
  /** The employee's calendar free/busy, read-only, checked for every invite. */
  availability?: AvailabilityChecker | null;
  /** For tests; defaults to the real time. */
  now?: () => Date;
}

export interface DraftResult {
  payload: ActionPayload;
  evidence: Evidence[];
  title: string;
  /** What the draft still lacks after looking, for the employee to fill in. */
  missing?: string[];
  /** One line per lookup made to fill a gap, for the trace. */
  lookups?: string[];
  /** What was checked on the employee's behalf, shown on the card. */
  notes?: string[];
}

/** Something a draft needed but did not have, and where to look for it. */
interface Gap {
  need: string;
  /** Query for company records, or empty. */
  search: string;
  /** Person whose email or phone is needed, or empty. */
  person: string;
}

interface RawDraft extends DraftResult {
  gaps?: Gap[];
}

const MISSING_RULE =
  'Also include "missing" in that object: a list of {"need": string, "search": string, "person": string}, one per piece of information the draft needed but did not have (a recipient\'s address, a date, a figure, a ticket number). need says what is missing in a few plain words; search is a short query for company records that could contain it, or ""; person is the name of whoever\'s email or phone number is needed, or "". Use an empty list when nothing is missing, and never fill a gap by guessing.';

const MAX_GAPS_LOOKED_UP = 3;

function gapsIn(record: Record<string, unknown>): Gap[] {
  if (!Array.isArray(record.missing)) return [];
  return record.missing
    .filter(isRecord)
    .map((entry) => ({ need: text(entry.need).trim(), search: text(entry.search).trim(), person: text(entry.person).trim() }))
    .filter((gap) => gap.need.length > 0);
}

function withExtra(evidence: Evidence[], extra: Evidence[]): Evidence[] {
  const seen = new Set(evidence.map((item) => item.sourceId));
  return [...evidence, ...extra.filter((item) => !seen.has(item.sourceId))];
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Gaps read straight off the payload, so an empty recipient or start time is
 * always reported and looked up even when the model forgot to list it.
 */
function structuralGaps(kind: CandidateAction["kind"], payload: ActionPayload, candidate: CandidateAction): Gap[] {
  const named = detailText(candidate.details, "recipient");
  switch (kind) {
    case "email_draft": {
      const email = payload as EmailPayload;
      return email.to ? [] : [{ need: `Email address for ${named || "the recipient"}`, search: "", person: named }];
    }
    case "message_draft": {
      const message = payload as MessagePayload;
      return message.address
        ? []
        : [{ need: `Phone number or work email for ${message.recipient || "the recipient"}`, search: "", person: message.recipient }];
    }
    case "calendar_draft": {
      const invite = payload as CalendarPayload;
      const gaps: Gap[] = invite.attendees
        .filter((attendee) => !EMAIL_SHAPE.test(attendee))
        .map((attendee) => ({ need: `Email address for ${attendee}`, search: "", person: attendee }));
      if (!invite.proposedStart) gaps.push({ need: "Day and time for the meeting", search: "", person: "" });
      return gaps;
    }
    default:
      return [];
  }
}

/** Two gaps are the same when they name the same need or person, both ask for a contact detail and one names no one, or both ask when. */
function sameNeed(a: Gap, b: Gap): boolean {
  const contact = (gap: Gap) => /\b(e-?mail|phone|number|whatsapp|contact)\b/i.test(gap.need);
  const when = (gap: Gap) => /\b(date|day|time|when)\b/i.test(gap.need) && !contact(gap);
  return (
    a.need.toLowerCase() === b.need.toLowerCase() ||
    (a.person !== "" && a.person.toLowerCase() === b.person.toLowerCase()) ||
    (contact(a) && contact(b) && (a.person === "" || b.person === "")) ||
    (when(a) && when(b))
  );
}

function mergeGaps(...lists: Gap[][]): Gap[] {
  const merged: Gap[] = [];
  for (const gap of lists.flat()) {
    const same = merged.find((entry) => sameNeed(entry, gap));
    if (!same) merged.push({ ...gap });
    else {
      if (!same.search) same.search = gap.search;
      if (!same.person) same.person = gap.person;
    }
  }
  return merged;
}

export class ActionDrafter {
  constructor(private readonly deps: ActionDrafterDeps) {}

  /**
   * Drafts once; when the draft lacks something (an address, a date, a
   * figure), looks for it in company records and, for a person's address,
   * the employee's own mailbox, then drafts once more with what was found.
   * Whatever is still missing is returned for the employee to fill in, never
   * guessed.
   */
  async draft(candidate: CandidateAction, meeting: MeetingState): Promise<DraftResult> {
    const result = await this.draftWithLookups(candidate, meeting);
    if (candidate.kind !== "calendar_draft") return result;
    const notes = await this.calendarNotes(result.payload as CalendarPayload);
    if (notes.length === 0) return result;
    return {
      ...result,
      notes,
      lookups: [...(result.lookups ?? []), `Checked calendar free/busy: ${notes.join(" ")}`.slice(0, 300)],
    };
  }

  /** Free/busy only: never what anyone's events are. Nothing when the calendar is not connected. */
  private async calendarNotes(invite: CalendarPayload): Promise<string[]> {
    const checker = this.deps.availability;
    if (!checker || !(await checker.connected().catch(() => false))) return [];
    try {
      return await checkAvailability(checker, invite, this.deps.now?.() ?? new Date());
    } catch {
      return ["Could not reach the calendar to check availability."];
    }
  }

  private async draftWithLookups(candidate: CandidateAction, meeting: MeetingState): Promise<DraftResult> {
    const first = await this.draftOnce(candidate, meeting, []);
    const gaps = mergeGaps(structuralGaps(candidate.kind, first.payload, candidate), first.gaps ?? []);
    if (gaps.length === 0) return { payload: first.payload, evidence: first.evidence, title: first.title };

    const { found, lookups } = await this.lookUp(gaps.slice(0, MAX_GAPS_LOOKED_UP), first.evidence);
    const final = found.length > 0 ? await this.draftOnce(candidate, meeting, found) : first;
    const remaining =
      final === first ? gaps : mergeGaps(structuralGaps(candidate.kind, final.payload, candidate), final.gaps ?? []);
    return {
      payload: final.payload,
      evidence: final.evidence,
      title: final.title,
      ...(remaining.length > 0 ? { missing: remaining.map((gap) => gap.need) } : {}),
      ...(lookups.length > 0 ? { lookups } : {}),
    };
  }

  private async lookUp(gaps: Gap[], known: Evidence[]): Promise<{ found: Evidence[]; lookups: string[] }> {
    const seen = new Set(known.map((item) => item.sourceId));
    const found: Evidence[] = [];
    const lookups: string[] = [];
    const keep = (items: Evidence[]) => {
      const fresh = items.filter((item) => !seen.has(item.sourceId));
      for (const item of fresh) {
        seen.add(item.sourceId);
        found.push(item);
      }
      return fresh.length;
    };
    const mailbox = this.deps.contacts && (await this.deps.contacts.connected().catch(() => false)) ? this.deps.contacts : null;

    for (const gap of gaps) {
      // Keyword search needs every word to match, so a person is also searched
      // by name alone: "Lena Gomez" finds her emails, "Lena Gomez email" does not.
      for (const query of new Set([gap.search, gap.person].filter(Boolean))) {
        const items = await this.deps.knowledge.search(query, 3).catch(() => [] as Evidence[]);
        lookups.push(`Searched company records for "${query}" (${gap.need}): ${keep(items)} new item(s).`);
      }
      if (gap.person && this.deps.records) {
        const items = await this.deps.records.lookup(gap.person).catch(() => [] as Evidence[]);
        lookups.push(`Looked for contact details of "${gap.person}" in company records: ${keep(items)} found.`);
      }
      if (gap.person && mailbox) {
        const items = await mailbox.lookup(gap.person).catch(() => [] as Evidence[]);
        lookups.push(`Looked up "${gap.person}" in the employee's Gmail (headers only): ${keep(items)} address(es).`);
      }
    }
    return { found, lookups };
  }

  private async draftOnce(candidate: CandidateAction, meeting: MeetingState, extra: Evidence[]): Promise<RawDraft> {
    switch (candidate.kind) {
      case "answer_question":
        return this.draftAnswer(candidate, meeting);
      case "email_draft":
        return this.draftEmail(candidate, meeting, extra);
      case "ticket_draft":
        return this.draftTicket(candidate, meeting, extra);
      case "calendar_draft":
        return this.draftCalendar(candidate, meeting, extra);
      case "message_draft":
        return this.draftMessage(candidate, meeting, extra);
      case "doc_draft":
        return this.draftDoc(candidate, meeting, extra);
      case "sheet_draft":
        return this.draftSheet(candidate, meeting, extra);
      case "escalation":
        return this.draftEscalation(candidate, meeting);
      case "hiring_request":
        return this.draftHiring(candidate);
      case "flag_conflict":
        throw new Error("flag_conflict actions come from checkConflicts, not ActionDrafter.draft.");
      default: {
        const exhaustive: never = candidate.kind;
        throw new Error(`Unknown candidate kind ${String(exhaustive)}.`);
      }
    }
  }

  private async draftAnswer(candidate: CandidateAction, meeting: MeetingState): Promise<DraftResult> {
    const question = detailText(candidate.details, "question") || candidate.summary;
    if (this.deps.answerer) {
      const answer = await this.answerWithRetry(meeting.employeeId, question);
      if (answer) return {
        payload: {
          question,
          answer: answer.answer,
          citedSourceIds: answer.sources.map((source) => source.sourceId),
        } satisfies AnswerPayload,
        evidence: answer.sources,
        title: `Answer: ${question}`.slice(0, 120),
      };
    }
    // No S1 answer: search on the agent's own behalf so the employee sees
    // what evidence exists, but never fabricate a synthesized answer.
    const evidence = await this.deps.knowledge.search(question, 5);
    return {
      payload: {
        question,
        answer: this.deps.answerer
          ? "Insufficient Evidence: the company-context agent could not answer in time. The closest records are listed below."
          : "Insufficient Evidence: no question-answering agent is configured for this meeting.",
        citedSourceIds: [],
      } satisfies AnswerPayload,
      evidence,
      title: `Answer: ${question}`.slice(0, 120),
    };
  }

  /** The S1 model occasionally returns an empty turn; one retry covers most of those. */
  private async answerWithRetry(employeeId: string, question: string) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.deps.answerer!.answer({ employeeId, question });
      } catch {
        // fall through to the next attempt, then to plain retrieval
      }
    }
    return null;
  }

  private async draftEmail(candidate: CandidateAction, meeting: MeetingState, extra: Evidence[]): Promise<RawDraft> {
    const evidence = withExtra(await gatherEvidence(this.deps.knowledge, candidate, meeting), extra);
    const retrievedIds = new Set(evidence.map((item) => item.sourceId));
    const reply = await this.deps.model.json<unknown>({
      task: "email draft",
      system: [
        "Write a short work email for the employee to review and send, for a commitment heard in a meeting.",
        "Use only facts from the commitment, the meeting excerpt, and the retrieved Company Evidence below; state the actual content promised (a figure, date, or decision from the meeting), not just that it is coming. Cite every factual claim that comes from evidence with [source:ID], using only the IDs given; never cite an ID that is not listed.",
        "Suggest a recipient only when an email address for them literally appears in the meeting excerpt or the evidence below. Otherwise leave the recipient as an empty string so the employee fills it in. Never invent or guess an address.",
        'Reply as {"to": string, "subject": string, "body": string}.',
        MISSING_RULE,
      ].join("\n"),
      input: {
        commitment: candidate.summary,
        details: candidate.details,
        triggerQuote: candidate.trigger.quote,
        speaker: candidate.trigger.speaker,
        meetingExcerpt: heardUpTo(meeting, candidate),
        evidence: evidenceForModel(evidence),
      },
    });
    const record = isRecord(reply) ? reply : {};
    const body = stripUnknownCitations(text(record.body) || candidate.summary, retrievedIds);
    const allowedEmails = emailsIn(...meeting.segments.map((segment) => segment.text), ...evidence.map((item) => item.excerpt));
    const proposedTo = text(record.to).toLowerCase();
    const to = allowedEmails.has(proposedTo) ? proposedTo : "";
    const subject = text(record.subject) || candidate.summary.slice(0, 78);
    return {
      payload: { to, subject, body } satisfies EmailPayload,
      evidence,
      gaps: gapsIn(record),
      title: `Email: ${subject}`.slice(0, 120),
    };
  }

  private async draftTicket(candidate: CandidateAction, meeting: MeetingState, extra: Evidence[]): Promise<RawDraft> {
    const evidence = withExtra(await gatherEvidence(this.deps.knowledge, candidate, meeting), extra);
    const retrievedIds = new Set(evidence.map((item) => item.sourceId));
    const reply = await this.deps.model.json<unknown>({
      task: "ticket draft",
      system: [
        "Write a work ticket for a commitment heard in a meeting.",
        "Use only facts from the commitment and the retrieved Company Evidence below. Cite every factual claim that comes from evidence with [source:ID], using only the IDs given; never cite an ID that is not listed.",
        'Reply as {"title": string, "description": string, "assignee": string, "due": string, "project": string}. Leave assignee, due, or project as an empty string when the meeting did not say.',
        MISSING_RULE,
      ].join("\n"),
      input: {
        commitment: candidate.summary,
        details: candidate.details,
        triggerQuote: candidate.trigger.quote,
        speaker: candidate.trigger.speaker,
        meetingExcerpt: heardUpTo(meeting, candidate),
        evidence: evidenceForModel(evidence),
      },
    });
    const record = isRecord(reply) ? reply : {};
    const title = text(record.title) || candidate.summary.slice(0, 78);
    const description = stripUnknownCitations(text(record.description) || candidate.summary, retrievedIds);
    const payload: TicketPayload = {
      title,
      description,
      ...(text(record.assignee) ? { assignee: text(record.assignee) } : {}),
      ...(text(record.due) ? { due: text(record.due) } : {}),
      ...(text(record.project) ? { project: text(record.project) } : {}),
    };
    return { payload, evidence, gaps: gapsIn(record), title: `Ticket: ${title}`.slice(0, 120) };
  }

  private async draftCalendar(candidate: CandidateAction, meeting: MeetingState, extra: Evidence[]): Promise<RawDraft> {
    const evidence = withExtra(await gatherEvidence(this.deps.knowledge, candidate, meeting), extra);
    const reply = await this.deps.model.json<unknown>({
      task: "calendar draft",
      system: [
        "Write a calendar invite for a meeting commitment heard in a meeting.",
        "attendees are the names or emails actually mentioned. durationMinutes defaults to 30 when the meeting did not say.",
        "proposedStart is an ISO 8601 time with its offset (for example 2026-10-06T10:00:00+08:00), worked out from meetingDate and the meeting's own words such as \"next Tuesday at 10am\"; take the date from upcomingDays, where each date is listed with its weekday, rather than counting days. Times are Singapore time (+08:00) unless the meeting says otherwise. Leave it empty when the meeting named no day.",
        "When the evidence gives an attendee's email address, list the address instead of the name.",
        'Reply as {"title": string, "attendees": string[], "proposedStart": string, "durationMinutes": number, "notes": string}. Leave proposedStart or notes as an empty string when unknown.',
        MISSING_RULE,
      ].join("\n"),
      input: {
        commitment: candidate.summary,
        details: candidate.details,
        triggerQuote: candidate.trigger.quote,
        speaker: candidate.trigger.speaker,
        meetingDate: meetingDate(meeting),
        upcomingDays: upcomingDays(meeting),
        meetingExcerpt: heardUpTo(meeting, candidate),
        evidence: evidenceForModel(evidence),
      },
    });
    const record = isRecord(reply) ? reply : {};
    // The employee sends the invite, so they are the organiser, not a guest.
    const organiser = meeting.employeeId.toLowerCase();
    const attendees = Array.isArray(record.attendees)
      ? record.attendees.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0 && entry.trim().toLowerCase() !== organiser,
        )
      : [];
    const duration = Number(record.durationMinutes);
    const title = text(record.title) || candidate.summary.slice(0, 78);
    const proposedStart = text(record.proposedStart);
    const heard = `${candidate.trigger.quote} ${candidate.summary}`;
    const payload: CalendarPayload = {
      title,
      attendees: resolveAttendees(attendees, evidence),
      durationMinutes: Number.isFinite(duration) && duration > 0 ? duration : 30,
      ...(isIsoTime(proposedStart) && startMatchesNamedDay(proposedStart, heard) ? { proposedStart } : {}),
      ...(text(record.notes) ? { notes: text(record.notes) } : {}),
    };
    return { payload, evidence, gaps: gapsIn(record), title: `Calendar: ${title}`.slice(0, 120) };
  }

  private async draftMessage(candidate: CandidateAction, meeting: MeetingState, extra: Evidence[]): Promise<RawDraft> {
    const evidence = withExtra(await gatherEvidence(this.deps.knowledge, candidate, meeting), extra);
    const retrievedIds = new Set(evidence.map((item) => item.sourceId));
    const reply = await this.deps.model.json<unknown>({
      task: "chat message draft",
      system: [
        "Write a short chat message (WhatsApp or Teams style, two to four sentences, no greeting line or sign-off) for the employee to review and send, for a commitment heard in a meeting.",
        "State the actual content that was promised (the date, number, or decision itself, taken from the meeting excerpt), not just that an update is coming.",
        "Do not add requests, tasks, or advice the meeting did not mention.",
        "Use only facts from the commitment, the meeting excerpt, and the retrieved Company Evidence below. Cite evidence only when the message actually relies on it. Cite a fact from evidence with [source:ID], using only the IDs given; never cite an ID that is not listed.",
        "recipient is the person or group the message is for, as named in the meeting.",
        "address is a phone number or email for the recipient only when one literally appears in the meeting excerpt or the evidence below; otherwise an empty string. Never invent or guess one.",
        'Reply as {"recipient": string, "address": string, "text": string}.',
        MISSING_RULE,
      ].join("\n"),
      input: {
        commitment: candidate.summary,
        details: candidate.details,
        triggerQuote: candidate.trigger.quote,
        speaker: candidate.trigger.speaker,
        meetingExcerpt: heardUpTo(meeting, candidate),
        evidence: evidenceForModel(evidence),
      },
    });
    const record = isRecord(reply) ? reply : {};
    const sources = [...meeting.segments.map((segment) => segment.text), ...evidence.map((item) => item.excerpt)];
    const proposed = text(record.address).trim();
    const address = emailsIn(...sources).has(proposed.toLowerCase())
      ? proposed.toLowerCase()
      : proposed && phonesIn(...sources).has(normalizePhone(proposed))
        ? normalizePhone(proposed)
        : "";
    const recipient = text(record.recipient);
    const payload: MessagePayload = {
      recipient,
      address,
      text: stripUnknownCitations(text(record.text) || candidate.summary, retrievedIds),
    };
    return { payload, evidence, gaps: gapsIn(record), title: `Message${recipient ? ` to ${recipient}` : ""}: ${candidate.summary}`.slice(0, 120) };
  }

  private async draftDoc(candidate: CandidateAction, meeting: MeetingState, extra: Evidence[]): Promise<RawDraft> {
    const evidence = withExtra(await gatherEvidence(this.deps.knowledge, candidate, meeting), extra);
    const retrievedIds = new Set(evidence.map((item) => item.sourceId));
    const reply = await this.deps.model.json<unknown>({
      task: "document draft",
      system: [
        "Write a first draft of the new document someone promised in a meeting (notes, a spec, a proposal, a checklist), in Markdown, for the employee to review and paste into a blank document.",
        "Use only facts from the commitment, the meeting excerpt, and the retrieved Company Evidence below. Cite every factual claim that comes from evidence with [source:ID], using only the IDs given; never cite an ID that is not listed. Mark anything the meeting left open as TODO rather than filling it in.",
        "Keep it to what the meeting actually covered: headings and short bullets, at most about 400 words.",
        'Reply as {"title": string, "body": string}. body is Markdown and does not repeat the title.',
        MISSING_RULE,
      ].join("\n"),
      input: {
        commitment: candidate.summary,
        details: candidate.details,
        triggerQuote: candidate.trigger.quote,
        speaker: candidate.trigger.speaker,
        meetingExcerpt: heardUpTo(meeting, candidate),
        evidence: evidenceForModel(evidence),
      },
    });
    const record = isRecord(reply) ? reply : {};
    const title = text(record.title) || candidate.summary.slice(0, 78);
    const payload: DocPayload = {
      title,
      body: stripUnknownCitations(text(record.body) || candidate.summary, retrievedIds),
    };
    return { payload, evidence, gaps: gapsIn(record), title: `Document: ${title}`.slice(0, 120) };
  }

  private async draftSheet(candidate: CandidateAction, meeting: MeetingState, extra: Evidence[]): Promise<RawDraft> {
    const evidence = withExtra(await gatherEvidence(this.deps.knowledge, candidate, meeting), extra);
    const reply = await this.deps.model.json<unknown>({
      task: "spreadsheet draft",
      system: [
        "Build the first version of the table someone promised in a meeting, for the employee to review and paste into a blank spreadsheet.",
        "rows[0] is the header. Fill cells only with values from the meeting excerpt or the Company Evidence below; leave a cell empty when it is unknown rather than guessing. At most 12 columns and 50 rows.",
        'Reply as {"title": string, "rows": string[][]}.',
        MISSING_RULE,
      ].join("\n"),
      input: {
        commitment: candidate.summary,
        details: candidate.details,
        triggerQuote: candidate.trigger.quote,
        speaker: candidate.trigger.speaker,
        meetingExcerpt: heardUpTo(meeting, candidate),
        evidence: evidenceForModel(evidence),
      },
    });
    const record = isRecord(reply) ? reply : {};
    const rows = (Array.isArray(record.rows) ? record.rows : [])
      .filter((row): row is unknown[] => Array.isArray(row))
      .slice(0, 50)
      .map((row) => row.slice(0, 12).map((cell) => (cell === null || cell === undefined ? "" : String(cell))));
    const title = text(record.title) || candidate.summary.slice(0, 78);
    const payload: SheetPayload = { title, rows: rows.length > 0 ? rows : [[candidate.summary]] };
    return { payload, evidence, gaps: gapsIn(record), title: `Spreadsheet: ${title}`.slice(0, 120) };
  }

  private async draftEscalation(candidate: CandidateAction, meeting: MeetingState): Promise<DraftResult> {
    const evidence = await gatherEvidence(this.deps.knowledge, candidate, meeting);
    const retrievedIds = new Set(evidence.map((item) => item.sourceId));
    const reply = await this.deps.model.json<unknown>({
      task: "escalation draft",
      system: [
        "Write an escalation for a commitment heard in a meeting that involves money, a contract, or something beyond an employee's authority.",
        "Use only facts from the commitment and the retrieved Company Evidence below. Cite every factual claim that comes from evidence with [source:ID], using only the IDs given; never cite an ID that is not listed.",
        'requiredApprover is the role who must approve, for example "Founder" or "Finance lead".',
        'Reply as {"subject": string, "reason": string, "requiredApprover": string}.',
      ].join("\n"),
      input: {
        commitment: candidate.summary,
        details: candidate.details,
        triggerQuote: candidate.trigger.quote,
        speaker: candidate.trigger.speaker,
        evidence: evidenceForModel(evidence),
      },
    });
    const record = isRecord(reply) ? reply : {};
    const subject = text(record.subject) || candidate.summary.slice(0, 78);
    const payload: EscalationPayload = {
      subject,
      reason: stripUnknownCitations(text(record.reason) || candidate.summary, retrievedIds),
      requiredApprover: text(record.requiredApprover) || "Founder",
    };
    return { payload, evidence, title: `Escalation: ${subject}`.slice(0, 120) };
  }

  private async draftHiring(candidate: CandidateAction): Promise<DraftResult> {
    const reply = await this.deps.model.json<unknown>({
      task: "hiring request draft",
      system: [
        "Write a plain-language hiring requirement from a meeting discussion, for the recruiting agent to act on unchanged: the role, the key skills, and why the company needs it now.",
        'Reply as {"requirement": string}, at most 4 sentences.',
      ].join("\n"),
      input: {
        commitment: candidate.summary,
        details: candidate.details,
        triggerQuote: candidate.trigger.quote,
        speaker: candidate.trigger.speaker,
      },
    });
    const record = isRecord(reply) ? reply : {};
    const requirement = text(record.requirement) || candidate.summary;
    return {
      payload: { requirement } satisfies HiringPayload,
      evidence: [],
      title: `Hiring: ${requirement}`.slice(0, 120),
    };
  }
}

/**
 * Deterministically-triggered, model-assisted conflict check: called by the
 * service whenever a new Decision is heard, against prior decisions from
 * other meetings plus earlier decisions in this one, and against related
 * Company Evidence. A conflict is only ever reported when the model names a
 * specific entry from one of those two lists; an index outside either list,
 * or a conflict claim with no explanation, is treated as no conflict.
 */
export async function checkConflicts(
  model: JsonModel,
  decision: Decision,
  priorDecisions: ReadonlyArray<Decision & { meetingId: string; title: string }>,
  knowledge: CompanyKnowledge,
): Promise<ConflictPayload | null> {
  const relatedEvidence = await knowledge.search(decision.text, 5).catch(() => [] as Evidence[]);
  if (priorDecisions.length === 0 && relatedEvidence.length === 0) return null;

  const reply = await model.json<unknown>({
    task: "decision conflict check",
    system: [
      "A group just made a decision in a meeting. Check whether it contradicts one specific entry in priorDecisions or one specific entry in evidence below.",
      "Only report a conflict when you can point at one specific entry from those lists that the new decision actually contradicts. Never invent a prior decision or evidence item that is not in the lists, and say no conflict when nothing there actually disagrees with the new decision.",
      'Reply as {"conflict": boolean, "priorSource": "decision"|"evidence", "priorIndex": number, "explanation": string}. priorIndex is the 0-based index into whichever list priorSource names.',
    ].join("\n"),
    input: {
      newDecision: { text: decision.text, speaker: decision.speaker },
      priorDecisions: priorDecisions.map((entry, index) => ({
        index,
        text: entry.text,
        meetingId: entry.meetingId,
        meetingTitle: entry.title,
      })),
      evidence: evidenceForModel(relatedEvidence).map((item, index) => ({ index, ...item })),
    },
  });

  if (!isRecord(reply) || reply.conflict !== true) return null;
  const explanation = text(reply.explanation);
  if (!explanation) return null;
  const index = Number(reply.priorIndex);

  if (reply.priorSource === "decision") {
    const prior = priorDecisions[index];
    if (!prior) return null;
    return {
      statement: decision.text,
      priorDecision: prior.text,
      priorMeetingId: prior.meetingId,
      explanation,
    } satisfies ConflictPayload;
  }
  if (reply.priorSource === "evidence") {
    const prior = relatedEvidence[index];
    if (!prior) return null;
    return {
      statement: decision.text,
      priorDecision: prior.excerpt,
      priorSourceId: prior.sourceId,
      explanation,
    } satisfies ConflictPayload;
  }
  return null;
}
