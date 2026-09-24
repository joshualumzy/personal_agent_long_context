import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BEDROCK_TITAN_V2_MODEL,
  BedrockEmbeddingProvider,
  EMBEDDING_DIMENSIONS,
  embeddingProviderFromEnvironment,
  estimateBedrockEmbeddingCostUsd,
  pgVector,
} from "../src/embeddings.js";

test("serializes only the configured pgvector dimension", () => {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.25);
  assert.match(pgVector(vector), /^\[0\.25,0\.25,/);
  assert.throws(() => pgVector([0.25]), /1024-dimension/);
});

test("configures Amazon Bedrock Titan V2 with its 1024-dimension model", () => {
  const defaults = new BedrockEmbeddingProvider({ region: "us-east-1" });
  assert.equal(defaults.model, BEDROCK_TITAN_V2_MODEL);

  const configured = embeddingProviderFromEnvironment({
    AWS_REGION: "ap-southeast-1",
    EMBEDDINGS_MODEL: "amazon.titan-embed-text-v2:0",
  });
  assert.equal(configured.model, BEDROCK_TITAN_V2_MODEL);

  assert.throws(
    () => embeddingProviderFromEnvironment({ AWS_REGION: "us-east-1", EMBEDDINGS_PROVIDER: "huggingface" }),
    /must be 'bedrock'/,
  );
});

test("estimates Titan V2 input cost before the backfill begins", () => {
  assert.equal(estimateBedrockEmbeddingCostUsd(4_700_000), 0.02);
  assert.throws(() => estimateBedrockEmbeddingCostUsd(-1), /non-negative/);
});
