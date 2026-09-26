// Found by the live off-script run after round 6: the model answered the Chinese retry in English again.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompanyKnowledge } from "../../src/company-domain.js";
import { SoCLaaSCompanyAgent } from "../../src/soclaas-company-agent.js";

const knowledge: CompanyKnowledge = {
  async employee() { return { employeeId: "jax", displayName: "Jax", currentAssignments: [] }; },
  async search() { return [{ sourceId: "JIRA-1", sourceType: "jira", title: "Q3 budget", excerpt: "Q3 budget is $2M" }]; },
  async related() { return []; },
  async sources() { return []; },
};

test("an English reply to the Chinese retry is asked for once more, in Chinese", async () => {
  const replies = ["The Q3 budget is $2M [source:JIRA-1].", "The Q3 budget is $2M [source:JIRA-1].", "第三季度预算是两百万 [source:JIRA-1]。"];
  const asked: string[] = [];
  let n = 0;
  const agent = new SoCLaaSCompanyAgent(knowledge, {
    apiKey: "k",
    retryBaseMs: 1,
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      n += 1;
      const body = JSON.parse(String(init?.body));
      asked.push(String(body.messages.at(-1)?.content ?? ""));
      const message = n === 1
        ? { content: null, tool_calls: [{ id: "a", type: "function", function: { name: "search_company_knowledge", arguments: "{\"query\":\"预算\"}" } }] }
        : { content: replies.shift() };
      return new Response(JSON.stringify({ choices: [{ message }] }));
    }) as typeof fetch,
  });
  const result = await agent.answer({ employeeId: "jax", question: "第三季度预算是多少？" });
  assert.match(result.answer, /两百万/);
  assert.match(asked.at(-1)!, /请用中文/);
});
