import type { JsonModel } from "../recruiting/llm.js";

/**
 * "When" in a meeting, read in two steps. A reader (a model) fills a small
 * form whose every field is a closed set of options; this file's code turns
 * the form into a date. The model understands the words ("next Wednesday",
 * "下下周五", "Oct 20 at 10am"); it never counts days, which models get wrong.
 */

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface WhenForm {
  kind: "weekday" | "date" | "relative" | "none";
  weekday?: Weekday;
  /** For a weekday: which week it falls in. Absent means the next one to come. */
  week?: "this" | "next" | "after_next";
  month?: number;
  day?: number;
  /** For "tomorrow", "in three weeks": days from the meeting day. */
  offsetDays?: number;
  /** "15:00". Absent when no clock time was said ("in the afternoon" is not one). */
  time?: string;
  /** Fields the reader was not sure about; they are treated as not given. */
  unsure: string[];
}

export interface WhenReader {
  readonly name: string;
  read(said: string, meetingDay: string): Promise<WhenForm>;
}

export interface WhenReading {
  /** ISO start with the Singapore offset, only when both the day and the clock time are known. */
  start?: string;
  /** "Wed 30 Sep", when the day is known. */
  day?: string;
  /** "2026-09-30", when the day is known. */
  date?: string;
  /** One line for the card, saying how the words were read. */
  explanation: string;
  /** What is still missing, for the employee to fill in. */
  missing: string[];
}

const SGT_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

/** Midnight of the meeting's day in Singapore, as a UTC-based date for arithmetic. */
function sgtDay(at: Date): Date {
  const local = new Date(at.getTime() + SGT_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

/** Monday = 0 … Sunday = 6. */
function weekdayIndex(day: Date): number {
  return (day.getUTCDay() + 6) % 7;
}

export function dayLabel(day: Date): string {
  return day.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

function addDays(day: Date, days: number): Date {
  return new Date(day.getTime() + days * DAY_MS);
}

/**
 * Turns a filled form into a date, relative to the meeting. Conventions:
 * - a weekday alone, or "this" weekday: the first one after the meeting day;
 * - "next" weekday: that day in the following Monday-to-Sunday week;
 * - "after next": the week after that;
 * - a date without a year: the next time it comes round.
 */
export function resolveWhen(form: WhenForm, meetingAt: Date): WhenReading {
  const today = sgtDay(meetingAt);
  const unsure = new Set(form.unsure);
  let day: Date | null = null;
  let how = "";

  if (form.kind === "weekday" && form.weekday && !unsure.has("weekday") && !unsure.has("week")) {
    const target = WEEKDAYS.indexOf(form.weekday);
    const todayIndex = weekdayIndex(today);
    if (form.week === "next" || form.week === "after_next") {
      const nextMonday = addDays(today, 7 - todayIndex);
      day = addDays(nextMonday, target + (form.week === "after_next" ? 7 : 0));
      how = form.week === "next" ? "that day next week" : "that day the week after next";
    } else {
      day = addDays(today, ((target - todayIndex + 7) % 7) || 7);
      how = "the next one to come";
    }
  } else if (form.kind === "date" && form.day && !unsure.has("day") && !unsure.has("month")) {
    const year = today.getUTCFullYear();
    const month = form.month ? form.month - 1 : today.getUTCMonth();
    let candidate = new Date(Date.UTC(year, month, form.day));
    if (candidate.getUTCDate() !== form.day) candidate = new Date(NaN); // 31 Sep and the like
    if (!Number.isNaN(candidate.getTime()) && candidate < today) {
      candidate = form.month
        ? new Date(Date.UTC(year + 1, month, form.day))
        : new Date(Date.UTC(year, month + 1, form.day));
    }
    if (!Number.isNaN(candidate.getTime())) {
      day = candidate;
      how = "the next time that date comes round";
    }
  } else if (form.kind === "relative" && form.offsetDays && !unsure.has("offsetDays")) {
    day = addDays(today, form.offsetDays);
    how = `${form.offsetDays} day(s) after the meeting`;
  }

  const time = form.time && !unsure.has("time") && /^([01]\d|2[0-3]):[0-5]\d$/.test(form.time) ? form.time : undefined;
  const missing = !day && !time ? ["Day and time for the meeting"] : !day ? ["Day for the meeting"] : !time ? ["Time of day for the meeting"] : [];

  if (!day) {
    return { explanation: "No day could be read from what was said.", missing };
  }
  const label = dayLabel(day);
  const date = day.toISOString().slice(0, 10);
  return {
    day: label,
    date,
    ...(time ? { start: `${date}T${time}:00+08:00` } : {}),
    explanation: `Read as ${label}${time ? `, ${time}` : ", time not said"} (${how}).`,
    missing,
  };
}

// ------------------------------------------------------------------ readers

const HALF_HOURS = Array.from({ length: 48 }, (_, index) => {
  const hour = String(Math.floor(index / 2)).padStart(2, "0");
  return `${hour}:${index % 2 ? "30" : "00"}`;
});

const OFFSETS: Record<string, number> = {
  ...Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`d${index + 1}`, index + 1])),
  w1: 7,
  w2: 14,
  w3: 21,
  w4: 28,
};

