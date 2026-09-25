import type { CompanyKnowledge, Evidence } from "../company-domain.js";
import type { JsonModel } from "../recruiting/llm.js";
import type {
  ActionPayload,
  AnswerPayload,
  CalendarPayload,
  CandidateAction,
  ConflictPayload,
  Decision,
  EmailPayload,
  EscalationPayload,
  HiringPayload,
  MeetingState,
  QuestionAnswerer,
  TicketPayload,
} from "./domain.js";

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

export interface ActionDrafterDeps {
  model: JsonModel;
  knowledge: CompanyKnowledge;
  answerer?: QuestionAnswerer;
}

export interface DraftResult {
  payload: ActionPayload;
  evidence: Evidence[];
  title: string;
}

export class ActionDrafter {
  constructor(private readonly deps: ActionDrafterDeps) {}

  async draft(candidate: CandidateAction, meeting: MeetingState): Promise<DraftResult> {
    switch (candidate.kind) {
      case "answer_question":
        return this.draftAnswer(candidate, meeting);
      case "email_draft":
        return this.draftEmail(candidate, meeting);
      case "ticket_draft":
        return this.draftTicket(candidate);
      case "calendar_draft":
        return this.draftCalendar(candidate);
      case "escalation":
        return this.draftEscalation(candidate);
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

  private async draftEmail(candidate: CandidateAction, meeting: MeetingState): Promise<DraftResult> {
    const query = detailText(candidate.details, "query") || candidate.summary;
    const evidence = await this.deps.knowledge.search(query, 5);
    const retrievedIds = new Set(evidence.map((item) => item.sourceId));
    const reply = await this.deps.model.json<unknown>({
      task: "email draft",
      system: [
        "Write a short work email for the employee to review and send, for a commitment heard in a meeting.",
        "Use only facts from the commitment and the retrieved Company Evidence below. Cite every factual claim that comes from evidence with [source:ID], using only the IDs given; never cite an ID that is not listed.",
        "Suggest a recipient only when an email address for them literally appears in the meeting excerpt or the evidence below. Otherwise leave the recipient as an empty string so the employee fills it in. Never invent or guess an address.",
        'Reply as {"to": string, "subject": string, "body": string}.',
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
    const body = stripUnknownCitations(text(record.body) || candidate.summary, retrievedIds);
    const allowedEmails = emailsIn(...meeting.segments.map((segment) => segment.text), ...evidence.map((item) => item.excerpt));
    const proposedTo = text(record.to).toLowerCase();
    const to = allowedEmails.has(proposedTo) ? proposedTo : "";
    const subject = text(record.subject) || candidate.summary.slice(0, 78);
    return {
      payload: { to, subject, body } satisfies EmailPayload,
      evidence,
      title: `Email: ${subject}`.slice(0, 120),
    };
  }

  private async draftTicket(candidate: CandidateAction): Promise<DraftResult> {
    const query = detailText(candidate.details, "query") || candidate.summary;
    const evidence = await this.deps.knowledge.search(query, 5);
    const retrievedIds = new Set(evidence.map((item) => item.sourceId));
    const reply = await this.deps.model.json<unknown>({
      task: "ticket draft",
      system: [
        "Write a work ticket for a commitment heard in a meeting.",
        "Use only facts from the commitment and the retrieved Company Evidence below. Cite every factual claim that comes from evidence with [source:ID], using only the IDs given; never cite an ID that is not listed.",
        'Reply as {"title": string, "description": string, "assignee": string, "due": string, "project": string}. Leave assignee, due, or project as an empty string when the meeting did not say.',
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
    const title = text(record.title) || candidate.summary.slice(0, 78);
    const description = stripUnknownCitations(text(record.description) || candidate.summary, retrievedIds);
    const payload: TicketPayload = {
      title,
      description,
      ...(text(record.assignee) ? { assignee: text(record.assignee) } : {}),
      ...(text(record.due) ? { due: text(record.due) } : {}),
      ...(text(record.project) ? { project: text(record.project) } : {}),
    };
    return { payload, evidence, title: `Ticket: ${title}`.slice(0, 120) };
  }

  private async draftCalendar(candidate: CandidateAction): Promise<DraftResult> {
    const query = detailText(candidate.details, "query") || candidate.summary;
    const evidence = await this.deps.knowledge.search(query, 5);
    const reply = await this.deps.model.json<unknown>({
      task: "calendar draft",
      system: [
        "Write a calendar invite for a meeting commitment heard in a meeting.",
        "attendees are the names or emails actually mentioned. durationMinutes defaults to 30 when the meeting did not say.",
        'Reply as {"title": string, "attendees": string[], "proposedStart": string, "durationMinutes": number, "notes": string}. Leave proposedStart or notes as an empty string when unknown.',
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
    const attendees = Array.isArray(record.attendees)
      ? record.attendees.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    const duration = Number(record.durationMinutes);
    const title = text(record.title) || candidate.summary.slice(0, 78);
    const payload: CalendarPayload = {
      title,
      attendees,
      durationMinutes: Number.isFinite(duration) && duration > 0 ? duration : 30,
      ...(text(record.proposedStart) ? { proposedStart: text(record.proposedStart) } : {}),
      ...(text(record.notes) ? { notes: text(record.notes) } : {}),
    };
    return { payload, evidence, title: `Calendar: ${title}`.slice(0, 120) };
  }

  private async draftEscalation(candidate: CandidateAction): Promise<DraftResult> {
    const query = detailText(candidate.details, "query") || candidate.summary;
    const evidence = await this.deps.knowledge.search(query, 5);
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
