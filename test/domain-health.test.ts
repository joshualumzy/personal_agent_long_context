import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createSessionToken } from "../src/auth.js";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";
import { assembleHealth, type DomainHealth } from "../src/domain-health.js";
import type { CompanyKnowledge } from "../src/company-domain.js";

describe("assembling a day's domain health", () => {
  const base = {
    domains: [
      { key: "kubernetes-deploy", name: "kubernetes-deploy", department: "Engineering_Backend" },
      { key: "terraform-infra", name: "terraform-infra", department: "Engineering_Backend" },
      { key: "titandb", name: "TitanDB", department: "Engineering_Backend" },
    ],
    owners: [
      { domain: "kubernetes-deploy", owner: "Morgan", since: null },
      { domain: "terraform-infra", owner: "Priya", since: "2026-02-17" },
      { domain: "titandb", owner: "Priya", since: "2026-01-09" },
    ],
    employed: new Set(["Priya", "Sanjay", "Jax"]),
    work: [
      { domain: "kubernetes-deploy", person: "Sanjay", sourceId: "CONF-1", kind: "page" as const },
      { domain: "kubernetes-deploy", person: "Morgan", sourceId: "CONF-2", kind: "page" as const },
      { domain: "kubernetes-deploy", person: "Sanjay", sourceId: "ENG-173", kind: "incident" as const },
      { domain: "titandb", person: "Jax", sourceId: "ENG-9", kind: "ticket" as const },
    ],
    incidents: [{ domain: "kubernetes-deploy", key: "ENG-173" }],
  };
  const byDomain = (rows: DomainHealth[]) => Object.fromEntries(rows.map((row) => [row.domain, row]));

  test("an owner who has left leaves the domain orphaned", () => {
    const rows = byDomain(assembleHealth(base));
    assert.equal(rows["kubernetes-deploy"]!.owner, "Morgan");
    assert.equal(rows["kubernetes-deploy"]!.ownerActive, false);
    assert.equal(rows["terraform-infra"]!.ownerActive, true);
  });

  test("load counts the domains an owner holds that day", () => {
    const rows = byDomain(assembleHealth(base));
    assert.equal(rows["terraform-infra"]!.ownerLoad, 2);
    assert.equal(rows["kubernetes-deploy"]!.ownerLoad, 1);
  });

  test("only people still employed count as contributors, and their work is the evidence", () => {
    const k8s = byDomain(assembleHealth(base))["kubernetes-deploy"]!;
    assert.deepEqual(k8s.activeContributors30d, ["Sanjay"]);
    assert.deepEqual(k8s.evidence.contributors, ["CONF-1", "ENG-173"]);
    assert.equal(k8s.pages30d, 2, "pages count whoever wrote them");
    assert.deepEqual(k8s.incidents30d, ["ENG-173"]);
  });

  test("a domain with nothing recorded is still listed, with nobody on it", () => {
    const bare = byDomain(assembleHealth({ ...base, owners: [], work: [], incidents: [] }));
    assert.equal(bare["titandb"]!.owner, null);
    assert.equal(bare["titandb"]!.ownerActive, false);
    assert.equal(bare["titandb"]!.ownerLoad, 0);
    assert.deepEqual(bare["titandb"]!.activeContributors30d, []);
  });
});

describe("the domain health route", () => {
  const SECRET = "domain-health-test-secret-at-least-32-chars";
  const apps: Array<{ close(): Promise<void> }> = [];
  after(async () => { for (const app of apps) await app.close(); });
  const knowledge = (asked: string[]): CompanyKnowledge => ({
    async employee(id) { return { employeeId: id, displayName: id, currentAssignments: [] }; },
    async search() { return []; }, async related() { return []; }, async sources() { return []; },
    async workingDays() { return ["2026-02-16", "2026-02-17"]; },
    asOf() { return this; },
    async domainHealth(day) {
      asked.push(day);
      return [{ domain: "kubernetes-deploy", name: "kubernetes-deploy", department: null, owner: "Morgan", ownerSince: null,
        ownerActive: false, ownerLoad: 1, activeContributors30d: [], incidents30d: [], pages30d: 0,
        evidence: { contributors: [], incidents: [] } }];
    },
  });

  test("any signed-in employee can read it, for the day asked", async () => {
    const asked: string[] = [];
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyKnowledge: knowledge(asked), sessionConfig: { secret: SECRET } });
    apps.push(app);
    const headers = { authorization: `Bearer ${createSessionToken("jax", SECRET)}` };
    const response = await app.inject({ url: "/api/v1/gaps/health?asOf=2026-02-17", headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().asOf, "2026-02-17");
    assert.equal(response.json().domains[0].ownerActive, false);
    assert.deepEqual(asked, ["2026-02-17"]);
    assert.equal((await app.inject({ url: "/api/v1/gaps/health" })).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/v1/gaps/health?asOf=2027-01-01", headers })).statusCode, 400);
  });

  test("without it configured the route says so", async () => {
    const app = buildApp({ memory: new DeterministicMemoryProvider(), sessionConfig: { secret: SECRET },
      companyKnowledge: { async employee(id) { return { employeeId: id, displayName: id, currentAssignments: [] }; },
        async search() { return []; }, async related() { return []; }, async sources() { return []; } } });
    apps.push(app);
    const headers = { authorization: `Bearer ${createSessionToken("jax", SECRET)}` };
    assert.equal((await app.inject({ url: "/api/v1/gaps/health", headers })).statusCode, 503);
  });
});
