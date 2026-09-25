import assert from "node:assert/strict";
import { test } from "node:test";
import { SoCLaaSCompanyAgent } from "../src/soclaas-company-agent.js";
import type { CompanyKnowledge } from "../src/company-domain.js";

test("uses the configured SoCLaaS chat-completions endpoint and preserves retrieved citations", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const knowledge: CompanyKnowledge = {
    async employee() {
      return {
        employeeId: "jax",
        displayName: "Jax",
        role: "Backend Engineer",
        department: "Engineering_Backend",
        currentAssignments: [],
      };
    },
    async search() {
      return [
        {
          sourceId: "JIRA-42",
          sourceType: "jira",
          title: "Project update",
          excerpt: "The project is active.",
          occurredAt: "2026-09-23T00:00:00.000Z",
        },
      ];
    },
    async related() {
      return [];
    },
    async sources() {
      return [];
    },
  };
  const responses = [
    {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "search_company_knowledge",
                  arguments: JSON.stringify({ query: "project", limit: 1 }),
                },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          message: { content: "The project is active. [source:JIRA-42]" },
        },
      ],
    },
  ];
  const agent = new SoCLaaSCompanyAgent(knowledge, {
    apiKey: "test-key",
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    },
  });

  const result = await agent.answer({
    employeeId: "jax",
    question: "What is active?",
    personalMemory: "Jax is coordinating the release.",
  });

  assert.equal(requests[0]?.url, "https://soclaas-api.comp.nus.edu.sg/v1/chat/completions");
  assert.equal(requests[0]?.body.model, "qwen3.8:27b");
  assert.match(JSON.stringify(requests[0]?.body.messages), /Jax is coordinating the release/);
  assert.equal(result.sources[0]?.sourceId, "JIRA-42");
});

test("replaces an uncited insufficient-evidence response with a controlled safe answer", async () => {
  const knowledge: CompanyKnowledge = {
    async employee() {
      return { employeeId: "jax", displayName: "Jax", currentAssignments: [] };
    },
    async search() {
      return [];
    },
    async related() {
      return [];
    },
    async sources() {
      return [];
    },
  };
  const responses = [
    {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "search_company_knowledge",
                  arguments: JSON.stringify({ query: "deadline", limit: 1 }),
                },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ message: { content: "Insufficient evidence, but Jax's deadline is Friday." } }] },
    { choices: [{ message: { content: "Insufficient evidence." } }] },
  ];
  const agent = new SoCLaaSCompanyAgent(knowledge, {
    apiKey: "test-key",
    fetch: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
  });

  const result = await agent.answer({ employeeId: "jax", question: "What is my deadline?" });

  assert.equal(
    result.answer,
    "Insufficient Evidence: I could not find retrieved Company Evidence that supports a reliable answer to this question.",
  );
  assert.equal(result.sources.length, 0);
  assert.doesNotMatch(result.answer, /Friday/);
});