function offsetDescription(key: string): string {
  if (key === "d1") return "tomorrow, in 1 day";
  if (key === "d2") return "the day after tomorrow, in 2 days";
  if (key.startsWith("w")) return `in ${key.slice(1)} week(s)`;
  return `in ${key.slice(1)} days`;
}

/** The form as closed questions: each answer is one of a few named options. */
export function formQuestions(): Record<string, { instructions: string; criteria: Record<string, string> }> {
  return {
    kind: {
      instructions: "How does the text say when something will happen?",
      criteria: {
        weekday: "names a day of the week, with or without which week: Wednesday, next Friday, the Wednesday after next, 周三, 下周五, 下下周五",
        date: "names a calendar date, such as 20 October or 10月20日",
        relative: "counts days or weeks from today and names no day of the week: tomorrow, the day after tomorrow, in three weeks, 明天, 后天, 三周后",
        none: "gives no day at all, or only a vague one such as sometime next week or end of the month",
      },
    },
    weekday: {
      instructions: "Which day of the week does the text name?",
      criteria: {
        none: "no day of the week is named",
        mon: "Monday, 周一, 星期一",
        tue: "Tuesday, 周二, 星期二",
        wed: "Wednesday, 周三, 星期三",
        thu: "Thursday, 周四, 星期四",
        fri: "Friday, 周五, 星期五",
        sat: "Saturday, 周六, 星期六",
        sun: "Sunday, 周日, 星期天",
      },
    },
    week: {
      instructions: "For a named weekday, which week does the text say it is in?",
      criteria: {
        none: "no week is said, only the weekday (Wednesday, 周三)",
        this: "this week (this Wednesday, 这周三, 本周三)",
        next: "next week (next Wednesday, 下周三)",
        after_next: "the week after next (the Wednesday after next, 下下周三)",
      },
    },
    month: {
      instructions: "Which month does the text name, if any?",
      criteria: {
        none: "no month is named",
        ...Object.fromEntries(
          ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map(
            (name, index) => [`m${index + 1}`, `${name}, ${index + 1}月`],
          ),
        ),
      },
    },
    day: {
      instructions: "Which day of the month does the text name, if any (the 20 in 20 October)?",
      criteria: {
        none: "no day of the month is named",
        ...Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`d${index + 1}`, `the ${index + 1}th, ${index + 1}日 or ${index + 1}号`])),
      },
    },
    offset: {
      instructions: "If the text counts days or weeks from today without naming a day of the week, how many? A named weekday (next Friday, 下周五) is none here.",
      criteria: { none: "it does not count from today", ...Object.fromEntries(Object.keys(OFFSETS).map((key) => [key, offsetDescription(key)])) },
    },
    time: {
      instructions: "Which clock time does the text say? Only a stated clock time counts; morning or afternoon alone is none.",
      criteria: {
        none: "no clock time is said",
        ...Object.fromEntries(HALF_HOURS.map((slot) => [slot, `${slot} (24-hour clock)`])),
      },
    },
  };
}

/** Maps the chosen options back onto the form. */
export function formFromChoices(choices: Record<string, string | undefined>, unsure: string[]): WhenForm {
  const kind = (["weekday", "date", "relative", "none"] as const).find((value) => value === choices.kind) ?? "none";
  const form: WhenForm = { kind, unsure };
  const weekday = WEEKDAYS.find((value) => value === choices.weekday);
  if (weekday) form.weekday = weekday;
  if (choices.week === "this" || choices.week === "next" || choices.week === "after_next") form.week = choices.week;
  if (choices.month?.startsWith("m")) form.month = Number(choices.month.slice(1));
  if (choices.day?.startsWith("d")) form.day = Number(choices.day.slice(1));
  if (choices.offset && OFFSETS[choices.offset]) form.offsetDays = OFFSETS[choices.offset];
  if (choices.time && HALF_HOURS.includes(choices.time)) form.time = choices.time;
  return form;
}

