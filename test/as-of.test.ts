import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { asOfCutoff, asOfInstruction, resolveAsOf, visibleOn, type AsOf } from "../src/as-of.js";
import { PostgresCompanyKnowledge } from "../src/adapters/postgres-company-knowledge.js";
import type { CompanyKnowledge, Evidence } from "../src/company-domain.js";

const WORKING_DAYS = ["2026-01-01", "2026-01-02", "2026-01-05", "2026-01-06", "2026-03-25"];

describe("choosing a day to stand on", () => {
  test("a working day is taken as it is", () => {
    assert.deepEqual(resolveAsOf("2026-01-05", WORKING_DAYS), {
      ok: true, day: "2026-01-05", requested: "2026-01-05", adjusted: false,
    });
  });

  test("a weekend falls back to the working day before it", () => {
    const result = resolveAsOf("2026-01-04", WORKING_DAYS);
    assert.ok(result.ok);
    assert.equal(result.day, "2026-01-02");
    assert.equal(result.adjusted, true);
  });

  test("the working days need not arrive sorted", () => {
    const result = resolveAsOf("2026-01-03", [...WORKING_DAYS].reverse());
    assert.ok(result.ok);
    assert.equal(result.day, "2026-01-02");
  });

  test("a day outside the record, or not a date at all, is refused", () => {
    for (const bad of ["2025-12-31", "2026-03-26", "2026-02-30", "yesterday", "", 20260105, undefined]) {
      const result = resolveAsOf(bad, WORKING_DAYS);
      assert.equal(result.ok, false, `${String(bad)} should be refused`);
    }
    assert.match((resolveAsOf("2026-04-11", WORKING_DAYS) as { error: string }).error, /2026-01-01 to 2026-03-25/);
    assert.equal(resolveAsOf("2026-01-05", []).ok, false);
  });

  test("a day ends at midnight UTC, the simulation's clock", () => {
    assert.equal(asOfCutoff("2026-01-05"), "2026-01-06T00:00:00.000Z");
    assert.equal(asOfCutoff("2026-01-31"), "2026-02-01T00:00:00.000Z");
    assert.equal(visibleOn("2026-01-05", "2026-01-05T23:59:59Z"), true);
    assert.equal(visibleOn("2026-01-05", "2026-01-06T00:00:00Z"), false);
    // Singapore time is how psql shows it; the instant is what counts.
    assert.equal(visibleOn("2026-01-05", "2026-01-06T07:59:00+08:00"), true);
    assert.equal(visibleOn("2026-01-05", undefined), false, "undated evidence is never visible");
  });

  test("the agent is told the day and that it cannot see past it", () => {
    const text = asOfInstruction("2026-01-06");
    assert.match(text, /Today is 2026-01-06/);
    assert.match(text, /not known yet/);
  });
});

