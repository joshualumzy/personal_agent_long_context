// Found by the live off-script run after round 8: "'; DROP TABLE roles; --" opened a "Database Engineer" role.
import assert from "node:assert/strict";
import { test } from "node:test";
import { recruitingExtension } from "../../src/recruiting/chat-tools.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel } from "../../src/recruiting/llm.js";
import { MemoryRoleRepository, RoleBoard } from "../../src/recruiting/roles.js";
import { RecruitingService } from "../../src/recruiting/service.js";

const model: JsonModel = {
  async json<T>({ task }: { task: string }): Promise<T> {
    if (task === "criteria extraction") return { notARole: true } as T;
    throw new Error(`unscripted ${task}`);
  },
};

test("text the model says describes no one to hire opens no role, and the tool says so", async () => {
  const roles = new RoleBoard(new MemoryRoleRepository(), (store) =>
    new RecruitingService({ model, source: { name: "fake", search: async () => [] }, store, memory: new LocalIntentMemory(), contactFinders: [], gmail: null }),
  );
  const outcome = JSON.parse((await recruitingExtension(roles).run("recruiting_start", { requirement: "'; DROP TABLE roles; -- and some more words" })).content);
  assert.match(String(outcome.error), /does not describe a role/);
  assert.deepEqual(await roles.list(), []);
});