const FIELD_OF_QUESTION: Record<string, string> = {
  weekday: "weekday",
  week: "week",
  month: "month",
  day: "day",
  offset: "offsetDays",
  time: "time",
  kind: "kind",
};

/**
 * Jev through Vercel AI Gateway: all questions in one request, each answered
 * with a probability per option. An answer below `threshold` is marked unsure.
 */
export class JevWhenReader implements WhenReader {
  readonly name = "jev";

  constructor(
    private readonly apiKey: string,
    private readonly threshold = 0.6,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Immediate retries after a 503 or 429. */
    private readonly retries = 2,
  ) {}

  async read(said: string, meetingDay: string): Promise<WhenForm> {
    const questions = Object.fromEntries(
      Object.entries(formQuestions()).map(([id, question]) => [id, { type: "choice", ...question }]),
    );
    const request = () =>
      this.fetchImpl("https://ai-gateway.vercel.sh/v1/evaluate", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "typesafe-ai/jev",
          state: { said, meetingDay },
          questions,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    // The service returns an occasional 503, sometimes in runs. Measured on
    // 25 back-to-back requests, an immediate retry succeeded every time, and
    // waiting between tries only added delay, so retries do not wait;
    // FallbackWhenReader covers a run of failures.
    let response = await request();
    for (let attempt = 0; attempt < this.retries && (response.status === 503 || response.status === 429); attempt += 1) {
      response = await request();
    }
    const body = (await response.json()) as {
      answers?: Record<string, { choice?: string; probabilities?: Record<string, number> }>;
      error?: { message?: string };
    };
    if (!response.ok || !body.answers) {
      throw new Error(`Jev request failed (HTTP ${response.status}): ${body.error?.message ?? "no answers"}`);
    }
    const choices: Record<string, string | undefined> = {};
    const unsure: string[] = [];
    for (const [id, answer] of Object.entries(body.answers)) {
      choices[id] = answer.choice;
      const probability = answer.choice ? answer.probabilities?.[answer.choice] ?? 0 : 0;
      if (answer.choice && answer.choice !== "none" && probability < this.threshold) unsure.push(FIELD_OF_QUESTION[id] ?? id);
    }
    return formFromChoices(choices, unsure);
  }
}

/** The meeting model filling the same form as JSON, told to name the fields it is unsure of. */
export class ModelWhenReader implements WhenReader {
  readonly name = "qwen";

  constructor(private readonly model: JsonModel) {}

  async read(said: string, meetingDay: string): Promise<WhenForm> {
    const questions = formQuestions();
    const reply = await this.model.json<Record<string, unknown>>({
      task: "when form",
      system: [
        "Fill a form about when something will happen, from the words below. Do not work out any date yourself: only say which option each question's answer is.",
        "For each question, answer with exactly one of its option keys. List in \"unsure\" the question keys whose answer you are not confident about.",
        `Reply as {${Object.keys(questions).map((id) => `"${id}": string`).join(", ")}, "unsure": string[]}.`,
      ].join("\n"),
      input: {
        said,
        meetingDay,
        questions: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, { question: question.instructions, options: question.criteria }])),
      },
    });
    const choices: Record<string, string | undefined> = {};
    for (const id of Object.keys(questions)) {
      const value = reply?.[id];
      if (typeof value === "string" && value in questions[id]!.criteria) choices[id] = value;
    }
    const unsure = Array.isArray(reply?.unsure)
      ? reply.unsure.filter((entry): entry is string => typeof entry === "string").map((id) => FIELD_OF_QUESTION[id] ?? id)
      : [];
    return formFromChoices(choices, unsure);
  }
}

/** Asks the first reader and, when its request fails, the second: a fast reader with a dependable fallback. */
export class FallbackWhenReader implements WhenReader {
  readonly name: string;

  constructor(
    private readonly first: WhenReader,
    private readonly second: WhenReader,
    private readonly onFallback: (error: unknown) => void = () => {},
  ) {
    this.name = `${first.name}→${second.name}`;
  }

  async read(said: string, meetingDay: string): Promise<WhenForm> {
    try {
      return await this.first.read(said, meetingDay);
    } catch (error) {
      this.onFallback(error);
      return this.second.read(said, meetingDay);
    }
  }
}
