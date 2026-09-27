import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ModelRegistry,
  createDefaultModelRegistry,
  UnknownModelError,
  ModelUnavailableError,
  ProviderUnavailableError,
} from "../src/model-registry.js";
import { buildApp } from "../src/http-app.js";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { createSessionToken } from "../src/auth.js";

const TEST_SECRET = "test-auth-session-secret-key-32chars-min";

describe("ModelRegistry", () => {
  test("lists configured models with availability and omit internal agent references", () => {
    const mockAgent = { answer: async () => ({ answer: "ok", sources: [], runId: "1", toolCalls: [] }) };
    const registry = new ModelRegistry([
      {
        id: "soclaas",
        name: "Qwen 2.5 32B (SoCLaaS)",
        shortName: "SoCLaaS Qwen",
        configuredModel: "Qwen/Qwen2.5-32B-Instruct",
        provider: "NUS SoC",
        available: true,
        agent: mockAgent,
      },
      {
        id: "sonnet",
        name: "Claude 3.5 Sonnet",
        shortName: "Claude Sonnet",
        configuredModel: "anthropic.claude-sonnet",
        provider: "AWS Bedrock",
        available: false,
        unavailableReason: "AWS credentials not provided.",
      },
    ]);

    const list = registry.list();
    assert.equal(list.default, "soclaas");
    assert.equal(list.models.length, 2);
    assert.equal(list.models[0].id, "soclaas");
    assert.equal(list.models[0].available, true);
    assert.equal("agent" in list.models[0], false);
    assert.equal(list.models[1].id, "sonnet");
    assert.equal(list.models[1].available, false);
    assert.equal(list.models[1].unavailableReason, "AWS credentials not provided.");
  });

  test("resolves canonical model and case-insensitively", () => {
    const mockAgent = { answer: async () => ({ answer: "ok", sources: [], runId: "1", toolCalls: [] }) };
    const registry = new ModelRegistry([
      {
        id: "soclaas",
        name: "Qwen 2.5 32B (SoCLaaS)",
        shortName: "SoCLaaS Qwen",
        configuredModel: "Qwen/Qwen2.5-32B-Instruct",
        provider: "NUS SoC",
        available: true,
        agent: mockAgent,
      },
    ]);

    const res = registry.resolve("SoCLaaS");
    assert.equal(res.status, "resolved");
    if (res.status === "resolved") {
      assert.equal(res.descriptor.id, "soclaas");
      assert.equal(res.agent, mockAgent);
    }
  });

  test("resolves aliases truthfully", () => {
    const mockSonnet = { answer: async () => ({ answer: "ok", sources: [], runId: "1", toolCalls: [] }) };
    const registry = new ModelRegistry([
      {
        id: "sonnet",
        name: "Claude 3.5 Sonnet",
        shortName: "Claude Sonnet",
        configuredModel: "anthropic.claude-sonnet",
        provider: "AWS Bedrock",
        available: true,
        aliases: ["claude", "claude-3-5-sonnet", "bedrock"],
        agent: mockSonnet,
      },
    ]);

    for (const alias of ["claude", "claude-3-5-sonnet", "bedrock", "CLAUDE-3-5-SONNET"]) {
      const res = registry.resolve(alias);
      assert.equal(res.status, "resolved", `Alias ${alias} should resolve to sonnet`);
      if (res.status === "resolved") {
        assert.equal(res.descriptor.id, "sonnet");
      }
    }
  });

  test("returns unknown status for unrecognized model", () => {
    const registry = new ModelRegistry([]);
    const res = registry.resolve("gpt-5-turbo");
    assert.equal(res.status, "unknown");
    if (res.status === "unknown") {
      assert.equal(res.modelId, "gpt-5-turbo");
    }
  });

  test("returns unavailable status for unconfigured model without silent fallback", () => {
    const registry = new ModelRegistry([
      {
        id: "sonnet",
        name: "Claude 3.5 Sonnet",
        shortName: "Claude Sonnet",
        configuredModel: "anthropic.claude-sonnet",
        provider: "AWS Bedrock",
        available: false,
        unavailableReason: "Sonnet not configured.",
      },
    ]);

    const res = registry.resolve("sonnet");
    assert.equal(res.status, "unavailable");
    if (res.status === "unavailable") {
      assert.equal(res.reason, "Sonnet not configured.");
    }
  });

  test("HTTP pipeline derives metadata truthfully from resolved model, never the request", async () => {
    const mockSonnet = {
      answer: async () => ({
        answer: "Verified answer from Claude [source:test-1]",
        sources: [{ sourceId: "test-1", sourceType: "slack", title: "Test", excerpt: "Test excerpt" }],
        runId: "run-123",
        toolCalls: [],
      }),
    };

    const app = buildApp({
      sessionConfig: { secret: TEST_SECRET },
      memory: new DeterministicMemoryProvider(),
      companyAgents: {
        sonnet: mockSonnet as never,
      },
    });

    const cookie = `sme_session=${createSessionToken("jax", TEST_SECRET)}`;

    // Pass alias "claude-3-5-sonnet"
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/questions",
      headers: { cookie },
      payload: {
        question: "What is Project Titan?",
        model: "claude-3-5-sonnet",
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.model, "sonnet", "Must use canonical resolved model ID, not requested alias");
    assert.equal(body.provider, "AWS Bedrock", "Must derive provider from resolved descriptor");

    await app.close();
  });
});
