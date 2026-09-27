import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";
import { HomeSummarizer } from "../src/home-summary.js";
import type { JsonModel, JsonRequest } from "../src/recruiting/llm.js";

const ITEMS = [
  { part: "needs", kind: "email_draft", title: "Send follow-up to Owen", meeting: "NOC SLA escalation & weekly sync" },
  { part: "needs", kind: "doc_draft", title: "Update the runbook: DLQ retries capped at 5", meeting: "Kafka backend sync" },
  { part: "waiting", kind: "escalation", title: "20% discount for NOTC", meeting: "NOC SLA escalation & weekly sync" },
];

function scripted(reply: (request: JsonRequest) => unknown) {
  const asked: JsonRequest[] = [];
  const model: JsonModel = {
    async json<T>(request: JsonRequest) {
      asked.push(request);
      return reply(request) as T;
    },
  };
  return { model, asked };
}

function appWith(summarizer?: HomeSummarizer) {
  const app = buildApp({ memory: new DeterministicMemoryProvider(), requireAuth: false, ...(summarizer ? { homeSummarizer: summarizer } : {}) });
  return app;
}

async function ask(app: ReturnType<typeof appWith>, body: unknown) {
  const response = await app.inject({ method: "POST", url: "/api/v1/home/summary", payload: body as object });
  return { status: response.statusCode, body: response.json() as { sentence: string | null } };
}

describe("the home's line under the headline", () => {
  test("is written by the model, from what needs you and where it came from, fast", async () => {
    const { model, asked } = scripted(() => ({ sentence: "Owen's follow-up is from the NOC call; the runbook change came out of the Kafka sync." }));
    const app = appWith(new HomeSummarizer(model));
    after(() => app.close());

    const { status, body } = await ask(app, { name: "Jax", items: ITEMS });
    assert.equal(status, 200);
    assert.equal(body.sentence, "Owen's follow-up is from the NOC call; the runbook change came out of the Kafka sync.");
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.fast, true, "a short line does not need the model's thinking");
    assert.deepEqual((asked[0]!.input as { items: unknown[] }).items.length, 3);
  });

  test("is asked for once for the same things, not on every visit", async () => {
    const { model, asked } = scripted(() => ({ sentence: "Two drafts wait for you, from two meetings." }));
    const app = appWith(new HomeSummarizer(model));
    after(() => app.close());
    await ask(app, { name: "Jax", items: ITEMS });
    await ask(app, { name: "Jax", items: ITEMS });
    assert.equal(asked.length, 1);
  });

  test("is left to the page when the model fails or writes something that is not one short line", async () => {
    for (const reply of [
      () => { throw new Error("timeout"); },
      () => ({ sentence: "A very long line ".repeat(20) }),
      () => ({ sentence: "Line one.\nLine two." }),
      () => ({ nothing: true }),
    ]) {
      const { model } = scripted(reply);
      const app = appWith(new HomeSummarizer(model));
      const { status, body } = await ask(app, { name: "Jax", items: ITEMS });
      await app.close();
      assert.equal(status, 200);
      assert.equal(body.sentence, null);
    }
  });

  test("without a model, the page keeps its own line", async () => {
    const app = appWith();
    after(() => app.close());
    const { status, body } = await ask(app, { name: "Jax", items: ITEMS });
    assert.equal(status, 200);
    assert.equal(body.sentence, null);
  });

  test("refuses a request that is not a short list of items", async () => {
    const { model } = scripted(() => ({ sentence: "x" }));
    const app = appWith(new HomeSummarizer(model));
    after(() => app.close());
    assert.equal((await ask(app, { items: "nope" })).status, 400);
    assert.equal((await ask(app, { items: Array.from({ length: 41 }, () => ITEMS[0]) })).status, 400);
  });
});
