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
      requestTimeoutMs: 150_000,
    },
  );
});

test("rejects an invalid Letta request timeout at startup", () => {
  for (const timeout of ["", "0", "-1", "120000junk", "NaN"]) {
    assert.throws(
      () => lettaOptionsFromEnvironment({ LETTA_APP_SERVER_TIMEOUT_MS: timeout }),
      /LETTA_APP_SERVER_TIMEOUT_MS must be a positive integer/,
    );
  }
});
