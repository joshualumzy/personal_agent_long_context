import assert from "node:assert/strict";
import { test } from "node:test";
import { lettaOptionsFromEnvironment } from "../src/letta-config.js";

test("parses a valid Letta request timeout", () => {
  assert.deepEqual(
    lettaOptionsFromEnvironment({
      LETTA_APP_SERVER_URL: "http://letta.test:4500",
      LETTA_APP_SERVER_TOKEN: "test-token",
      LETTA_MODEL: "test/model",
      LETTA_APP_SERVER_TIMEOUT_MS: "150000",
    }),
    {
      url: "http://letta.test:4500",
      authToken: "test-token",
      model: "test/model",
      models: {
        soclaas: "test/model",
        sonnet: "lmstudio/sonnet4.5",
      },
      requestTimeoutMs: 150_000,
    },
  );
});

test("maps the Sonnet profile to the named local gateway provider", () => {
  const options = lettaOptionsFromEnvironment({
    LLM_MODEL: "sonnet",
    LETTA_QWEN_MODEL: "openai-compatible/qwen3.8:27b",
  });

  assert.deepEqual(options.models, {
    soclaas: "openai-compatible/qwen3.8:27b",
    sonnet: "lmstudio/sonnet",
  });
});

test("rejects an invalid Letta request timeout at startup", () => {
  for (const timeout of ["", "0", "-1", "120000junk", "NaN"]) {
    assert.throws(
      () => lettaOptionsFromEnvironment({ LETTA_APP_SERVER_TIMEOUT_MS: timeout }),
      /LETTA_APP_SERVER_TIMEOUT_MS must be a positive integer/,
    );
  }
});
