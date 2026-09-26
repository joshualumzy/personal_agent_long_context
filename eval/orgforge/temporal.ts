/**
 * OrgForge Benchmark Evaluation Harness Temporal Grounding.
 *
 * In OrgForge, questions use synthetic simulation days (e.g., "Day 4", "Day 8", "Day 44").
 * Enterprise artifacts in PostgreSQL are timestamped with ISO calendar dates (e.g. 2026-01-06, 2026-01-12).
 * This module grounds evaluation questions by annotating synthetic simulation days
 * with their corresponding calendar dates.
 */

/**
 * Pre-computed mapping from OrgForge simulation day to ISO calendar date string (YYYY-MM-DD).
 * Days 1-60 represent consecutive business days starting Thursday 2026-01-01.
 * Day -579 represents pre-simulation historical departure (2024-06-01).
 */
export const SIMULATION_DAY_TO_DATE: Readonly<Record<number, string>> = {
  "-579": "2024-06-01",
  1: "2026-01-01",
  2: "2026-01-02",
  3: "2026-01-05",
  4: "2026-01-06",
  5: "2026-01-07",
  6: "2026-01-08",
  7: "2026-01-09",
  8: "2026-01-12",
  9: "2026-01-13",
  10: "2026-01-14",
  11: "2026-01-15",
  12: "2026-01-16",
  13: "2026-01-19",
  14: "2026-01-20",
  15: "2026-01-21",
  16: "2026-01-22",
  17: "2026-01-23",
  18: "2026-01-26",
  19: "2026-01-27",
  20: "2026-01-28",
  21: "2026-01-29",
  22: "2026-01-30",
  23: "2026-02-02",
  24: "2026-02-03",
  25: "2026-02-04",
  26: "2026-02-05",
  27: "2026-02-06",
  28: "2026-02-09",
  29: "2026-02-10",
  30: "2026-02-11",
  31: "2026-02-12",
  32: "2026-02-13",
  33: "2026-02-16",
  34: "2026-02-17",
  35: "2026-02-18",
  36: "2026-02-19",
  37: "2026-02-20",
  38: "2026-02-23",
  39: "2026-02-24",
  40: "2026-02-25",
  41: "2026-02-26",
  42: "2026-02-27",
  43: "2026-03-02",
  44: "2026-03-03",
  45: "2026-03-04",
  46: "2026-03-05",
  47: "2026-03-06",
  48: "2026-03-09",
  49: "2026-03-10",
  50: "2026-03-11",
  51: "2026-03-12",
  52: "2026-03-13",
  53: "2026-03-16",
  54: "2026-03-17",
  55: "2026-03-18",
  56: "2026-03-19",
  57: "2026-03-20",
  58: "2026-03-23",
  59: "2026-03-24",
  60: "2026-03-25",
};

/**
 * Calculates business date starting from 2026-01-01 (Day 1) for any positive simulation day.
 */
function calculateBusinessDate(day: number): string {
  let count = 1;
  const cur = new Date(Date.UTC(2026, 0, 1));
  while (count < day) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      count++;
    }
  }
  return cur.toISOString().slice(0, 10);
}

/**
 * Returns the calendar date (YYYY-MM-DD) for a given simulation day.
 */
export function getCalendarDateForSimulationDay(day: number): string | undefined {
  if (day in SIMULATION_DAY_TO_DATE) {
    return SIMULATION_DAY_TO_DATE[day];
  }
  if (day > 0) {
    return calculateBusinessDate(day);
  }
  return undefined;
}

/**
 * Grounds a benchmark question by annotating synthetic simulation days with their calendar date context.
 *
 * 1. Replaces patterns like `Day\s*(\d+)` or `Day\u202f(\d+)` with `Day $1 (approx. <formatted date>)`.
 * 2. If the question does not contain a "Day N" pattern in the text but `day` is provided,
 *    appends ` [Time context: Day <day> (approx. <formatted date>)]`.
 *
 * @param questionText The raw question text from the benchmark dataset.
 * @param day Optional simulation day metadata from the question record.
 * @returns The temporally grounded question string.
 */
export function groundBenchmarkQuestion(questionText: string, day?: number): string {
  // Matches "Day" followed by optional space / non-breaking space and an optional negative integer
  const dayRegex = /\bDay[\s\u202f\u00a0]*(-?\d+)\b/gi;
  let hasReplaced = false;

  const grounded = questionText.replace(dayRegex, (match, dayStr: string) => {
    const dayNum = Number.parseInt(dayStr, 10);
    const date = getCalendarDateForSimulationDay(dayNum);
    if (!date) {
      return match;
    }
    hasReplaced = true;
    return `Day ${dayStr} (approx. ${date})`;
  });

  if (!hasReplaced && day !== undefined) {
    const date = getCalendarDateForSimulationDay(day);
    if (date) {
      return `${grounded} [Time context: Day ${day} (approx. ${date})]`;
    }
  }

  return grounded;
}
