import test from "node:test";
import assert from "node:assert/strict";
import { searchWindowOf } from "../src/soclaas-company-agent.js";

test("from/to become a UTC window whose end includes the whole of the last day", () => {
  assert.deepEqual(searchWindowOf("2026-01-18", "2026-01-24"), {
    after: "2026-01-18T00:00:00.000Z",
    before: "2026-01-25T00:00:00.000Z",
  });
  assert.deepEqual(searchWindowOf(undefined, "2026-01-24"), { after: null, before: "2026-01-25T00:00:00.000Z" });
  assert.equal(searchWindowOf(undefined, ""), undefined);
});

test("a malformed or reversed window is an error the model can correct, not an unfiltered search", () => {
  assert.throws(() => searchWindowOf("Jan 21", undefined), /YYYY-MM-DD/);
  assert.throws(() => searchWindowOf("2026-02-01", "2026-01-01"), /must not be after/);
});
