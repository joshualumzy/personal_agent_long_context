import assert from "node:assert/strict";
import { test } from "node:test";
import { SoCLaaSCompanyAgent } from "../src/soclaas-company-agent.js";
import type { CompanyKnowledge } from "../src/company-domain.js";

function streamingResponse(chunks: string[], delayMs: number, onClose: () => void): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(chunks[0]!));
        setTimeout(() => {
          for (const chunk of chunks.slice(1)) controller.enqueue(encoder.encode(chunk));
          onClose();
          controller.close();
        }, delayMs);
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function knowledgeForStreamingTests(): CompanyKnowledge {
  return {
    async employee() {
      return { employeeId: "jax", displayName: "Jax", currentAssignments: [] };
    },
    async search() {
      return [{ sourceId: "JIRA-42", sourceType: "jira", title: "Project", excerpt: "The project is active." }];
    },
    async related() {
      return [];
    },
    async sources() {
      return [];
    },
  };
}

const searchToolCall = {
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: "search-1",
            type: "function",
            function: { name: "search_company_knowledge", arguments: JSON.stringify({ query: "project" }) },
          },
        ],
      },
    },
  ],
};

test("forwards an upstream SSE token before the provider closes the stream", async () => {
  let providerClosed = false;
  const tokenObservedBeforeClose: boolean[] = [];
  let calls = 0;
  const agent = new SoCLaaSCompanyAgent(knowledgeForStreamingTests(), {
    apiKey: "test-key",
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify(searchToolCall), { status: 200 });
      return streamingResponse(
        [
          'data: {"choices":[{"delta":{"content":"The project "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"is active. [source:JIRA-42]"}}]}\n\n',
          "data: [DONE]\n\n",
        ],
        5,
        () => {
          providerClosed = true;
        },
      );
    },
  });

  const result = await agent.answer(
    { employeeId: "jax", question: "What is active?" },
    { onToken: () => tokenObservedBeforeClose.push(!providerClosed) },
  );

  assert.equal(result.answer, "The project is active. [source:JIRA-42]");
  assert.deepEqual(tokenObservedBeforeClose, [true, false]);
});

test("identifies a gateway JSON fallback as non-streaming at the callback boundary", async () => {
  let providerClosed = false;
  const tokenObservedBeforeClose: boolean[] = [];
  let calls = 0;
  const agent = new SoCLaaSCompanyAgent(knowledgeForStreamingTests(), {
    apiKey: "test-key",
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify(searchToolCall), { status: 200 });
      const response = new Response(
        new ReadableStream({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({ choices: [{ message: { content: "The project is active. [source:JIRA-42]" } }] }),
                ),
              );
              providerClosed = true;
              controller.close();
            }, 5);
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      return response;
    },
  });

  await agent.answer(
    { employeeId: "jax", question: "What is active?" },
    { onToken: () => tokenObservedBeforeClose.push(!providerClosed) },
  );

  assert.deepEqual(tokenObservedBeforeClose, [false]);
});

test("runs independent company searches from one tool response in parallel", async () => {
  let activeSearches = 0;
  let peakSearches = 0;
  let calls = 0;
  const knowledge: CompanyKnowledge = {
    async employee() {
      return { employeeId: "jax", displayName: "Jax", currentAssignments: [] };
    },
    async search(query) {
      activeSearches += 1;
      peakSearches = Math.max(peakSearches, activeSearches);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeSearches -= 1;
      return [
        {
          sourceId: query === "project" ? "JIRA-42" : "CONF-9",
          sourceType: "jira",
          title: query,
          excerpt: "The project is active.",
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
  const agent = new SoCLaaSCompanyAgent(knowledge, {
    apiKey: "test-key",
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: "search-1", type: "function", function: { name: "search_company_knowledge", arguments: JSON.stringify({ query: "project" }) } },
                    { id: "search-2", type: "function", function: { name: "search_company_knowledge", arguments: JSON.stringify({ query: "timeline" }) } },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "The project is active. [source:JIRA-42]" } }] }),
        { status: 200 },
      );
    },
  });

  const result = await agent.answer({ employeeId: "jax", question: "What is active?" }, { onToken: () => {} });

  assert.equal(result.answer, "The project is active. [source:JIRA-42]");
  assert.equal(peakSearches, 2, "two independent searches should overlap");
});

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

test("tops up related sources with artifacts that share a cause, and never with the event itself", async () => {
  const askedThroughEvents: Array<{ seeds: string[]; limit: number }> = [];
  const knowledge: CompanyKnowledge = {
    async employee() {
      return { employeeId: "jax", displayName: "Jax", currentAssignments: [] };
    },
    async search() {
      return [
        {
          sourceId: "CONF-5",
          sourceType: "confluence",
          title: "Roadmap alignment",
          excerpt: "The roadmap moved.",
        },
      ];
    },
    // Directly linked artifacts are scarce in this corpus.
    async related() {
      return [];
    },
    async relatedThroughEvents(sourceIds, limit) {
      askedThroughEvents.push({ seeds: sourceIds, limit });
      return [
        {
          sourceId: "zoom-1",
          sourceType: "zoom_transcript",
          title: "Roadmap call",
          excerpt: "We agreed to move the roadmap.",
        },
      ];
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
                  arguments: JSON.stringify({ query: "roadmap", limit: 1 }),
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
          message: {
            content: null,
            tool_calls: [
              {
                id: "call-2",
                type: "function",
                function: {
                  name: "get_related_sources",
                  arguments: JSON.stringify({ source_ids: ["CONF-5"], limit: 4 }),
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
          message: {
            content: "The roadmap moved. [source:CONF-5] [source:zoom-1]",
          },
        },
      ],
    },
  ];

  const agent = new SoCLaaSCompanyAgent(knowledge, {
    apiKey: "test-key",
    fetch: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
  });

  const result = await agent.answer({ employeeId: "jax", question: "What happened to the roadmap?" });

  // The seed was retrieved first, so it is allowed as a seed, and the top-up
  // asked only for the slots the direct lookup left unfilled.
  assert.deepEqual(askedThroughEvents, [{ seeds: ["CONF-5"], limit: 4 }]);
  const cited = result.sources.map((source) => source.sourceId).sort();
  assert.deepEqual(cited, ["CONF-5", "zoom-1"]);
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
