// Round 2 hunt: src/recruiting/chat-tools.ts. "BUG" tests fail today; "NOT A BUG" tests pass.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { recruitingExtension } from "../../src/recruiting/chat-tools.js";
import type { CandidateProfile } from "../../src/recruiting/domain.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel } from "../../src/recruiting/llm.js";
import { MemoryRoleRepository, RoleBoard } from "../../src/recruiting/roles.js";
import { RecruitingService } from "../../src/recruiting/service.js";
import type { CandidateSource } from "../../src/recruiting/sources.js";

const POOL: CandidateProfile[] = ["a", "b"].map((id) => ({
  id,
  name: `Person ${id}`,
  headline: "typescript startup",
  location: "Singapore",
  profileUrl: `https://example.com/${id}`,
  workHistory: [{ title: "Engineer", company: `Company ${id}` }],
  educationHistory: [],
  summary: "typescript startup",
}));

class FakeSource implements CandidateSource {
  readonly name = "fake";
  async search(): Promise<CandidateProfile[]> {
    return POOL;
  }
}

function fakeModel(): JsonModel {
  return {
    async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
      const data = input as Record<string, any>;
      switch (task) {
        case "criteria extraction":
          return {
            title: "Founding backend engineer",
            criteria: [
              { text: "typescript", kind: "must" },
              { text: "startup", kind: "must" },
              { text: "rust", kind: "nice" },
            ],
            query: "typescript startup engineer singapore",
          } as T;
        case "criterion judgement":
          return {
            verdicts: data.criteria.map((criterion: { id: string; text: string }) => ({
              criterionId: criterion.id,
              satisfied: data.profile.summary.includes(criterion.text) ? "yes" : "no",
              reasoning: "keyword",
            })),
          } as T;
        case "search query":
          return { queries: ["typescript startup engineer singapore"] } as T;
        case "role title":
          return { title: data.currentTitle } as T;
        default:
          throw new Error(`Unscripted task ${task}`);
      }
    },
  };
}

function boardSetup() {
  return new RoleBoard(
    new MemoryRoleRepository(),
    (store) =>
      new RecruitingService({
        model: fakeModel(),
        source: new FakeSource(),
        store,
        memory: new LocalIntentMemory(),
        contactFinders: [],
        gmail: null,
        clock: () => new Date("2026-09-23T02:00:00.000Z"),
        settings: { resultsPerQuery: 6 },
      }),
  );
}

async function draftRole() {
  const board = boardSetup();
  const { id, service } = board.create();
  await service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
  return { board, roleId: id, service };
}

describe("BUG: recruiting_revise_criteria wipes the draft on malformed criteria", () => {
  test("criteria as a list of plain strings (a common model slip) deletes every draft criterion", async () => {
    const { board, roleId, service } = await draftRole();
    const before = (await service.snapshot()).criteria.length;
    const out = await recruitingExtension(board).run("recruiting_revise_criteria", {
      role_id: roleId,
      criteria: ["typescript", "startup"],
    });
    const after = (await service.snapshot()).criteria.length;
    assert.equal(after, before, `draft wiped (${before} -> ${after}); tool said ${out.content.slice(0, 100)}`);
  });

  test("an empty criteria list deletes every draft criterion", async () => {
    const { board, roleId, service } = await draftRole();
    const before = (await service.snapshot()).criteria.length;
    await recruitingExtension(board).run("recruiting_revise_criteria", { role_id: roleId, criteria: [] });
    assert.equal((await service.snapshot()).criteria.length, before);
  });

  test("criteria whose texts are all blank delete every draft criterion", async () => {
    const { board, roleId, service } = await draftRole();
    const before = (await service.snapshot()).criteria.length;
    await recruitingExtension(board).run("recruiting_revise_criteria", {
      role_id: roleId,
      criteria: [{ text: "  ", kind: "must" }],
    });
    assert.equal((await service.snapshot()).criteria.length, before);
  });
});

describe("BUG: recruiting_revise_criteria silently turns unknown kinds into must", () => {
  test("kind 'Nice' or 'nice-to-have' becomes a hard requirement without telling the model", async () => {
    const { board, roleId, service } = await draftRole();
    const out = await recruitingExtension(board).run("recruiting_revise_criteria", {
      role_id: roleId,
      criteria: [
        { text: "typescript", kind: "must" },
        { text: "rust", kind: "Nice" },
        { text: "go", kind: "nice-to-have" },
      ],
    });
    const kinds = (await service.snapshot()).criteria.map((c) => `${c.text}:${c.kind}`);
    const refused = "error" in JSON.parse(out.content);
    assert.ok(refused || !kinds.includes("rust:must"), `stored ${kinds.join(", ")}; tool said ${out.content.slice(0, 80)}`);
  });
});

describe("BUG: recruiting_start makes a role before checking its arguments", () => {
  test("a refused start leaves an orphan service behind, one per attempt", async () => {
    const board = boardSetup();
    const services = (board as unknown as { services: Map<string, unknown> }).services;
    for (let i = 0; i < 5; i += 1) {
      const out = await recruitingExtension(board).run("recruiting_start", { requirement: i % 2 ? "" : "dev" });
      assert.ok("error" in JSON.parse(out.content), out.content);
    }
    assert.equal((await board.list()).length, 0);
    assert.equal(services.size, 0, `${services.size} unreachable services kept in memory`);
  });
});

describe("NOT A BUG (verified)", () => {
  test("role_id with surrounding spaces works for every scoped tool", async () => {
    const { board, roleId } = await draftRole();
    const out = await recruitingExtension(board).run("show_recruiting_panel", { role_id: ` ${roleId} `, view: "criteria" });
    assert.deepEqual(out.block, { type: "recruiting", view: "criteria", roleId });
  });

  test("accept 'yes' or 1 is refused rather than guessed", async () => {
    const { board, roleId } = await draftRole();
    for (const accept of ["yes", 1, null]) {
      const out = await recruitingExtension(board).run("recruiting_resolve_proposal", {
        role_id: roleId,
        proposal_id: "p",
        accept,
      });
      assert.match(out.content, /accept must be true or false/);
    }
  });

  test("a TypeError deep inside a tool becomes a tool error, not a crash", async () => {
    const { board, roleId, service } = await draftRole();
    (service as unknown as { findMore: () => never }).findMore = () => {
      throw new TypeError("x is undefined");
    };
    const out = await recruitingExtension(board).run("recruiting_find_more", { role_id: roleId });
    assert.match(JSON.parse(out.content).error, /x is undefined/);
  });

  test("prototype-looking panel views and role ids are refused", async () => {
    const { board, roleId } = await draftRole();
    const view = await recruitingExtension(board).run("show_recruiting_panel", { role_id: roleId, view: "constructor" });
    assert.match(view.content, /Unknown panel view/);
    const role = await recruitingExtension(board).run("recruiting_status", { role_id: "__proto__" });
    assert.ok("error" in JSON.parse(role.content), role.content);
  });
});
