/**
 * Held-out acceptance tests for the recruiting direction (S3).
 *
 * Written from docs/s3-recruiting.md, the README section "Recruiting direction
 * (S3)", skills/recruiting/SKILL.md, and the commit that introduced the chat
 * skill. Each test checks a promise the product makes, through public entry
 * points: the role board and its services, the chat tools, the chat agent,
 * and the HTTP routes.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { recruitingExtension } from "../../src/recruiting/chat-tools.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import { JsonRoleRepository, RoleBoard } from "../../src/recruiting/roles.js";
import { RecruitingService } from "../../src/recruiting/service.js";
import { SoCLaaSCompanyAgent } from "../../src/soclaas-company-agent.js";
import { loadSkills } from "../../src/skills.js";
import {
  ALPHA,
  FakeSource,
  REQUIREMENT,
  appFor,
  candidateOf,
  confirmedRole,
  fakeGmail,
  fakeModel,
  finder,
  idle,
  jsonWorld,
  knowledge,
  openRole,
  person,
  tiersOf,
  world,
} from "./fakes.js";

const PROTECTED_PHRASES: Array<[string, string]> = [
  ["under 30", "age"],
  ["female", "sex"],
  ["ethnic Chinese", "race"],
  ["Christian", "religion"],
  ["no kids", "family status"],
  ["no disability", "disability"],
  ["Singapore citizen", "nationality"],
];

function activeTexts(snapshot: { criteria: Array<{ text: string }> }) {
  return snapshot.criteria.map((criterion) => criterion.text);
}

// ---------------------------------------------------------------- criteria

describe("criteria", () => {
  test("a requirement becomes 3 to 6 criteria, each must or nice", async () => {
    const model = fakeModel({
      "criteria extraction": () => ({
        title: "Backend engineer",
        criteria: [
          { text: "typescript", kind: "must" },
          { text: "startup", kind: "must" },
          { text: "singapore", kind: "required" },
          { text: "rust", kind: "nice" },
          { text: "postgres", kind: "nice" },
          { text: "kubernetes", kind: "nice" },
          { text: "graphql", kind: "nice" },
          { text: "aws", kind: "optional" },
        ],
        excluded: [],
        queries: ["alpha q", "beta q", "gamma q"],
      }),
    });
    const { board } = world({ model });
    const { service } = await openRole(board);
    const snapshot = await service.snapshot();
    assert.ok(snapshot.criteria.length >= 3 && snapshot.criteria.length <= 6, `got ${snapshot.criteria.length}`);
    for (const criterion of snapshot.criteria) assert.ok(["must", "nice"].includes(criterion.kind));
    assert.equal(snapshot.role?.confirmed, false, "the founder confirms before anything is searched");
  });

  test("criteria on each protected characteristic are refused and reported, never kept", async () => {
    const leaked: string[] = [];
    for (const [phrase, characteristic] of PROTECTED_PHRASES) {
      const model = fakeModel({
        "criteria extraction": () => ({
          title: "Backend engineer",
          criteria: [
            { text: "typescript", kind: "must" },
            { text: "startup", kind: "must" },
            { text: "rust", kind: "nice" },
            { text: phrase, kind: "must" },
          ],
          excluded: [],
          queries: ["alpha q"],
        }),
      });
      const { board } = world({ model });
      const { service, result } = await openRole(board, `${REQUIREMENT} Ideally ${phrase}.`);
      const texts = activeTexts(await service.snapshot());
      if (texts.includes(phrase) || !(result.refused ?? []).some((entry) => entry.text === phrase)) {
        leaked.push(`${characteristic} ("${phrase}")`);
      }
    }
    assert.deepEqual(leaked, [], `not refused: ${leaked.join(", ")}`);
  });

  test("a Chinese age wish (30岁以下) is refused and the rest stays", async () => {
    const model = fakeModel({
      "criteria extraction": () => ({
        title: "后端工程师",
        criteria: [
          { text: "typescript", kind: "must" },
          { text: "startup", kind: "must" },
          { text: "最好30岁以下", kind: "nice" },
        ],
        excluded: [],
        queries: ["alpha q"],
      }),
    });
    const { board } = world({ model });
    const { service, result } = await openRole(board, "招一个新加坡的后端工程师，会 TypeScript，最好30岁以下");
    assert.deepEqual(activeTexts(await service.snapshot()), ["typescript", "startup"]);
    assert.ok(result.refused?.length, "the founder is told what was refused");
  });

  test("revising the draft to add a protected criterion is refused and the draft stays", async () => {
    const { board } = world();
    const { service } = await openRole(board);
    const before = (await service.snapshot()).criteria;
    await assert.rejects(
      service.reviseDraft([...before.map(({ id, text, kind }) => ({ id, text, kind })), { text: "men only", kind: "must" }]),
    );
    assert.deepEqual((await service.snapshot()).criteria, before);
  });

  test("a later spoken change cannot add or edit a criterion into a protected one", async () => {
    let turn = 0;
    const model = fakeModel({
      "instruction interpretation": (data) => {
        turn += 1;
        const rust = data.criteria.find((criterion: { text: string }) => criterion.text === "rust");
        return turn === 1
          ? { intent: "criteria", operations: [{ op: "add", text: "under 35", kind: "must" }], summary: "" }
          : { intent: "criteria", operations: [{ op: "edit", id: rust.id, text: "married" }], summary: "" };
      },
    });
    const { board } = world({ model });
    const { service } = await confirmedRole(board);
    const added = await service.say("Also they should be under 35.");
    assert.ok(added.refused?.length);
    const edited = await service.say("Change rust to married.");
    assert.ok(edited.refused?.length);
    await idle(service);
    const texts = activeTexts(await service.snapshot());
    assert.ok(!texts.includes("under 35") && !texts.includes("married"), texts.join(", "));
    assert.ok(texts.includes("rust"));
  });

  test("a learned preference on a protected characteristic is never proposed", async () => {
    const model = fakeModel({
      "preference pattern": (data) => ({
        found: true,
        text: "women only",
        kind: "must",
        rationale: "Both were men.",
        supportingCandidateIds: data.decisions.map((entry: { candidateId: string }) => entry.candidateId),
      }),
    });
    const { board } = world({ model });
    const { service } = await confirmedRole(board);
    await service.feedback("outer", "pass", "not a fit");
    await service.feedback("unsure", "pass", "not a fit");
    await idle(service);
    const snapshot = await service.snapshot();
    assert.equal(snapshot.proposals.filter((proposal) => proposal.type === "criterion").length, 0);
    assert.ok(!activeTexts(snapshot).includes("women only"));
  });

  test("an accepted widening step cannot turn a criterion into a protected one", async () => {
    const model = fakeModel({
      "pool expansion": (data) => {
        const location = data.criteria.find((criterion: { text: string }) => criterion.text === "singapore");
        return {
          query: "remote typescript engineer",
          operations: [{ op: "edit", id: location.id, text: "Singaporeans only or under 30" }],
          rationale: "Widen.",
        };
      },
    });
    const { board } = world({ model });
    const { service } = await confirmedRole(board);
    await service.fastForward(7);
    const proposal = (await service.snapshot()).proposals.find((entry) => entry.type === "expansion");
    assert.ok(proposal, "a quiet week produces a proposal");
    await service.resolveProposal(proposal.id, true);
    await idle(service);
    const texts = activeTexts(await service.snapshot());
    assert.ok(!texts.some((text) => /singaporeans only|under 30/i.test(text)), texts.join(", "));
  });
});

// ------------------------------------------------------------------- tiers

describe("tiers", () => {
  test("all met is the centre, only nice missing is the middle, one must missing or unclear is the outer ring, more is out", async () => {
    const { board } = world();
    const { service } = await confirmedRole(board);
    assert.deepEqual(await tiersOf(service), { centre: 100, middle: 75, outer: 50, unsure: 50, gone: "out" });
  });

  test("people missing two or more musts are not offered as part of the pool", async () => {
    const { board } = world();
    const { roleId, service } = await confirmedRole(board);
    const [summary] = await board.list();
    assert.equal(summary!.candidates, 4, "the role counts only people in a ring");
    assert.equal(summary!.strong, 1);
    const status = JSON.parse((await recruitingExtension(board).run("recruiting_status", { role_id: roleId })).content).status;
    assert.ok(!status.candidates.some((candidate: { id: string }) => candidate.id === "gone"));
    assert.equal((await candidateOf(service, "gone")).tier, "out");
  });

  test("a criteria change rescores the pool at once", async () => {
    const model = fakeModel({
      "instruction interpretation": (data) => {
        const rust = data.criteria.find((criterion: { text: string }) => criterion.text === "rust");
        return { intent: "criteria", operations: [{ op: "set_kind", id: rust.id, kind: "must" }], summary: "" };
      },
    });
    const { board } = world({ model });
    const { service } = await confirmedRole(board);
    await service.say("Rust is required after all.");
    await idle(service);
    const tiers = await tiersOf(service);
    assert.equal(tiers.middle, 50, "missing Rust is now a missed must");
    assert.equal(tiers.centre, 100);
  });
});

// ------------------------------------------------------------ several roles

describe("several roles", () => {
  test("confirming one role leaves another untouched", async () => {
    const { board } = world();
    const first = await openRole(board);
    const second = await openRole(board, "A product designer in Jakarta who has shipped a mobile app.");
    const secondBefore = await second.service.snapshot();
    await first.service.confirm();
    await idle(first.service);
    const secondAfter = await second.service.snapshot();
    assert.equal(secondAfter.role?.confirmed, false);
    assert.deepEqual(secondAfter.criteria, secondBefore.criteria);
    assert.equal(secondAfter.candidates.length, 0);
    assert.notEqual(first.roleId, second.roleId);
  });

  test("changing criteria in one role leaves another's criteria and candidates as they were", async () => {
    const model = fakeModel({
      "instruction interpretation": () => ({ intent: "criteria", operations: [{ op: "add", text: "postgres", kind: "must" }], summary: "" }),
    });
    const { board } = world({ model });
    const first = await confirmedRole(board);
    const second = await confirmedRole(board);
    const before = await second.service.snapshot();
    await first.service.say("They must know Postgres.");
    await idle(first.service);
    await idle(second.service);
    const after = await second.service.snapshot();
    assert.ok(activeTexts(await first.service.snapshot()).includes("postgres"));
    assert.deepEqual(after.criteria, before.criteria);
    assert.deepEqual(
      after.candidates.map((candidate) => [candidate.id, candidate.tier, candidate.stage]),
      before.candidates.map((candidate) => [candidate.id, candidate.tier, candidate.stage]),
    );
  });

  test("a deleted role cannot be read or written, and the other role survives", async () => {
    const { board } = world();
    const doomed = await confirmedRole(board);
    const kept = await confirmedRole(board);
    const app = appFor(board);
    const removed = await app.inject({ method: "DELETE", url: `/api/recruiting/roles/${doomed.roleId}` });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual((await board.list()).map((role) => role.id), [kept.roleId]);
    await assert.rejects(board.get(doomed.roleId));
    for (const [method, url, payload] of [
      ["GET", `/api/recruiting/roles/${doomed.roleId}/state`, undefined],
      ["POST", `/api/recruiting/roles/${doomed.roleId}/say`, { text: "Rust is required." }],
      ["POST", `/api/recruiting/roles/${doomed.roleId}/more`, {}],
      ["POST", `/api/recruiting/roles/${doomed.roleId}/fast-forward`, { days: 7 }],
    ] as const) {
      const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      assert.equal(response.statusCode, 404, `${method} ${url}`);
    }
    const tool = await recruitingExtension(board).run("recruiting_find_more", { role_id: doomed.roleId });
    assert.match(tool.content, /error/i);
    assert.deepEqual((await board.list()).map((role) => role.id), [kept.roleId], "nothing brought it back");
    assert.equal((await kept.service.snapshot()).role?.confirmed, true);
  });

  test("each role is stored separately and comes back from its own file", async () => {
    const { roles, board, model, source } = await jsonWorld();
    const first = await confirmedRole(board);
    const second = await openRole(board, "A product designer in Jakarta who has shipped a mobile app.");
    const files = (await readdir(roles)).filter((name) => name.endsWith(".json")).sort();
    assert.deepEqual(files, [`${first.roleId}.json`, `${second.roleId}.json`].sort());

    const reopened = new RoleBoard(
      new JsonRoleRepository(roles),
      (store) => new RecruitingService({ model, source, store, memory: new LocalIntentMemory(), contactFinders: [], gmail: null }),
    );
    assert.equal((await (await reopened.get(first.roleId)).snapshot()).role?.confirmed, true);
    assert.equal((await (await reopened.get(second.roleId)).snapshot()).role?.confirmed, false);

    await reopened.remove(second.roleId);
    assert.deepEqual((await readdir(roles)).filter((name) => name.endsWith(".json")), [`${first.roleId}.json`]);
  });

  test("role ids cannot reach outside the storage folder", async () => {
    const { directory, roles, board } = await jsonWorld();
    await confirmedRole(board);
    const outside = join(directory, "secret.json");
    await writeFile(outside, JSON.stringify({ version: 1, role: { title: "x", requirement: "x", confirmed: true, createdAt: "" } }));
    const repository = new JsonRoleRepository(roles);
    for (const id of ["../secret", "..", "a/b", "../../etc/passwd", "ABC", ""]) {
      assert.throws(() => repository.store(id), `store(${JSON.stringify(id)})`);
      await assert.rejects(repository.remove(id), `remove(${JSON.stringify(id)})`);
    }
    const app = appFor(board);
    for (const id of ["..%2Fsecret", "..%2F..%2Fsecret", "%2E%2E", "..%5Csecret"]) {
      const read = await app.inject({ method: "GET", url: `/api/recruiting/roles/${id}/state` });
      assert.ok(read.statusCode >= 400 && read.statusCode < 500, `GET ${id}: ${read.statusCode}`);
      const removed = await app.inject({ method: "DELETE", url: `/api/recruiting/roles/${id}` });
      assert.ok(removed.statusCode >= 400 && removed.statusCode < 500, `DELETE ${id}: ${removed.statusCode}`);
      const written = await app.inject({ method: "POST", url: `/api/recruiting/roles/${id}/confirm`, payload: {} });
      assert.ok(written.statusCode >= 400 && written.statusCode < 500, `POST ${id}: ${written.statusCode}`);
    }
    assert.ok(existsSync(outside), "a file outside the folder is never removed");
  });
});

// --------------------------------------------------- nothing sent by itself

describe("nothing leaves without the founder", () => {
  test("no chat tool and no route except send sends anything", async () => {
    const gmail = fakeGmail();
    const model = fakeModel({
      "instruction interpretation": () => ({ intent: "feedback", candidateId: "centre", decision: "keep", reason: "", summary: "" }),
    });
    const { board } = world({
      model,
      gmail: gmail.client,
      finders: [finder("hunter", (profile) => `${profile.id}@company.example`)],
    });
    const { roleId, service } = await confirmedRole(board);
    const app = appFor(board, gmail.client);
    const base = `/api/recruiting/roles/${roleId}`;
    const calls: Array<[string, string, object?]> = [
      ["POST", "/api/recruiting/roles", { text: "A product designer in Jakarta who has shipped a mobile app." }],
      ["POST", `${base}/say`, { text: "Keep Centre." }],
      ["POST", `${base}/more`, {}],
      ["POST", `${base}/candidates/import`, { urls: ["https://www.linkedin.com/in/someone-new"] }],
      ["POST", `${base}/candidates/centre/outreach`, {}],
      ["POST", `${base}/candidates/centre/draft`, { body: "Hi Centre, up for a call?" }],
      ["POST", `${base}/candidates/middle/outreach`, {}],
      ["POST", `${base}/candidates/gone/feedback`, { decision: "pass", reason: "wrong stack" }],
      ["POST", `${base}/candidates/outer/reply`, { text: "Sounds interesting, tell me more." }],
      ["POST", `${base}/candidates/unsure/close`, { reason: "withdrawn" }],
      ["POST", `${base}/fast-forward`, { days: 10 }],
      ["POST", "/api/recruiting/inbox/linkedin", { threads: [{ text: "Centre Tan: happy to chat" }] }],
      ["POST", "/api/recruiting/inbox/gmail", {}],
      ["POST", `${base}/ask`, { question: "Why do we need Rust?" }],
      ["GET", `${base}/state`],
    ];
    for (const [method, url, payload] of calls) {
      const response = await app.inject({ method: method as "GET" | "POST", url, ...(payload ? { payload } : {}) });
      assert.ok(response.statusCode < 500, `${method} ${url}: ${response.statusCode} ${response.body}`);
    }
    const tools = recruitingExtension(board);
    const toolCalls: Array<[string, Record<string, unknown>]> = [
      ["recruiting_status", {}],
      ["recruiting_status", { role_id: roleId }],
      ["recruiting_update", { role_id: roleId, text: "Keep Centre." }],
      ["recruiting_find_more", { role_id: roleId }],
      ["recruiting_import_profiles", { role_id: roleId, urls: ["https://www.linkedin.com/in/another-one"] }],
      ["recruiting_prepare_outreach", { role_id: roleId, candidate_id: "middle" }],
      ["recruiting_prepare_outreach", { role_id: roleId, candidate_id: "centre" }],
      ["show_recruiting_panel", { role_id: roleId, view: "candidate", candidate_id: "centre" }],
      ["recruiting_start", { requirement: "A data engineer in Singapore who knows Spark." }],
    ];
    for (const [name, args] of toolCalls) await tools.run(name, args);
    for (const { service: each } of await board.all()) await idle(each);
    await idle(service);

    assert.equal(gmail.sent.length, 0, "nothing reached Gmail");
    for (const { service: each } of await board.all()) {
      for (const candidate of (await each.snapshot()).candidates) {
        assert.ok(!candidate.messages.some((message) => message.direction === "outbound"), `${candidate.id} was contacted`);
      }
    }

    const sent = await app.inject({ method: "POST", url: `${base}/candidates/centre/send`, payload: {} });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.equal(gmail.sent.length, 1, "the founder's press sends exactly one message");
    assert.equal(gmail.sent[0]!.to, "centre@company.example");
  });

  test("send fails when there is no draft", async () => {
    const gmail = fakeGmail();
    const { board } = world({ gmail: gmail.client, finders: [finder("hunter", () => "x@company.example")] });
    const { roleId, service } = await confirmedRole(board);
    const app = appFor(board, gmail.client);
    for (const manual of [false, true]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/recruiting/roles/${roleId}/candidates/centre/send`,
        payload: { manual },
      });
      assert.ok(response.statusCode >= 400 && response.statusCode < 500, `${response.statusCode}`);
    }
    assert.equal(gmail.sent.length, 0);
    assert.equal((await candidateOf(service, "centre")).messages.length, 0);
  });

  test("a draft that repeats a private pass reason cannot be sent until it is edited out", async () => {
    const reason = "too corporate, only enterprise consulting work";
    const model = fakeModel({
      "outreach draft": () => ({ subject: "Hello", body: `Hi, unlike people with only enterprise consulting work who feel too corporate, you shipped things. Call?` }),
    });
    const gmail = fakeGmail();
    const { board } = world({ model, gmail: gmail.client, finders: [finder("hunter", () => "centre@company.example")] });
    const { roleId, service } = await confirmedRole(board);
    await service.feedback("gone", "pass", reason);
    await service.prepareOutreach("centre");
    assert.ok((await candidateOf(service, "centre")).draft, "a draft exists");

    const app = appFor(board, gmail.client);
    const url = `/api/recruiting/roles/${roleId}/candidates/centre`;
    for (const manual of [false, true]) {
      const blocked = await app.inject({ method: "POST", url: `${url}/send`, payload: { manual } });
      assert.ok(blocked.statusCode >= 400 && blocked.statusCode < 500, `manual=${manual}: ${blocked.statusCode}`);
    }
    assert.equal(gmail.sent.length, 0);

    await app.inject({ method: "POST", url: `${url}/draft`, payload: { body: "Hi Centre, saw your backend work. Up for a quick call?" } });
    const ok = await app.inject({ method: "POST", url: `${url}/send`, payload: {} });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(gmail.sent.length, 1);
    assert.ok(!gmail.sent[0]!.body.includes("consulting"));

    // Editing the reason back into a new draft blocks it again.
    await service.prepareOutreach("middle");
    await app.inject({
      method: "POST",
      url: `/api/recruiting/roles/${roleId}/candidates/middle/draft`,
      payload: { body: `Hi, you are not ${reason}. Call?` },
    });
    const again = await app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/candidates/middle/send`, payload: {} });
    assert.ok(again.statusCode >= 400 && again.statusCode < 500);
    assert.equal(gmail.sent.length, 1);
  });

  test("no email is guessed: without a finder result the contact stays empty", async () => {
    const hunter = finder("hunter", () => null);
    const prospeo = finder("prospeo", () => null);
    const gmail = fakeGmail();
    const { board } = world({ gmail: gmail.client, finders: [hunter, prospeo] });
    const { roleId, service } = await confirmedRole(board);
    const tools = recruitingExtension(board);
    const prepared = JSON.parse((await tools.run("recruiting_prepare_outreach", { role_id: roleId, candidate_id: "centre" })).content);
    const candidate = await candidateOf(service, "centre");
    assert.ok(candidate.draft, "a draft is still written, for LinkedIn");
    assert.equal(candidate.contact, null);
    assert.ok(!JSON.stringify(prepared).includes("@"), "the model is given no address");
    assert.ok(!JSON.stringify(candidate.draft).match(/[\w.]+@[\w.]+\.\w+/), "the draft carries no address");
    const status = JSON.parse((await tools.run("recruiting_status", { role_id: roleId })).content).status;
    assert.equal(status.candidates.find((entry: { id: string }) => entry.id === "centre").email, "none");

    const app = appFor(board, gmail.client);
    const response = await app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/candidates/centre/send`, payload: {} });
    assert.ok(response.statusCode >= 400 && response.statusCode < 500);
    assert.equal(gmail.sent.length, 0);
  });

  test("Hunter is tried first, Prospeo next, and only for the person chosen", async () => {
    const hunter = finder("hunter", () => null);
    const prospeo = finder("prospeo", (profile) => `${profile.id}@found.example`);
    const { board } = world({ finders: [hunter, prospeo] });
    const { service } = await confirmedRole(board);
    assert.equal(hunter.seen.length + prospeo.seen.length, 0, "nobody is looked up before the founder chooses");
    await service.prepareOutreach("middle");
    assert.deepEqual(hunter.seen, ["middle"]);
    assert.deepEqual(prospeo.seen, ["middle"]);
    const contact = (await candidateOf(service, "middle")).contact;
    assert.equal(contact?.provider, "prospeo");
    assert.equal(contact?.email, "middle@found.example");

    const firstHit = finder("hunter", () => "a@hunter.example");
    const never = finder("prospeo", () => "b@prospeo.example");
    const other = world({ finders: [firstHit, never] });
    const role = await confirmedRole(other.board);
    await role.service.prepareOutreach("centre");
    assert.equal(never.seen.length, 0);
    assert.equal((await candidateOf(role.service, "centre")).contact?.provider, "hunter");
  });
});

// --------------------------------------------------------------- follow-up

describe("follow-up", () => {
  async function contacted() {
    const context = world();
    const role = await confirmedRole(context.board);
    await role.service.prepareOutreach("centre");
    await role.service.send("centre", true);
    return { ...context, ...role };
  }

  test("five quiet days after contact produce a follow-up draft, four do not, and nothing is sent", async () => {
    const { service } = await contacted();
    await service.fastForward(4);
    assert.equal((await candidateOf(service, "centre")).draft, null);
    await service.fastForward(1);
    const candidate = await candidateOf(service, "centre");
    assert.equal(candidate.draft?.kind, "follow_up");
    assert.equal(candidate.messages.filter((message) => message.direction === "outbound").length, 1);
    assert.equal(candidate.stage, "contacted");
  });

  test("seven more quiet days after the follow-up close the candidate as cold, and they leave the pool", async () => {
    const { board, roleId, service } = await contacted();
    await service.fastForward(5);
    assert.equal((await candidateOf(service, "centre")).draft?.kind, "follow_up");
    await service.send("centre", true);
    await service.fastForward(6);
    assert.notEqual((await candidateOf(service, "centre")).stage, "closed", "six days is not yet cold");
    await service.fastForward(1);
    const candidate = await candidateOf(service, "centre");
    assert.equal(candidate.stage, "closed");
    assert.equal(candidate.closedReason, "cold");
    assert.ok(!("centre" in (await tiersOf(service))));
    const [summary] = await board.list();
    assert.equal(summary!.strong, 0, "the role no longer counts them");
    const status = JSON.parse((await recruitingExtension(board).run("recruiting_status", { role_id: roleId })).content).status;
    assert.ok(!status.candidates.some((entry: { id: string }) => entry.id === "centre"));
  });

  test("a reply before five days means no follow-up is drafted", async () => {
    const { service } = await contacted();
    await service.fastForward(2);
    await service.reply("Happy to talk next week.", "centre", "pasted");
    await service.fastForward(10);
    const candidate = await candidateOf(service, "centre");
    assert.notEqual(candidate.draft?.kind, "follow_up");
    assert.notEqual(candidate.stage, "closed");
    assert.equal(candidate.followUps, 0);
  });

  test("closed candidates are erased after 30 days", async () => {
    const { board } = world();
    const { service } = await confirmedRole(board);
    await service.feedback("gone", "pass", "wrong stack");
    await service.fastForward(29);
    assert.ok((await service.snapshot()).candidates.some((candidate) => candidate.id === "gone"));
    await service.fastForward(2);
    assert.ok(!(await service.snapshot()).candidates.some((candidate) => candidate.id === "gone"));
  });
});

// --------------------------------------------------------------- expansion

describe("widening the search", () => {
  function expansions(snapshot: { proposals: Array<{ type: string }> }) {
    return snapshot.proposals.filter((proposal) => proposal.type === "expansion") as unknown as Array<{
      id: string;
      stepName: string;
      rationale: string;
    }>;
  }

  test("a quiet week proposes widening the location first; six days do not", async () => {
    const { board } = world();
    const { service } = await confirmedRole(board);
    await service.fastForward(6);
    assert.equal(expansions(await service.snapshot()).length, 0);
    await service.fastForward(1);
    const [proposal] = expansions(await service.snapshot());
    assert.ok(proposal);
    assert.match(proposal.stepName, /location/i);
  });

  test("nothing changes until the founder accepts; accepting relaxes the criterion and adds people", async () => {
    const { board, source } = world();
    const { service } = await confirmedRole(board);
    const before = await service.snapshot();
    const searchesBefore = source.queries.length;
    await service.fastForward(7);
    const pending = await service.snapshot();
    assert.deepEqual(pending.criteria, before.criteria);
    assert.deepEqual(pending.candidates.map((candidate) => candidate.id).sort(), before.candidates.map((candidate) => candidate.id).sort());
    assert.equal(source.queries.length, searchesBefore, "no search runs on a proposal alone");

    const [proposal] = expansions(pending);
    await service.resolveProposal(proposal!.id, true);
    await idle(service);
    const after = await service.snapshot();
    assert.equal(after.criteria.find((criterion) => criterion.text === "singapore")?.kind, "nice");
    assert.ok(after.candidates.some((candidate) => candidate.id === "remote1"), "new people join");
    assert.equal(expansions(after).length, 0);
  });

  test("declining keeps the criteria and moves to the next rung next time: background filters, then demote a must", async () => {
    const { board } = world();
    const { service } = await confirmedRole(board);
    const criteria = (await service.snapshot()).criteria;
    const names: string[] = [];
    for (let rung = 0; rung < 3; rung += 1) {
      await service.fastForward(7);
      const [proposal] = expansions(await service.snapshot());
      assert.ok(proposal, `rung ${rung + 1} is proposed`);
      names.push(proposal.stepName);
      await service.resolveProposal(proposal.id, false);
      assert.deepEqual((await service.snapshot()).criteria, criteria, "declining changes nothing");
    }
    assert.match(names[0]!, /location/i);
    assert.match(names[1]!, /background/i);
    assert.match(names[2]!, /demote|must/i);
  });

  test("a reply from a strong candidate means no widening is proposed", async () => {
    const { board } = world();
    const { service } = await confirmedRole(board);
    await service.prepareOutreach("centre");
    await service.send("centre", true);
    await service.reply("Yes, interested.", "centre", "pasted");
    await service.fastForward(8);
    assert.equal(expansions(await service.snapshot()).length, 0);
  });
});

// ------------------------------------------------------------- preferences

describe("learning preferences", () => {
  test("two passes sharing a reason propose a criterion that applies only when accepted", async () => {
    const model = fakeModel({
      "reason inference": () => ({ reason: "no startup experience" }),
      "preference pattern": (data) =>
        data.decisions.length >= 2
          ? {
              found: true,
              text: "has shipped a product",
              kind: "must",
              rationale: "You passed on two people without product work.",
              supportingCandidateIds: data.decisions.map((entry: { candidateId: string }) => entry.candidateId),
            }
          : { found: false },
    });
    const { board } = world({ model });
    const { service } = await confirmedRole(board);
    await service.feedback("outer", "pass", "only consulting");
    await idle(service);
    assert.equal((await service.snapshot()).proposals.length, 0, "one pass is not a pattern");
    await service.feedback("unsure", "pass", "consulting again");
    await idle(service);
    const pending = await service.snapshot();
    const proposal = pending.proposals.find((entry) => entry.type === "criterion");
    assert.ok(proposal);
    assert.ok(!activeTexts(pending).includes("has shipped a product"), "not applied before the founder decides");
    await service.resolveProposal(proposal.id, true);
    await idle(service);
    assert.ok(activeTexts(await service.snapshot()).includes("has shipped a product"));
  });
});

// ------------------------------------------------------------------ search

describe("search", () => {
  test("a round runs several queries and everyone found is scored, however many", async () => {
    const { board, source } = world();
    const { service } = await confirmedRole(board);
    assert.ok(new Set(source.queries).size >= 3, `searched ${source.queries.length} queries`);
    const snapshot = await service.snapshot();
    const found = new Set([...ALPHA, ...(await new FakeSource().search("beta")), ...(await new FakeSource().search("gamma"))].map((profile) => profile.id));
    assert.deepEqual(snapshot.candidates.map((candidate) => candidate.id).sort(), [...found].sort());
    for (const candidate of snapshot.candidates) {
      assert.ok(candidate.settled, `${candidate.id} was scored`);
      assert.notEqual(candidate.tier, "pending");
    }

    // A search returning far more than about twenty people still gets everyone scored.
    const many = Array.from({ length: 45 }, (_, index) => person(`bulk${index}`, index % 2 ? "typescript startup singapore" : "java"));
    const big = world({ source: new FakeSource(() => many) });
    const bigRole = await confirmedRole(big.board);
    const bigSnapshot = await bigRole.service.snapshot();
    assert.equal(bigSnapshot.candidates.length, 45);
    assert.ok(bigSnapshot.candidates.every((candidate) => candidate.settled));
  });

  test("find more adds new people under unchanged criteria, with new queries, keeping earlier judgements", async () => {
    const { board, source } = world();
    const { roleId, service } = await confirmedRole(board);
    const before = await service.snapshot();
    const earlierQueries = [...source.queries];
    const result = await service.findMore();
    await idle(service);
    const after = await service.snapshot();
    assert.ok(result.added > 0);
    assert.ok(after.candidates.length > before.candidates.length);
    assert.deepEqual(after.criteria, before.criteria);
    for (const query of result.searched) assert.ok(!earlierQueries.includes(query), `repeated ${query}`);
    for (const earlier of before.candidates) {
      const now = after.candidates.find((candidate) => candidate.id === earlier.id)!;
      assert.equal(now.tier, earlier.tier);
      assert.deepEqual(now.verdicts, earlier.verdicts);
    }
    assert.ok(after.candidates.every((candidate) => candidate.settled));

    const tool = JSON.parse((await recruitingExtension(board).run("recruiting_find_more", { role_id: roleId })).content);
    assert.ok(!tool.error);
    assert.deepEqual((await service.snapshot()).criteria, before.criteria);
  });

  test("one LinkedIn profile under www and a country subdomain is one person, across rounds and pasted links", async () => {
    const source = new FakeSource((query) => {
      if (query.startsWith("alpha")) return [person("lim", "typescript startup singapore rust", "https://www.linkedin.com/in/lim-wei")];
      if (query.startsWith("beta")) return [person("lim-sg", "typescript startup singapore rust", "https://sg.linkedin.com/in/lim-wei/")];
      if (query.startsWith("gamma")) return [person("lim-http", "typescript startup singapore rust", "http://linkedin.com/in/Lim-Wei?trk=x")];
      return [person("lim-more", "typescript startup singapore rust", "https://uk.linkedin.com/in/lim-wei")];
    });
    const { board } = world({ source });
    const { service } = await confirmedRole(board);
    assert.equal((await service.snapshot()).candidates.length, 1);
    await service.findMore();
    await idle(service);
    assert.equal((await service.snapshot()).candidates.length, 1, "a later round does not add them again");
    await service.importProfiles(["https://sg.linkedin.com/in/lim-wei"]);
    await idle(service);
    assert.equal((await service.snapshot()).candidates.length, 1, "pasting their country-subdomain link does not add them again");
  });

});

// -------------------------------------------------------------- chat skill

describe("the chat skill", () => {
  type Turn = string | ((lastToolReply: string) => Array<[string, Record<string, unknown>]>);

  async function scripted(board: RoleBoard, turns: Turn[]) {
    const offered: string[][] = [];
    const toolReplies: string[] = [];
    const skills = (await loadSkills()).filter((skill) => skill.name === "recruiting");
    assert.equal(skills.length, 1, "the recruiting skill ships with the repository");
    const agent = new SoCLaaSCompanyAgent(knowledge, {
      apiKey: "test-key",
      skills,
      extensions: [recruitingExtension(board)],
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          tools?: Array<{ function: { name: string } }>;
          messages: Array<{ role: string; content: string }>;
        };
        offered.push((body.tools ?? []).map((entry) => entry.function.name));
        const last = body.messages.at(-1);
        if (last?.role === "tool") toolReplies.push(last.content);
        const turn = turns.shift() ?? "Done.";
        const message =
          typeof turn === "string"
            ? { content: turn }
            : {
                content: null,
                tool_calls: turn(toolReplies.at(-1) ?? "").map(([name, args], index) => ({
                  id: `call-${offered.length}-${index}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                })),
              };
        return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
      },
    });
    return { agent, offered, toolReplies };
  }

  const roleFrom = (reply: string) => /"role_id":"(\w+)"/.exec(reply)?.[1] ?? "unknown";

  test("recruiting tools are not offered until the skill is loaded", async () => {
    const { board } = world();
    const { agent, offered, toolReplies } = await scripted(board, [
      () => [["recruiting_start", { requirement: REQUIREMENT }]],
      () => [["load_skill", { name: "recruiting" }]],
      () => [["recruiting_status", {}]],
      "No roles yet.",
    ]);
    await agent.answer({ employeeId: "founder", question: "I want to hire a backend engineer." });
    assert.ok(!offered[0]!.some((name) => name.startsWith("recruiting_") || name === "show_recruiting_panel"));
    assert.ok(offered[0]!.includes("load_skill"));
    assert.deepEqual(await board.list(), [], "a call before loading changes nothing");
    assert.ok(!/"role_id"/.test(toolReplies[0]!));
    assert.ok(offered.at(-1)!.includes("recruiting_start"));
  });

  test("no tool name suggests sending", async () => {
    const { board } = world();
    const extension = recruitingExtension(board);
    const names = extension.tools.map((tool) => tool.function.name);
    assert.ok(names.length > 0);
    for (const name of names) assert.doesNotMatch(name, /send|mail|dispatch|deliver|post|message|contact/i);
    const { agent, offered } = await scripted(board, [() => [["load_skill", { name: "recruiting" }]], "Ready."]);
    await agent.answer({ employeeId: "founder", question: "Help me hire." });
    for (const name of offered.flat()) assert.doesNotMatch(name, /send|mail|dispatch|deliver/i);
  });

  test("a panel carries ids only and refers to a role that exists", async () => {
    const { board } = world();
    const { agent } = await scripted(board, [
      () => [["load_skill", { name: "recruiting" }]],
      () => [["recruiting_start", { requirement: REQUIREMENT }]],
      (reply) => [["show_recruiting_panel", { role_id: roleFrom(reply), view: "criteria" }]],
      "Check the criteria in the panel below.",
    ]);
    const result = await agent.answer({ employeeId: "founder", question: "Hire a backend engineer in Singapore." });
    const roles = (await board.list()).map((role) => role.id);
    assert.equal(result.blocks?.length, 1);
    for (const block of result.blocks ?? []) {
      for (const key of Object.keys(block)) assert.ok(["type", "view", "roleId", "candidateId"].includes(key), key);
      assert.ok(roles.includes(block.roleId));
    }

    const tools = recruitingExtension(board);
    const { roleId } = await confirmedRole(board);
    const good = await tools.run("show_recruiting_panel", { role_id: roleId, view: "candidate", candidate_id: "centre" });
    assert.deepEqual(good.block, { type: "recruiting", view: "candidate", roleId, candidateId: "centre" });
    for (const args of [
      { role_id: "nosuchrole", view: "pool" },
      { role_id: roleId, view: "candidate", candidate_id: "nobody" },
      { role_id: roleId, view: "everything" },
    ]) {
      const outcome = await tools.run("show_recruiting_panel", args).catch((error: unknown) => ({ content: String(error), block: undefined }));
      assert.equal(outcome.block, undefined, JSON.stringify(args));
    }
    await board.remove(roleId);
    const stale = await tools.run("show_recruiting_panel", { role_id: roleId, view: "pool" }).catch(() => ({ block: undefined }));
    assert.equal(stale.block, undefined, "no panel for a deleted role");
  });

  test("a tool error for a missing role goes back to the model and the turn still answers", async () => {
    const { board } = world();
    const { agent, toolReplies } = await scripted(board, [
      () => [["load_skill", { name: "recruiting" }]],
      () => [["recruiting_confirm", { role_id: "missing" }]],
      "That role does not exist.",
    ]);
    const result = await agent.answer({ employeeId: "founder", question: "Confirm it." });
    assert.match(toolReplies.at(-1)!, /error|no such role/i);
    assert.match(result.answer, /does not exist/);
  });

  test("a tool that fails upstream reports the failure to the model instead of failing the turn", async () => {
    const model = fakeModel({
      "criteria extraction": () => {
        throw new Error("model timed out");
      },
    });
    const { board } = world({ model });
    const { agent, toolReplies } = await scripted(board, [
      () => [["load_skill", { name: "recruiting" }]],
      () => [["recruiting_start", { requirement: REQUIREMENT }]],
      "Starting the role failed; please try again.",
    ]);
    const result = await agent.answer({ employeeId: "founder", question: "Hire a backend engineer." });
    assert.match(toolReplies.at(-1) ?? "", /error|fail|timed out/i);
    assert.match(result.answer, /failed/);
  });
});

// -------------------------------------------------------------------- HTTP

describe("HTTP", () => {
  test("invalid input gets a 4xx, never a 5xx", async () => {
    const { board } = world();
    const confirmed = await confirmedRole(board);
    const draft = await openRole(board);
    const app = appFor(board);
    const c = `/api/recruiting/roles/${confirmed.roleId}`;
    const d = `/api/recruiting/roles/${draft.roleId}`;
    const cases: Array<[string, string, unknown, string?]> = [
      ["POST", "/api/recruiting/roles", {}],
      ["POST", "/api/recruiting/roles", { text: 42 }],
      ["POST", "/api/recruiting/roles", { text: "hi" }],
      ["POST", "/api/recruiting/roles", { filename: "jd.exe", contentBase64: Buffer.from("hello").toString("base64") }],
      ["POST", "/api/recruiting/roles", { contentBase64: Buffer.from("hello").toString("base64") }],
      ["POST", "/api/recruiting/roles", "{not json", "application/json"],
      ["POST", `${c}/say`, {}],
      ["POST", `${c}/say`, { text: "" }],
      ["POST", `${c}/say`, ["array"]],
      ["POST", `${d}/criteria/draft`, { criteria: "all of them" }],
      ["POST", `${d}/criteria/draft`, { criteria: [{ text: "women only", kind: "must" }] }],
      ["POST", `${c}/criteria/draft`, { criteria: [{ text: "typescript", kind: "must" }] }],
      ["POST", `${c}/confirm`, {}],
      ["POST", `${d}/more`, {}],
      ["POST", `${c}/candidates/import`, {}],
      ["POST", `${c}/candidates/import`, { urls: ["https://evil.example/in/x"] }],
      ["POST", `${c}/candidates/import`, { urls: [] }],
      ["POST", `${c}/candidates/centre/feedback`, { decision: "maybe" }],
      ["POST", `${c}/candidates/nobody/feedback`, { decision: "pass" }],
      ["POST", `${c}/candidates/nobody/outreach`, {}],
      ["POST", `${c}/candidates/centre/draft`, { email: "not-an-email" }],
      ["POST", `${c}/candidates/nobody/send`, {}],
      ["POST", `${c}/candidates/centre/reply`, {}],
      ["POST", `${c}/candidates/centre/close`, { reason: "because" }],
      ["POST", `${c}/candidates/nobody/close`, { reason: "hired" }],
      ["POST", `${c}/proposals/nothing`, { accept: true }],
      ["POST", `${c}/fast-forward`, { days: "a week" }],
      ["POST", `${c}/fast-forward`, { days: 0 }],
      ["POST", `${c}/fast-forward`, { days: 10_000 }],
      ["POST", `${c}/fast-forward`, { days: 2.5 }],
      ["POST", `${c}/ask`, {}],
      ["POST", "/api/recruiting/inbox/linkedin", {}],
      ["POST", "/api/recruiting/inbox/linkedin", { threads: "x" }],
      ["GET", "/api/recruiting/roles/nosuchrole/state", undefined],
      ["DELETE", "/api/recruiting/roles/nosuchrole", undefined],
      ["GET", "/api/recruiting/gmail/connect", undefined],
      ["GET", "/api/recruiting/gmail/callback?code=x&state=forged", undefined],
    ];
    const failures: string[] = [];
    for (const [method, url, payload, contentType] of cases) {
      const response = await app.inject({
        method: method as "GET" | "POST" | "DELETE",
        url,
        ...(payload === undefined ? {} : { payload: typeof payload === "string" ? payload : JSON.stringify(payload) }),
        ...(payload === undefined ? {} : { headers: { "content-type": contentType ?? "application/json" } }),
      });
      if (response.statusCode < 400 || response.statusCode >= 500) {
        failures.push(`${method} ${url} ${JSON.stringify(payload)} -> ${response.statusCode}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test("an unreadable uploaded job description gets a 4xx, not a 5xx", async () => {
    const { board } = world();
    const app = appFor(board);
    const failures: string[] = [];
    for (const filename of ["jd.pdf", "jd.docx"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/recruiting/roles",
        payload: { filename, contentBase64: Buffer.from("this is not really a document").toString("base64") },
      });
      if (response.statusCode < 400 || response.statusCode >= 500) failures.push(`${filename} -> ${response.statusCode}`);
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(await board.list(), []);
  });

  test("only /recruiting may be framed, and only by the same origin", async () => {
    const { board } = world();
    const app = appFor(board);
    for (const url of ["/recruiting", "/recruiting?embed=1"]) {
      const page = await app.inject({ method: "GET", url });
      assert.equal(page.statusCode, 200);
      assert.equal(page.headers["x-frame-options"], "SAMEORIGIN");
      const csp = String(page.headers["content-security-policy"]);
      const ancestors = /frame-ancestors ([^;]*)/.exec(csp)?.[1]?.trim();
      assert.equal(ancestors, "'self'", csp);
    }
    const home = await app.inject({ method: "GET", url: "/" });
    assert.equal(home.headers["x-frame-options"], "DENY");
    assert.match(String(home.headers["content-security-policy"]), /frame-ancestors 'none'/);
  });
});
