import type { CalendarPayload, DocPayload, EmailPayload, MessagePayload, TicketPayload } from "./domain.js";

/**
 * Prefilled links that open an approved action in the employee's own,
 * already signed-in tool. The agent holds no credentials for these tools:
 * the employee's click in their own account is what performs the effect.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Spaces become %20, not "+": Outlook on the web shows "+" literally. */
function withQuery(base: string, params: Record<string, string | undefined>): string {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `${base}?${query}`;
}

export function gmailComposeLink(payload: EmailPayload): string {
  return withQuery("https://mail.google.com/mail/", {
    view: "cm",
    fs: "1",
    to: payload.to,
    su: payload.subject,
    body: payload.body,
  });
}

/** 2026-10-01T09:00:00Z → 20261001T090000Z, the form Google Calendar expects. */
function calendarStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function googleCalendarLink(payload: CalendarPayload): string {
  const emails = payload.attendees.filter((entry) => EMAIL_RE.test(entry));
  const names = payload.attendees.filter((entry) => !EMAIL_RE.test(entry));
  const details = [payload.notes, names.length > 0 ? `Invite: ${names.join(", ")}` : undefined]
    .filter(Boolean)
    .join("\n\n");

  let dates: string | undefined;
  const start = payload.proposedStart ? new Date(payload.proposedStart) : null;
  if (start && !Number.isNaN(start.getTime())) {
    const end = new Date(start.getTime() + payload.durationMinutes * 60_000);
    dates = `${calendarStamp(start)}/${calendarStamp(end)}`;
  }

  return withQuery("https://calendar.google.com/calendar/render", {
    action: "TEMPLATE",
    text: payload.title,
    dates,
    details,
    add: emails.join(","),
  });
}

/** `repo` is "owner/name". Assignee and due date go in the body: they are names, not GitHub logins. */
export function githubIssueLink(repo: string, payload: TicketPayload): string {
  const meta = [
    payload.assignee ? `Assignee: ${payload.assignee}` : undefined,
    payload.due ? `Due: ${payload.due}` : undefined,
    payload.project ? `Project: ${payload.project}` : undefined,
  ].filter(Boolean);
  const body = meta.length > 0 ? `${payload.description}\n\n${meta.join("\n")}` : payload.description;
  return withQuery(`https://github.com/${repo}/issues/new`, { title: payload.title, body });
}

/** Microsoft 365 (work or school) Outlook on the web. */
const OUTLOOK_BASE = "https://outlook.office.com";

export function outlookComposeLink(payload: EmailPayload): string {
  return withQuery(`${OUTLOOK_BASE}/mail/deeplink/compose`, {
    to: payload.to,
    subject: payload.subject,
    body: payload.body,
  });
}

export function outlookCalendarLink(payload: CalendarPayload): string {
  const emails = payload.attendees.filter((entry) => EMAIL_RE.test(entry));
  const names = payload.attendees.filter((entry) => !EMAIL_RE.test(entry));
  const body = [payload.notes, names.length > 0 ? `Invite: ${names.join(", ")}` : undefined].filter(Boolean).join("\n\n");

  let startdt: string | undefined;
  let enddt: string | undefined;
  const start = payload.proposedStart ? new Date(payload.proposedStart) : null;
  if (start && !Number.isNaN(start.getTime())) {
    startdt = start.toISOString();
    enddt = new Date(start.getTime() + payload.durationMinutes * 60_000).toISOString();
  }

  return withQuery(`${OUTLOOK_BASE}/calendar/deeplink/compose`, {
    subject: payload.title,
    startdt,
    enddt,
    body,
    to: emails.join(","),
  });
}

/** With a phone number the chat opens directly; without one WhatsApp asks which contact to send it to. */
export function whatsappLink(payload: MessagePayload): string {
  const phone = payload.address.replace(/\D/g, "");
  const isPhone = !EMAIL_RE.test(payload.address) && phone.length >= 7;
  return withQuery(`https://wa.me/${isPhone ? phone : ""}`, { text: payload.text });
}

/** Teams needs the recipient's work email to open a chat; returns null without one. */
export function teamsChatLink(payload: MessagePayload): string | null {
  if (!EMAIL_RE.test(payload.address)) return null;
  return withQuery("https://teams.microsoft.com/l/chat/0/0", { users: payload.address, message: payload.text });
}

/**
 * No document editor accepts body text in a link, so a new document is a
 * blank one opened in the employee's own account plus the draft on their
 * clipboard to paste in.
 */
export const NEW_DOC_URL = {
  google: "https://docs.new",
  microsoft: "https://word.new",
} as const;

export function docClipboardText(payload: DocPayload): string {
  return `# ${payload.title}\n\n${payload.body}`;
}
