import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formFromChoices, JevWhenReader, ModelWhenReader, resolveWhen, type WhenForm } from "../src/meetings/when.js";
import type { JsonModel } from "../src/recruiting/llm.js";

/** Friday 25 Sep 2026, 10:00 in Singapore. */
const FRIDAY = new Date("2026-09-25T02:00:00Z");
/** Monday 28 Sep 2026, 10:00 in Singapore. */
const MONDAY = new Date("2026-09-28T02:00:00Z");

const form = (fields: Partial<WhenForm>): WhenForm => ({ kind: "none", unsure: [], ...fields });

describe("resolveWhen", () => {
  test("weekdays: the next one, or that day next week, or the week after", () => {
    assert.equal(resolveWhen(form({ kind: "weekday", weekday: "wed", time: "15:00" }), FRIDAY).start, "2026-09-30T15:00:00+08:00");
    assert.equal(resolveWhen(form({ kind: "weekday", weekday: "wed", week: "next", time: "15:00" }), FRIDAY).start, "2026-09-30T15:00:00+08:00");
    // Said on a Monday, "this Wednesday" and "next Wednesday" are a week apart.
    assert.equal(resolveWhen(form({ kind: "weekday", weekday: "wed", week: "this", time: "15:00" }), MONDAY).date, "2026-09-30");
    assert.equal(resolveWhen(form({ kind: "weekday", weekday: "wed", week: "next", time: "15:00" }), MONDAY).date, "2026-10-07");
    assert.equal(resolveWhen(form({ kind: "weekday", weekday: "fri", week: "after_next" }), FRIDAY).date, "2026-10-09");
    // The same weekday as the meeting means next week's, not today.
    assert.equal(resolveWhen(form({ kind: "weekday", weekday: "fri" }), FRIDAY).date, "2026-10-02");
  });

  test("dates come round next, and impossible ones are not invented", () => {
    assert.equal(resolveWhen(form({ kind: "date", month: 10, day: 20, time: "10:00" }), FRIDAY).start, "2026-10-20T10:00:00+08:00");
    assert.equal(resolveWhen(form({ kind: "date", month: 3, day: 1 }), FRIDAY).date, "2027-03-01");
    assert.equal(resolveWhen(form({ kind: "date", day: 20 }), FRIDAY).date, "2026-10-20", "the 20th has passed this month");
    assert.equal(resolveWhen(form({ kind: "date", month: 9, day: 31 }), FRIDAY).date, undefined);
  });

  test("relative days cross the month end correctly", () => {
    assert.equal(resolveWhen(form({ kind: "relative", offsetDays: 21 }), FRIDAY).date, "2026-10-16");
    assert.equal(resolveWhen(form({ kind: "relative", offsetDays: 1, time: "09:30" }), FRIDAY).start, "2026-09-26T09:30:00+08:00");
  });

  test("what is missing or unsure is asked for, never guessed", () => {
    assert.deepEqual(resolveWhen(form({}), FRIDAY).missing, ["Day and time for the meeting"]);
    const noTime = resolveWhen(form({ kind: "weekday", weekday: "fri" }), FRIDAY);
    assert.equal(noTime.start, undefined);
    assert.deepEqual(noTime.missing, ["Time of day for the meeting"]);
    const unsureWeek = resolveWhen(form({ kind: "weekday", weekday: "wed", week: "next", time: "15:00", unsure: ["week"] }), FRIDAY);
    assert.equal(unsureWeek.date, undefined);
    assert.deepEqual(unsureWeek.missing, ["Day for the meeting"]);
  });
});

