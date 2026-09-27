import {
  hashPayload,
  type ActionPayload,
  type ActionKind,
  type MeetingState,
  type MeetingStore,
  type ProposedAction,
  type Tier,
  type TranscriptSegment,
} from "./domain.js";

/**
 * A finished sample meeting that doubles as the page's manual. It is written
 * out here rather than produced by the agent, so every part of the page has
 * something in it, the same way every time: an answer, a conflict, drafts to
 * approve, something that needs a manager, something the guard refused. The
 * minutes explain what each part of the page is for.
 */

export const PRODUCT_TOUR_ID = "product-tour";

const LINES: Array<[speaker: string, text: string]> = [
  ["Guide", "Welcome! This is a sample meeting. Everything on this page came from these lines, the way it does when you record a real one."],
  ["Priya", "Quick question before we start: have we had a checkout outage like this before?"],
  ["Jax", "Let's keep the old checkout page as a fallback for launch week."],
  ["Jax", "I'll email the launch partners today with the new timeline."],
  ["Priya", "Can someone open a ticket to add an uptime alert on checkout? Jax, can you take it by Friday?"],
  ["Marcus", "I'm thinking we offer the partners a 10% launch discount."],
  ["Priya", "Let's check in again on Thursday at 3."],
  ["Jax", "Here's the admin password for the staging database, I'll paste it in the chat."],
  ["Marcus", "With launch coming, we need to hire a second backend engineer for on-call."],
  ["Guide", "That's the tour. Pick any card to see the line it came from, then try approving the email."],
];

const MANUAL = `# How this page works

## Summary

A sample meeting that shows what the assistant does. Every promise below came from a line on the right: pick one to see where, and open its draft in the tray at the bottom to approve it. A hiring need carries on in the assistant's chat. Heads up flags what contradicts an earlier decision, and Looked up for you answers questions from your company's own records.

## Decisions

- Keep the old checkout page as a fallback for launch week (Jax)
`;

interface CardSpec {
  id: string;
  kind: ActionKind;
  tier: Tier;
  status: ProposedAction["status"];
  title: string;
  line: number;
  quote: string;
  payload: ActionPayload;
}

function cards(start: Date): CardSpec[] {
  const thursday = new Date(start);
  thursday.setUTCDate(start.getUTCDate() + ((4 - start.getUTCDay() + 7) % 7 || 7));
  thursday.setUTCHours(7, 0, 0, 0); // 3 PM Singapore
  return [
    {
      id: "tour-answer",
      kind: "answer_question",
      tier: "auto",
      status: "executed",
      title: "Have we had a checkout outage like this before?",
      line: 1,
      quote: "have we had a checkout outage like this before?",
      payload: {
        question: "Have we had a checkout outage like this before?",
        answer:
          "In a real meeting this answer comes from your company's own records (tickets, incidents, chat), with the sources one click away.\n\n**Try it:** while recording, ask about a past incident, ticket, or customer. The answer lands here.",
        citedSourceIds: [],
      },
    },
    {
      id: "tour-conflict",
      kind: "flag_conflict",
      tier: "auto",
      status: "executed",
      title: "This goes against an earlier decision",
      line: 2,
      quote: "keep the old checkout page as a fallback",
      payload: {
        statement: "Keep the old checkout page as a fallback for launch week.",
        priorDecision: "Retire the old checkout page before launch (decided in an earlier meeting).",
        explanation: "When something said now contradicts a decision on record, it shows up under Heads up, with the earlier decision next to it.",
      },
    },
    {
      id: "tour-email",
      kind: "email_draft",
      tier: "approval",
      status: "proposed",
      title: "Email the launch partners the new timeline",
      line: 3,
      quote: "I'll email the launch partners today",
      payload: {
        to: "",
        subject: "New launch timeline",
        body: "Hi all,\n\nThis is a sample draft from the tour. In a real meeting the assistant writes it from what was promised, using your company's records.\n\nTry it: change any line, then press Save and approve. It opens in your own Gmail with everything filled in; nothing is sent until you press Send there.\n\nBest,\nJax",
      },
    },
    {
      id: "tour-ticket",
      kind: "ticket_draft",
      tier: "approval",
      status: "proposed",
      title: "Add an uptime alert on checkout",
      line: 4,
      quote: "open a ticket to add an uptime alert on checkout",
      payload: {
        title: "Add an uptime alert on checkout",
        description: "A sample ticket from the tour. The assignee and due date below are properties: click one to change it.",
        assignee: "Jax",
        due: "Friday",
      },
    },
    {
      id: "tour-discount",
      kind: "escalation",
      tier: "escalate",
      status: "escalated",
      title: "A 10% partner discount is Finance's call",
      line: 5,
      quote: "offer the partners a 10% launch discount",
      payload: {
        subject: "10% launch discount for partners",
        reason: "Pricing is outside your role, so the assistant drafts nothing and names who decides.",
        requiredApprover: "Finance lead",
      },
    },
    {
      id: "tour-checkin",
      kind: "calendar_draft",
      tier: "approval",
      status: "proposed",
      title: "Launch check-in on Thursday",
      line: 6,
      quote: "check in again on Thursday at 3",
      payload: {
        title: "Launch check-in",
        attendees: ["Priya", "Marcus", "Jax"],
        proposedStart: thursday.toISOString(),
        durationMinutes: 30,
      },
    },
    {
      id: "tour-hire",
      kind: "hiring_request",
      tier: "approval",
      status: "proposed",
      title: "Hiring: A second backend engineer for on-call",
      line: 8,
      quote: "we need to hire a second backend engineer for on-call",
      payload: {
        requirement:
          "A backend engineer to share on-call before launch. Approve this and the assistant opens the role in the chat, drafts the criteria, and asks what it needs.",
      },
    },
    {
      id: "tour-password",
      kind: "blocked",
      tier: "blocked",
      status: "blocked",
      title: "Not stored: a password was shared",
      line: 7,
      quote: "the admin password for the staging database",
      payload: { reason: "Passwords and keys are never stored, drafted, or passed on." },
    },
  ];
}