/*
 * Against a real corpus. Set TEST_DATABASE_URL to a database with the OrgForge
 * corpus and the planner projection (build_timeline.py) loaded; skipped
 * otherwise, since the fixtures here are that corpus's own records.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe("nothing after the chosen day comes back", { skip: databaseUrl ? false : "TEST_DATABASE_URL not set" }, () => {
  let knowledge: PostgresCompanyKnowledge;
  let days: string[];

  before(async () => {
    knowledge = new PostgresCompanyKnowledge(databaseUrl!);
    days = await knowledge.workingDays();
  });
  after(async () => {
    await knowledge?.close();
  });

  function dated(day: string): CompanyKnowledge {
    const resolved = resolveAsOf(day, days);
    assert.ok(resolved.ok, `fixture day ${day} should be a working day`);
    return knowledge.asOf(resolved.day);
  }

  function assertNothingAfter(day: string, found: Evidence[], what: string) {
    const late = found.filter((item) => !visibleOn(day, item.occurredAt));
    assert.deepEqual(
      late.map((item) => `${item.sourceId} @ ${item.occurredAt ?? "undated"}`),
      [],
      `${what} on ${day} returned evidence from after it`,
    );
  }

  test("the working days are the sixty days with a department plan", () => {
    assert.equal(days.length, 60);
    assert.equal(days[0], "2026-01-01");
    assert.equal(days.at(-1), "2026-03-25");
  });

  test("search, related and sources only ever return what had happened by then", async () => {
    const queries = ["incident root cause", "TitanDB migration", "postmortem", "customer escalation",
      "ENG-112", "sprint retrospective", "budget alarm", "who owns the pacing service"];
    for (const day of ["2026-01-05", "2026-02-02", "2026-03-02"]) {
      const view = dated(day);
      for (const query of queries) {
        const found = await view.search(query, 12);
        assertNothingAfter(day, found, `search "${query}"`);
        const related = await view.related(found.map((item) => item.sourceId), 12);
        assertNothingAfter(day, related, `related to "${query}"`);
      }
      // Asking for a later record by name gets nothing, not the record.
      const late = await knowledge.search("CONF-ENG-438 ENG-263", 12);
      assert.ok(late.length > 0, "the undated view should find these by id");
      assertNothingAfter(day, await view.sources(late.map((item) => item.sourceId)), "sources");
    }
  });

  test("an incident still open on the day does not give away how it ended", async () => {
    // ENG-112 opened 2026-01-05 and was resolved 2026-01-08. On the 6th the
    // ticket, the postmortem and anything else written after are the future.
    const incident = (await knowledge.pool.query<{ resolved: string }>(
      "SELECT resolved_at::text AS resolved FROM incidents WHERE incident_key = 'ENG-112'",
    )).rows[0];
    assert.ok(incident, "fixture incident ENG-112");
    const question = "ENG-112 root cause postmortem budget alarm EKS node group cost tag";

    const unresolvedDay = "2026-01-06";
    const before = await dated(unresolvedDay).search(question, 12);
    assertNothingAfter(unresolvedDay, before, "the canary question");
    assert.ok(!before.some((item) => item.sourceId === "ENG-112"), "the ticket was written after the day");

    // The same question without a date does reach the later records — so the
    // check above is testing something.
    const everything = await knowledge.search(question, 12);
    assert.ok(
      everything.some((item) => !visibleOn(unresolvedDay, item.occurredAt)),
      "without a date, later records should be found",
    );

    // And once it is resolved, the ticket is there to cite.
    const resolvedDay = "2026-01-09";
    const afterResolution = await dated(resolvedDay).search(question, 12);
    assert.ok(afterResolution.some((item) => item.sourceId === "ENG-112"));
    assertNothingAfter(resolvedDay, afterResolution, "the canary question after resolution");
  });

  test("what is not yet filtered by date is absent, not passed through", () => {
    const view = dated("2026-02-02");
    assert.equal(view.relatedThroughEvents, undefined);
    assert.equal(view.graphQuery, undefined);
    assert.equal(view.graphExpand, undefined);
    assert.equal(view.graphView, undefined);
  });

  test("the planner reads the projection for the signed-in person and day", async () => {
    const day = (value: string) => {
      const resolved = resolveAsOf(value, days);
      assert.ok(resolved.ok);
      return resolved.day;
    };
    // A plan is the day's dept_plan_created agenda, item for item, in order.
    const plan = await knowledge.dayPlan("Jax", day("2026-01-15"));
    const raw = (await knowledge.pool.query<{ description: string }>(
      `SELECT a->>'description' AS description
       FROM source_documents d, jsonb_array_elements(d.facts->'engineer_plans') WITH ORDINALITY e(p, pi),
            jsonb_array_elements(e.p->'agenda') WITH ORDINALITY x(a, ai)
       WHERE d.source_type = 'dept_plan_created' AND e.p->>'name' = 'Jax'
         AND (d.occurred_at AT TIME ZONE 'UTC')::date = '2026-01-15'
       ORDER BY d.source_id, pi, ai`,
    )).rows.map((row) => row.description);
    assert.ok(raw.length > 0);
    assert.deepEqual(plan.map((entry) => entry.title), raw);

    // ENG-107: in progress with Taylor on the 2nd, in review from the 5th.
    const second = await knowledge.todo("Taylor", day("2026-01-02"));
    assert.equal(second.find((item) => item.itemKey === "ENG-107")?.status, "In Progress");
    const seventh = await knowledge.todo("Taylor", day("2026-01-07"));
    assert.equal(seventh.find((item) => item.itemKey === "ENG-107")?.status, "In Review");
    // Chloe raised it; it was never on her list, because Taylor had it by then.
    assert.ok(!(await knowledge.todo("Chloe", day("2026-01-07"))).some((item) => item.itemKey === "ENG-107"));

    // ORG-105 went from Morgan to Jax on 2026-02-17.
    const before = await knowledge.todo("Jax", day("2026-02-16"));
    const afterward = await knowledge.todo("Jax", day("2026-02-17"));
    assert.ok(!before.some((item) => item.itemKey === "ORG-105"));
    assert.equal(afterward.find((item) => item.itemKey === "ORG-105")?.relation, "assignee");

    // The dated view cannot be asked about a later day.
    const dated = knowledge.asOf(day("2026-01-02"));
    const later = await dated.todo!("Taylor", day("2026-01-07"));
    assert.equal(later.find((item) => item.itemKey === "ENG-107")?.status, "In Progress");
  });

  test("without a date nothing changes", async () => {
    const undated = await knowledge.sources(["DD-ENG-112", "ENG-112"]);
    assert.deepEqual(undated.map((item) => item.sourceId).sort(), ["DD-ENG-112", "ENG-112"]);
  });
});

// Keeps the AsOf brand honest: a plain string is not one until resolved.
// @ts-expect-error a bare string is not an AsOf
const _unchecked: AsOf = "2026-01-05";
void _unchecked;