describe("when readers", () => {
  test("Jev's choices fill the form; an answer below the threshold is marked unsure", async () => {
    let body: { model: string; questions: Record<string, { type: string; criteria: Record<string, string> }> } | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          answers: {
            kind: { type: "choice", choice: "weekday", probabilities: { weekday: 0.95 } },
            weekday: { type: "choice", choice: "wed", probabilities: { wed: 0.97 } },
            week: { type: "choice", choice: "next", probabilities: { next: 0.52, none: 0.48 } },
            time: { type: "choice", choice: "15:00", probabilities: { "15:00": 0.9 } },
            month: { type: "choice", choice: "none", probabilities: { none: 0.99 } },
            day: { type: "choice", choice: "none", probabilities: { none: 0.99 } },
            offset: { type: "choice", choice: "none", probabilities: { none: 0.99 } },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const result = await new JevWhenReader("key", 0.6, fetchImpl).read("next Wednesday at 3pm", "Friday");
    assert.equal(body!.model, "typesafe-ai/jev");
    assert.equal(body!.questions.weekday!.type, "choice");
    assert.ok(Object.keys(body!.questions.time!.criteria).length <= 255);
    assert.deepEqual(result, { kind: "weekday", weekday: "wed", week: "next", time: "15:00", unsure: ["week"] });
  });

  test("the model reader keeps only listed options", async () => {
    const model: JsonModel = {
      json: async <T>() => ({ kind: "weekday", weekday: "wednesday", week: "next", time: "3pm", unsure: ["week"] }) as T,
    };
    const result = await new ModelWhenReader(model).read("next Wednesday at 3pm", "Friday");
    assert.deepEqual(result, { kind: "weekday", week: "next", unsure: ["week"] }, "wednesday and 3pm are not option keys");
  });

  test("option keys map back to the form", () => {
    assert.deepEqual(formFromChoices({ kind: "date", month: "m10", day: "d20", time: "10:00" }, []), {
      kind: "date",
      month: 10,
      day: 20,
      time: "10:00",
      unsure: [],
    });
    assert.equal(formFromChoices({ kind: "relative", offset: "w3" }, []).offsetDays, 21);
  });
});

describe("fallback reader", () => {
  test("uses the second reader only when the first fails", async () => {
    const { FallbackWhenReader } = await import("../src/meetings/when.js");
    const good = { name: "fast", read: async () => ({ kind: "none" as const, unsure: [] }) };
    const bad = { name: "fast", read: async () => Promise.reject(new Error("503")) };
    const backup = { name: "model", read: async () => ({ kind: "relative" as const, offsetDays: 1, unsure: [] }) };
    const failures: unknown[] = [];
    assert.equal((await new FallbackWhenReader(good, backup).read("x", "Friday")).kind, "none");
    assert.equal((await new FallbackWhenReader(bad, backup, (error) => failures.push(error)).read("x", "Friday")).kind, "relative");
    assert.equal(failures.length, 1);
  });
});

describe("ambiguous next weekday", () => {
  /** Saturday 26 Sep 2026, 11:00 in Singapore. */
  const SATURDAY = new Date("2026-09-26T03:00:00Z");
  const nextWed = form({ kind: "weekday", weekday: "wed", week: "next", time: "15:00" });

  test("English 'next Wednesday' on a Saturday offers 30 Sep and 7 Oct and fills in neither", () => {
    const reading = resolveWhen(nextWed, SATURDAY, "next Wednesday at 3pm");
    assert.equal(reading.start, undefined);
    assert.deepEqual(reading.options?.map((option) => option.start), ["2026-09-30T15:00:00+08:00", "2026-10-07T15:00:00+08:00"]);
    assert.deepEqual(reading.missing, ["Which day: Wed 30 Sept or Wed 7 Oct"]);
  });

  test("on a Monday the same words also split between this week's and next week's", () => {
    assert.deepEqual(resolveWhen(nextWed, MONDAY, "next Wednesday at 3pm").options?.map((option) => option.date), ["2026-09-30", "2026-10-07"]);
  });

  test("Chinese 下周三 means next calendar week, so it is filled in", () => {
    const reading = resolveWhen(nextWed, SATURDAY, "下周三下午三点");
    assert.equal(reading.start, "2026-09-30T15:00:00+08:00");
    assert.equal(reading.options, undefined);
  });

  test("a bare weekday is not ambiguous", () => {
    const reading = resolveWhen(form({ kind: "weekday", weekday: "wed", time: "15:00" }), SATURDAY, "Wednesday at 3pm");
    assert.equal(reading.start, "2026-09-30T15:00:00+08:00");
  });

  test("with no time said, the options are dates and the time is asked for too", () => {
    const reading = resolveWhen(form({ kind: "weekday", weekday: "fri", week: "next" }), FRIDAY, "next Friday afternoon");
    assert.deepEqual(reading.options?.map((option) => option.start ?? option.date), ["2026-10-02", "2026-10-09"]);
    assert.deepEqual(reading.missing, ["Which day: Fri 2 Oct or Fri 9 Oct", "Time of day for the meeting"]);
  });
});