/** The tour as a meeting state, dated from `start`. */
export function productTour(start: Date): MeetingState {
  const at = (seconds: number) => new Date(start.getTime() + seconds * 1000).toISOString();
  const segments: TranscriptSegment[] = LINES.map(([speaker, text], index) => ({ index, speaker, text, at: at(index * 20) }));
  const actions: ProposedAction[] = cards(start).map((card) => ({
    id: card.id,
    meetingId: PRODUCT_TOUR_ID,
    kind: card.kind,
    tier: card.tier,
    status: card.status,
    title: card.title,
    trigger: { segmentIndex: card.line, speaker: LINES[card.line]![0], quote: card.quote },
    payload: card.payload,
    payloadHash: hashPayload(card.payload),
    version: 1,
    evidence: [],
    dedupeKey: card.id,
    createdAt: at(card.line * 20 + 5),
    ...(card.status === "executed" ? { decidedAt: at(card.line * 20 + 5), result: { summary: "Read-only; nothing to execute.", simulated: false } } : {}),
  }));
  return {
    meetingId: PRODUCT_TOUR_ID,
    title: "Welcome: a 3-minute tour of Meetings",
    employeeId: "jax",
    status: "ended",
    startedAt: start.toISOString(),
    endedAt: at(LINES.length * 20),
    segments,
    decisions: [{ text: "Keep the old checkout page as a fallback for launch week", segmentIndex: 2, speaker: "Jax", at: at(40) }],
    assignments: [
      { owner: "Jax", task: "email the launch partners the new timeline", due: "today", segmentIndex: 3, speaker: "Jax", at: at(60) },
      { owner: "Jax", task: "uptime alert on checkout", due: "Friday", segmentIndex: 4, speaker: "Priya", at: at(80) },
    ],
    minutes: {
      status: "ready",
      markdown: MANUAL,
      decisions: [{ text: "Keep the old checkout page as a fallback for launch week (Jax)", segmentIndex: 2 }],
      at: at(LINES.length * 20),
    },
    actions,
    trace: [],
  };
}

/** Writes the tour, replacing any earlier copy, so it always starts fresh. */
export async function seedProductTour(store: MeetingStore, start: Date = new Date()): Promise<MeetingState> {
  const tour = productTour(start);
  await store.save(tour);
  return tour;
}
