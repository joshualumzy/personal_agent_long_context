import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getCalendarDateForSimulationDay,
  groundBenchmarkQuestion,
  SIMULATION_DAY_TO_DATE,
} from "../eval/orgforge/temporal.js";

test("maps simulation days to correct ISO calendar dates", () => {
  assert.equal(getCalendarDateForSimulationDay(1), "2026-01-01");
  assert.equal(getCalendarDateForSimulationDay(2), "2026-01-02");
  assert.equal(getCalendarDateForSimulationDay(3), "2026-01-05");
  assert.equal(getCalendarDateForSimulationDay(4), "2026-01-06");
  assert.equal(getCalendarDateForSimulationDay(8), "2026-01-12");
  assert.equal(getCalendarDateForSimulationDay(15), "2026-01-21");
  assert.equal(getCalendarDateForSimulationDay(25), "2026-02-04");
  assert.equal(getCalendarDateForSimulationDay(32), "2026-02-13");
  assert.equal(getCalendarDateForSimulationDay(37), "2026-02-20");
  assert.equal(getCalendarDateForSimulationDay(38), "2026-02-23");
  assert.equal(getCalendarDateForSimulationDay(44), "2026-03-03");
  assert.equal(getCalendarDateForSimulationDay(60), "2026-03-25");
  assert.equal(getCalendarDateForSimulationDay(-579), "2024-06-01");
  assert.equal(getCalendarDateForSimulationDay(-999), undefined);
});

test("grounds questions with Day N pattern in text", () => {
  const raw = "If the documentation gap in the design doc that Jax contributed to on Day 4 had not existed, would the incident still have occurred?";
  const grounded = groundBenchmarkQuestion(raw, 4);
  assert.equal(
    grounded,
    "If the documentation gap in the design doc that Jax contributed to on Day 4 (approx. 2026-01-06) had not existed, would the incident still have occurred?",
  );
});

test("grounds questions with unicode narrow non-breaking space (Day\\u202fN)", () => {
  const raw = "Was a Salesforce risk flag on the related deals created in response to the incident on Day\u202f8 involving Jax, Kaitlyn?";
  const grounded = groundBenchmarkQuestion(raw);
  assert.equal(
    grounded,
    "Was a Salesforce risk flag on the related deals created in response to the incident on Day 8 (approx. 2026-01-12) involving Jax, Kaitlyn?",
  );
});

test("grounds pre-simulation departure Day -579", () => {
  const raw = "If the new hire had not started on Day\u202f-579, would Janice have filled the gap?";
  const grounded = groundBenchmarkQuestion(raw, -579);
  assert.equal(
    grounded,
    "If the new hire had not started on Day -579 (approx. 2024-06-01), would Janice have filled the gap?",
  );
});

test("appends time context trailer when Day is absent from text but provided as metadata", () => {
  const raw = "Did Jax review the telemetry pipeline architecture?";
  const grounded = groundBenchmarkQuestion(raw, 15);
  assert.equal(
    grounded,
    "Did Jax review the telemetry pipeline architecture? [Time context: Day 15 (approx. 2026-01-21)]",
  );
});

test("leaves text unchanged when no Day in text and no day metadata provided", () => {
  const raw = "Who is the primary owner of the auth service?";
  assert.equal(groundBenchmarkQuestion(raw), raw);
});
