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

  test("domain health: who owns what, and whether they are still here", async () => {
    const health = async (when: string) =>
      Object.fromEntries((await knowledge.domainHealth(day(when))).map((row) => [row.domain, row]));
    // Bill left before the record; TitanDB has no owner here until Janice joins on 01-09.
    const early = await health("2026-01-02");
    assert.equal(early["titandb"]!.owner, "Bill");
    assert.equal(early["titandb"]!.ownerActive, false);
    assert.equal((await health("2026-01-09"))["titandb"]!.owner, "Janice");
    // Morgan's domains on the day he leaves: kubernetes-deploy has nobody until
    // Sanjay takes it on 02-27; terraform-infra goes to Priya, the registry's
    // owner, with no recorded hand-over, so from the day Morgan leaves.
    const left = await health("2026-02-17");
    assert.equal(left["kubernetes-deploy"]!.ownerActive, false);
    assert.equal(left["terraform-infra"]!.owner, "Priya");
    assert.equal((await health("2026-02-27"))["kubernetes-deploy"]!.owner, "Sanjay");
    // Jordan's redis-cache has nobody from 01-16 until Yusuf on 01-21.
    assert.equal((await health("2026-01-19"))["redis-cache"]!.ownerActive, false);
    assert.equal((await health("2026-01-21"))["redis-cache"]!.owner, "Yusuf");
  });

  test("domain health uses nothing after the day", async () => {
    for (const when of ["2026-01-06", "2026-02-17", "2026-03-10"]) {
      const cutoff = Date.parse(`${day(when)}T24:00:00Z`);
      const rows = await knowledge.domainHealth(day(when));
      const ids = [...new Set(rows.flatMap((row) => [...row.evidence.contributors, ...row.evidence.incidents]))];
      const found = await knowledge.sources(ids);
      assert.equal(found.length, ids.length, "every evidence id opens");
      assert.deepEqual(found.filter((item) => !item.occurredAt || Date.parse(item.occurredAt) >= cutoff).map((item) => item.sourceId), []);
      for (const row of rows) {
        const roster = await knowledge.roster(day(when));
        const employed = new Set(roster.filter((entry) => entry.employed).map((entry) => entry.person));
        assert.ok(row.activeContributors30d.every((person) => employed.has(person)), `${row.domain} on ${when}`);
      }
    }
  });
});
