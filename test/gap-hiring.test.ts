import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { resolveAsOf, type AsOf } from "../src/as-of.js";
import { PostgresCompanyKnowledge } from "../src/adapters/postgres-company-knowledge.js";

/*
 * Against the OrgForge corpus with the projections built (build_timeline.py).
 * Set TEST_DATABASE_URL to run; skipped otherwise.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe("knowledge gaps on the real corpus", { skip: databaseUrl ? false : "TEST_DATABASE_URL not set" }, () => {
  let knowledge: PostgresCompanyKnowledge;
  let days: string[];
  const day = (value: string): AsOf => {
    const resolved = resolveAsOf(value, days);
    assert.ok(resolved.ok, value);
    return resolved.day;
  };

  before(async () => {
    knowledge = new PostgresCompanyKnowledge(databaseUrl!);
    days = await knowledge.workingDays();
  });
  after(async () => {
    await knowledge?.close();
  });

  test("the roster says who was employed on a day", async () => {
    const employed = async (when: string, person: string) =>
      (await knowledge.roster(day(when))).find((row) => row.person === person);
    assert.equal((await employed("2026-02-16", "Morgan"))?.employed, true);
    assert.equal((await employed("2026-02-17", "Morgan"))?.employed, false);
    assert.equal((await employed("2026-02-17", "Morgan"))?.leftOn, "2026-02-17");
    assert.equal((await employed("2026-01-15", "Jordan"))?.employed, true);
    assert.equal((await employed("2026-01-16", "Jordan"))?.employed, false);
    assert.equal((await employed("2026-01-08", "Janice"))?.employed, false);
    assert.equal((await employed("2026-01-09", "Janice"))?.employed, true);
    // A departure after the day is not known on it.
    assert.equal((await employed("2026-01-15", "Morgan"))?.leftOn, null);
    assert.equal((await employed("2026-01-02", "Bill"))?.employed, false, "left before the record");
    assert.ok((await knowledge.roster(day("2026-01-02"))).every((row) => !("reason" in row)));
  });
});
