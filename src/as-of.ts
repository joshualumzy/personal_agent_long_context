/**
 * "As of day D": looking at the company from one simulated working day, with
 * nothing that happened after it.
 *
 * The rule is one line — nothing the system reads may be later than the end of
 * D — and it lives here so every reader applies the same boundary:
 *
 *   evidence   occurred_at < asOfCutoff(D)    (undated artifacts never pass)
 *   day plans  day = D
 *   tickets    valid_from <= D AND (valid_to IS NULL OR valid_to > D)
 *
 * The simulation's clock is UTC: its working hours run 09:00–17:00 UTC and
 * every artifact's occurred_at agrees with the day in its id when read in UTC.
 * So D ends at midnight UTC, and orgforge_kb/build_timeline.py dates its rows
 * the same way.
 *
 * Which days exist is the data's business, not this module's: the caller
 * passes the working days the planner projection covers (the days that have a
 * department plan), and a date is checked against them.
 */

/** A validated day, YYYY-MM-DD, that is one of the planner's working days. */
export type AsOf = string & { readonly __asOf: unique symbol };

export const AS_OF_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type AsOfResult =
  | { ok: true; day: AsOf; requested: string; adjusted: boolean }
  | { ok: false; error: string };

/**
 * Check a requested day against the working days (sorted or not). A day inside
 * the range that is not a working day — a weekend — falls back to the working
 * day before it, so "Saturday" shows Friday's state. Outside the range is an
 * error rather than a silent clamp: the company did not exist yet, or the
 * record stops.
 */
export function resolveAsOf(requested: unknown, workingDays: readonly string[]): AsOfResult {
  if (typeof requested !== "string" || !AS_OF_PATTERN.test(requested.trim())) {
    return { ok: false, error: "asOf must be a date, YYYY-MM-DD." };
  }
  const day = requested.trim();
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    return { ok: false, error: `${day} is not a calendar date.` };
  }
  const days = [...new Set(workingDays)].sort();
  if (days.length === 0) return { ok: false, error: "No working days are recorded, so no date can be chosen." };
  const first = days[0]!;
  const last = days[days.length - 1]!;
  if (day < first || day > last) {
    return { ok: false, error: `${day} is outside the recorded working days, ${first} to ${last}.` };
  }
  let chosen = first;
  for (const candidate of days) {
    if (candidate > day) break;
    chosen = candidate;
  }
  return { ok: true, day: chosen as AsOf, requested: day, adjusted: chosen !== day };
}

/** The first instant after D: evidence must have occurred strictly before it. */
export function asOfCutoff(day: AsOf | string): string {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/** Whether a piece of evidence may be seen on day D. Undated evidence may not:
 * nothing says it existed yet. */
export function visibleOn(day: AsOf | string, occurredAt: string | undefined | null): boolean {
  if (!occurredAt) return false;
  const when = Date.parse(occurredAt);
  return Number.isFinite(when) && when < Date.parse(asOfCutoff(day));
}

/** The sentence the agent is told, so it answers as someone standing on D. */
export function asOfInstruction(day: AsOf | string): string {
  return [
    `Today is ${day}. You are answering as of the end of that working day.`,
    `You do not know anything that happened after ${day}; the evidence you can retrieve stops there.`,
    "If the answer depends on something that had not happened or was not yet known by then, say it is not known yet rather than guessing.",
  ].join(" ");
}
