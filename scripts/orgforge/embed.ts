import { loadEnvFile } from "node:process";
import pg from "pg";
import {
  embeddingProviderFromEnvironment,
  estimateBedrockEmbeddingCostUsd,
  pgVector,
} from "../../src/embeddings.js";

try {
  loadEnvFile();
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const provider = embeddingProviderFromEnvironment();
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const batchSize = 24;
let embedded = 0;

const rawBudget = process.env.BEDROCK_EMBEDDING_BUDGET_USD;
const budgetUsd = Number(rawBudget);
if (!rawBudget || !Number.isFinite(budgetUsd) || budgetUsd <= 0) {
  throw new Error("BEDROCK_EMBEDDING_BUDGET_USD must be a positive dollar amount.");
}

try {
  const preflight = await pool.query<{ chunks: number; characters: string }>(
    `SELECT count(*)::int AS chunks, COALESCE(sum(length(content)), 0)::bigint AS characters
     FROM document_chunks
     WHERE embedding IS NULL OR embedding_model IS DISTINCT FROM $1`,
    [provider.model],
  );
  const pending = preflight.rows[0]!;
  const characters = Number(pending.characters);
  const estimatedCostUsd = estimateBedrockEmbeddingCostUsd(characters);
  console.log(
    `Preflight: ${pending.chunks} chunks, approximately ${characters} characters, estimated Bedrock input cost $${estimatedCostUsd.toFixed(4)} (budget $${budgetUsd.toFixed(2)}).`,
  );
  if (estimatedCostUsd > budgetUsd) {
    throw new Error(
      `Refusing to embed: estimated Bedrock input cost $${estimatedCostUsd.toFixed(4)} exceeds BEDROCK_EMBEDDING_BUDGET_USD=$${budgetUsd.toFixed(2)}.`,
    );
  }

  if (process.argv.includes("--dry-run")) {
    console.log("Dry run complete: no embedding requests were made.");
  } else for (;;) {
    const pending = await pool.query<{ chunk_id: string; content: string }>(
      `SELECT chunk_id, content
       FROM document_chunks
       WHERE embedding IS NULL OR embedding_model IS DISTINCT FROM $1
       ORDER BY chunk_id
       LIMIT $2`,
      [provider.model, batchSize],
    );
    if (pending.rows.length === 0) break;

    const vectors = await provider.embed(
      pending.rows.map((row) => row.content),
      "document",
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const [index, row] of pending.rows.entries()) {
        await client.query(
          `UPDATE document_chunks
           SET embedding = $1::vector, embedding_model = $2, embedded_at = now()
           WHERE chunk_id = $3`,
          [pgVector(vectors[index]!), provider.model, row.chunk_id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    embedded += pending.rows.length;
    console.log(`Embedded ${embedded} document chunks.`);
  }
} finally {
  await pool.end();
}

console.log(`Embedding backfill complete: ${embedded} document chunks using ${provider.model}.`);
