-- Keep the corpus's own `facts` payload.
--
-- Ingestion wrote '{}' into `metadata` and dropped `facts` entirely, which threw
-- away what the corpus states outright: 4,837 rows of `causal_chain`, 2,171 rows
-- naming an actor in full, every `knowledge_domains` list, and the documentation
-- coverage behind the genesis-gap story. The scheduler was left inferring
-- causality from `artifact_ids` that the corpus had already recorded.
--
-- A column of its own rather than reusing `metadata`: these are the corpus's
-- assertions, and `metadata` stays free for anything this system adds later.
-- Conflating the two would leave no way to tell a stated fact from a derived one.
--
-- These facts belong to the causal layer, not the retrieval layer. A simulation
-- event's facts name the ticket a change will spawn and the chain it belongs to —
-- knowledge no employee could have. Chunking already excludes those rows, and
-- `related`/`sources` filter on category, so nothing here reaches an answer as
-- evidence.

BEGIN;

ALTER TABLE source_documents
    ADD COLUMN IF NOT EXISTS facts JSONB NOT NULL DEFAULT '{}'::jsonb;

-- jsonb_path_ops is the smaller, faster index and covers the containment queries
-- these facts are for ("which rows name this domain", "which mention this actor").
CREATE INDEX IF NOT EXISTS source_documents_facts_gin
    ON source_documents USING GIN (facts jsonb_path_ops);

COMMIT;
