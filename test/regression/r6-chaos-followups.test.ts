// Found by the live off-script run after round 4: the model answered the Chinese retry with nothing.
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

test("an empty reply to the Chinese retry is asked for once more", async () => {
  const replies: Array<string | null> = [null, "The Q3 budget is $2M [source:JIRA-1].", null, "第三季度预算是两百万 [source:JIRA-1]。"];
  let n = 0;
  const agent = new SoCLaaSCompanyAgent(knowledge, {
    apiKey: "k",
    retryBaseMs: 1,
    fetch: (async () => {
      n += 1;
      const content = replies.shift();
      const message = n === 1
        ? { content: null, tool_calls: [{ id: "a", type: "function", function: { name: "search_company_knowledge", arguments: "{\"query\":\"预算\"}" } }] }
        : { content };
      return new Response(JSON.stringify({ choices: [{ message }] }));
    }) as typeof fetch,
  });
  const result = await agent.answer({ employeeId: "jax", question: "第三季度预算是多少？" });
  assert.match(result.answer, /两百万/);
});
