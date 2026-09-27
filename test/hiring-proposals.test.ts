import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DomainHealth } from "../src/domain-health.js";
import { proposalsThrough, reasonsOn, suggestRole } from "../src/hiring-proposals.js";

function health(domain: string, extra: Partial<DomainHealth> = {}): DomainHealth {
  return {
    domain, name: domain, department: "Engineering_Backend", owner: "Owner", ownerSince: null,
    ownerActive: true, ownerLeftOn: null, ownerLoad: 1, activeContributors30d: ["A", "B", "C", "D", "E", "F", "G", "H"],
    incidents30d: [], pages30d: 10, evidence: { contributors: [`CONF-${domain}`], incidents: [] }, ...extra,
  };
}

/** Consecutive days from 2026-01-01, the record's first. */
const days = (count: number) => Array.from({ length: count }, (_, index) =>
  new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10));

describe("hiring proposal rules", () => {
  test("an owner gone for one day is noise; two days is a proposal", async () => {
    const gone = health("titandb", { owner: "Bill", ownerActive: false, ownerLeftOn: "2024-06-01" });
    const oneDay = await proposalsThrough(days(3), async (day) => [day === "2026-01-01" ? gone : health("titandb")]);
    assert.deepEqual(oneDay, []);
    const twoDays = await proposalsThrough(days(4), async (day) => [day <= "2026-01-02" ? gone : health("titandb")]);
    assert.equal(twoDays.length, 1);
    assert.equal(twoDays[0]!.id, "titandb@2026-01-02");
    assert.equal(twoDays[0]!.closedOn, "2026-01-03");
    assert.match(twoDays[0]!.reasons[0]!.text, /Bill, who owned titandb, left on 2024-06-01/);
  });

  test("thin needs a full 30-day window, then compares with the median domain", async () => {
    const quiet = health("terraform-infra", { activeContributors30d: ["Priya"] });
    const others = ["a", "b", "c", "d"].map((name) => health(name));
    const found = await proposalsThrough(days(31), async () => [quiet, ...others]);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.openedOn, "2026-01-30", "the first day with a full window");
    assert.deepEqual(found[0]!.rulesSeen, ["thin"]);
    assert.match(found[0]!.reasons[0]!.text, /Only 1 person .* against 8 for the typical domain/);
  });

  test("overloaded: an owner of three or more domains, with two or more incidents here", () => {
    const busy = health("titandb", { owner: "Janice", ownerLoad: 3, incidents30d: ["ENG-137", "ENG-165"] });
    const context = { orphanedDays: 0, medianContributors: 8, fullWindow: true };
    assert.deepEqual(reasonsOn(busy, context).map((reason) => reason.rule), ["overloaded"]);
    assert.deepEqual(reasonsOn({ ...busy, incidents30d: ["ENG-137"] }, context), []);
    assert.deepEqual(reasonsOn({ ...busy, ownerLoad: 2 }, context), []);
  });

  test("only the days passed in are read, so a later day cannot shape an earlier proposal", async () => {
    const read: string[] = [];
    await proposalsThrough(days(5), async (day) => { read.push(day); return [health("x")]; });
    assert.deepEqual(read, days(5));
  });

  test("the suggested role is written from the domain and its reasons, the same every time", () => {
    const row = health("kubernetes-deploy", { owner: "Morgan", ownerActive: false, ownerLeftOn: "2026-02-17",
      activeContributors30d: ["Sanjay", "Priya"] });
    const reasons = reasonsOn(row, { orphanedDays: 2, medianContributors: 20, fullWindow: true });
    const role = suggestRole(row, reasons);
    assert.equal(role.title, "Backend engineer to own kubernetes-deploy");
    assert.match(role.description, /Morgan, who owned kubernetes-deploy, left on 2026-02-17/);
    assert.match(role.description, /working with Sanjay and Priya/);
    assert.deepEqual(suggestRole(row, reasons), role);
  });
});
