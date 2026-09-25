import type { BusyPeriod } from "../recruiting/gmail.js";
import type { AvailabilityChecker, BusySlot, CalendarPayload } from "./domain.js";

const ME = "me";
/** Singapore has no daylight saving, so a fixed offset is exact. */
const SGT_OFFSET_MS = 8 * 3_600_000;
const WORKDAY_START_HOUR = 9;
const WORKDAY_END_HOUR = 18;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function googleAvailability(google: {
  canReadCalendar(): Promise<boolean>;
  busy(calendars: string[], from: string, to: string): Promise<Map<string, BusyPeriod[] | null>>;
}): AvailabilityChecker {
  return {
    connected: () => google.canReadCalendar(),
    async busy(people, from, to) {
      const ids = people.map((person) => (person === ME ? "primary" : person));
      const raw = await google.busy(ids, from.toISOString(), to.toISOString());
      const result = new Map<string, BusySlot[] | null>();
      people.forEach((person, index) => {
        const periods = raw.get(ids[index]!);
        result.set(
          person,
          periods ? periods.map((period) => ({ start: new Date(period.start), end: new Date(period.end) })) : null,
        );
      });
      return result;
    },
  };
}

function overlaps(slot: BusySlot, start: Date, end: Date): boolean {
  return slot.start < end && slot.end > start;
}

/** "Tue 30 Sep, 10:00", in Singapore time. */
export function sgtLabel(date: Date): string {
  const local = new Date(date.getTime() + SGT_OFFSET_MS);
  const day = local.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return `${day}, ${local.toISOString().slice(11, 16)}`;
}

/**
 * Checks the invite against the calendars the employee can see: whether
 * everyone is free at the proposed time, or, with no time proposed, the first
 * few working-hour slots in the next five weekdays when they all are. Returns
 * lines for the card; never changes the invite itself.
 */
export async function checkAvailability(
  checker: AvailabilityChecker,
  invite: CalendarPayload,
  now: Date,
): Promise<string[]> {
  const people = [ME, ...invite.attendees.filter((attendee) => EMAIL_SHAPE.test(attendee))];
  const durationMs = invite.durationMinutes * 60_000;
  const label = (person: string) => (person === ME ? "You" : person);
  const start = invite.proposedStart ? new Date(invite.proposedStart) : null;

  if (start && !Number.isNaN(start.getTime())) {
    const end = new Date(start.getTime() + durationMs);
    const busy = await checker.busy(people, start, end);
    const lines: string[] = [];
    for (const person of people) {
      const slots = busy.get(person);
      if (slots === null || slots === undefined) lines.push(`${label(person)}: calendar not visible, so not checked.`);
      else if (slots.some((slot) => overlaps(slot, start, end))) lines.push(`${label(person)}: busy at ${sgtLabel(start)}.`);
      else lines.push(`${label(person)}: free at ${sgtLabel(start)}.`);
    }
    return lines;
  }

  const from = new Date(now.getTime());
  const to = new Date(now.getTime() + 8 * 86_400_000);
  const busy = await checker.busy(people, from, to);
  const visible = people.filter((person) => busy.get(person));
  const suggestions: Date[] = [];
  // Walk half-hour steps through working hours on weekdays, Singapore time.
  const firstStep = Math.ceil((from.getTime() + 3_600_000) / 1_800_000) * 1_800_000;
  for (let at = firstStep; at + durationMs <= to.getTime() && suggestions.length < 3; at += 1_800_000) {
    const local = new Date(at + SGT_OFFSET_MS);
    const weekday = local.getUTCDay();
    const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (weekday === 0 || weekday === 6) continue;
    if (minutes < WORKDAY_START_HOUR * 60 || minutes + invite.durationMinutes > WORKDAY_END_HOUR * 60) continue;
    const slotStart = new Date(at);
    const slotEnd = new Date(at + durationMs);
    if (visible.every((person) => !busy.get(person)!.some((slot) => overlaps(slot, slotStart, slotEnd)))) {
      suggestions.push(slotStart);
      at += 3 * 3_600_000; // spread the suggestions out
    }
  }
  const who = visible.map(label).join(", ") || "nobody";
  const hidden = people.filter((person) => !busy.get(person)).map(label);
  return [
    suggestions.length > 0
      ? `No time was set. Free for ${who}: ${suggestions.map(sgtLabel).join("; ")}.`
      : `No time was set, and ${who} had no shared free slot in working hours this week.`,
    ...(hidden.length > 0 ? [`Not checked (calendar not visible): ${hidden.join(", ")}.`] : []),
  ];
}
