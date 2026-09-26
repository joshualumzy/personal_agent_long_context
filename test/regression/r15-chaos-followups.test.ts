// Found by the live off-script run after round 13: a Chinese question quoting an English criterion
// was taken for English, so the English answer was never translated.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompanyKnowledge } from "../../src/company-domain.js";
import { SoCLaaSCompanyAgent } from "../../src/soclaas-company-agent.js";

const knowledge: CompanyKnowledge = {
  async employee() { return { employeeId: "jax", displayName: "Jax", currentAssignments: [] }; },
  async search() { return [{ sourceId: "CONF-101", sourceType: "confluence", title: "Q4 plan", excerpt: "One founding backend engineer in Singapore." }]; },
  async related() { return []; },
  async sources() { return []; },
};

test("a Chinese question quoting an English criterion gets a Chinese answer", async () => {
  const replies = ["It comes from the Q4 hiring plan [source:CONF-101].", "这条标准来自第四季度的招聘计划 [source:CONF-101]。"];
  let n = 0;
  const agent = new SoCLaaSCompanyAgent(knowledge, {
    apiKey: "k",
    retryBaseMs: 1,
    fetch: (async () => {
      n += 1;
      const message = n === 1
        ? { content: null, tool_calls: [{ id: "a", type: "function", function: { name: "search_company_knowledge", arguments: "{\"query\":\"plan\"}" } }] }
        : { content: replies.shift() };
      return new Response(JSON.stringify({ choices: [{ message }] }));
    }) as typeof fetch,
  });
  const result = await agent.answer({ employeeId: "jax", question: "为什么有这条标准：「Founding backend engineer in Singapore」？" });
  assert.match(result.answer, /招聘计划/);
});
