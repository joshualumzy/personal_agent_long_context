// Round 3 fix follow-up: what the founder can do after Gmail never confirmed a send.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CandidateProfile } from "../../src/recruiting/domain.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel } from "../../src/recruiting/llm.js";
import { RecruitingService } from "../../src/recruiting/service.js";
import { MemoryStore } from "../../src/recruiting/store.js";

const person = (id: string): CandidateProfile => ({
  id, name: `Person ${id}`, headline: "typescript", location: "Singapore",
  profileUrl: `https://www.linkedin.com/in/${id}`, workHistory: [], educationHistory: [], summary: "typescript",
});
const model: JsonModel = {
  async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
    const data = input as Record<string, any>;
    if (task === "criteria extraction") return { title: "Engineer", criteria: [{ text: "typescript", kind: "must" }], queries: ["q"] } as T;
    if (task === "criterion judgement") return { verdicts: data.criteria.map((c: any) => ({ criterionId: c.id, satisfied: "yes", reasoning: "k" })) } as T;
    if (task === "outreach draft") return { subject: "Hi", body: "Hello" } as T;
    if (task === "reason inference") return { reason: "r" } as T;
    throw new Error(`unscripted ${task}`);
  },
};

async function afterLostResponse() {
  const sent: string[] = [];
  let lose = true;
  const gmail = {
    async connected() { return true; },
    async send(message: { body: string }) {
      sent.push(message.body);
      if (lose) { lose = false; throw new TypeError("fetch failed"); }
      return { threadId: "t" };
    },
    async repliesIn() { return []; },
  };
  const service = new RecruitingService({
    model, source: { name: "fake", search: async () => [person("a")] }, store: new MemoryStore(),
    memory: new LocalIntentMemory(), contactFinders: [], gmail: gmail as never,
  });
  await service.start("We need an engineer who knows TypeScript.");
  await service.confirm();
  await service.settle();
  await service.prepareOutreach("a");
  await service.editDraft("a", { email: "a@example.com" });
  const first = await service.send("a", false).then(() => "ok", (e: { code?: string }) => e.code);
  assert.equal(first, "send_unconfirmed");
  const a = async () => (await service.snapshot()).candidates.find((c) => c.id === "a")!;
  return { service, sent, a };
}

describe("after Gmail never confirmed a send", () => {
  test("the panel's save-then-send with nothing changed does not send it again", async () => {
    const { service, sent, a } = await afterLostResponse();
    const draft = (await a()).draft!;
    await service.editDraft("a", { subject: draft.subject, body: draft.body, email: "a@example.com" });
    const again = await service.send("a", false).then(() => "ok", (e: { code?: string }) => e.code);
    assert.equal(again, "send_unconfirmed");
    assert.equal(sent.length, 1);
    assert.equal((await a()).draft?.unconfirmed, true);
  });

  test("'I sent it myself' records it as the email it was, and nothing more is sent", async () => {
    const { service, sent, a } = await afterLostResponse();
    await service.send("a", true);
    const after = await a();
    assert.equal(sent.length, 1);
    assert.equal(after.stage, "contacted");
    assert.equal(after.messages.filter((m) => m.direction === "outbound").length, 1);
    assert.equal(after.messages[0]!.channel, "email");
    assert.ok(!after.draft);
  });

  test("changing the draft means it did not go out: it can be sent again", async () => {
    const { service, sent, a } = await afterLostResponse();
    await service.editDraft("a", { body: "Hello again" });
    await service.send("a", false);
    assert.equal(sent.length, 2);
    assert.equal(sent[1], "Hello again");
    assert.equal((await a()).stage, "contacted");
  });
});
