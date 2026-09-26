-- Full-corpus OrgForge ingestion plus the deterministic property graph.
--
-- The retrieval layer stays artifact-only: employee-visible Company Artifacts
-- are the only documents that get chunked and embedded. Simulation events are
-- admitted to source_documents as well, because their causal chains are what
-- the scheduler reasons over, but they are never chunked, never embedded, and
-- so can never surface as retrieval evidence.
--
-- The graph is keyed by TEXT so a node can point straight at a natural key:
-- source_documents.source_id for documents, actors.name for actors. Traversal
-- is done in Postgres with recursive CTEs; no external graph database is
-- involved. The graph is also the export surface for the emergent-graph work.
--
-- migrate.ts replays every migration on each run, so everything here is
-- idempotent.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Tell the corpus categories apart.
--    The corpus leaves `category` empty on ~6.6k rows (datadog_metric,
--    dept_plan, dept_plan_reasoning, and a few artifacts), so the importer
--    derives it from doc_type. Downstream routing depends on this column:
--    only 'artifact' rows are chunked and embedded.
-- ---------------------------------------------------------------------------
ALTER TABLE source_documents
    ADD COLUMN IF NOT EXISTS category TEXT;

CREATE INDEX IF NOT EXISTS source_documents_category_idx
    ON source_documents (category);

-- ---------------------------------------------------------------------------
-- 2. Actors, normalized out of source_documents.actors.
--    The corpus names ~76 distinct actors, and not all of them are people:
--    vendors and tools ("Datadog", "AWS Cost Explorer") appear in the same
--    list, which is why actor_kind exists and defaults to 'unknown'-friendly
--    values rather than assuming an employee.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS actors (
    actor_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    role       TEXT,
    dept       TEXT,
    actor_kind TEXT NOT NULL DEFAULT 'employee'
                  CHECK (actor_kind IN ('employee', 'vendor', 'customer', 'unknown')),
    attrs      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS actors_dept_idx ON actors (dept);
CREATE INDEX IF NOT EXISTS actors_kind_idx ON actors (actor_kind);

-- Which actors appear in which document. Normalizing the JSONB list makes
-- "every document involving Jax" an indexed join instead of a JSONB scan.
CREATE TABLE IF NOT EXISTS document_actors (
    source_id TEXT   NOT NULL REFERENCES source_documents(source_id) ON DELETE CASCADE,
    actor_id  BIGINT NOT NULL REFERENCES actors(actor_id)            ON DELETE CASCADE,
    PRIMARY KEY (source_id, actor_id)
);

CREATE INDEX IF NOT EXISTS document_actors_actor_idx ON document_actors (actor_id);

-- ---------------------------------------------------------------------------
-- 3. The deterministic graph.
--    ref_key holds a natural key, so a node needs no surrogate lookup:
--      node_type 'document' -> source_documents.source_id  ("ENG-101")
--      node_type 'actor'    -> actors.name                 ("Jax")
--    props is denormalized on purpose: graph export and front-end rendering
--    then need a single query with no joins.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS graph_nodes (
    node_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    node_type TEXT NOT NULL
                 CHECK (node_type IN ('document', 'actor', 'domain', 'incident')),
    ref_key   TEXT NOT NULL,
    label     TEXT NOT NULL,
    props     JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (node_type, ref_key)
);

CREATE INDEX IF NOT EXISTS graph_nodes_type_idx  ON graph_nodes (node_type);
CREATE INDEX IF NOT EXISTS graph_nodes_props_gin ON graph_nodes USING GIN (props);

-- Directed, typed relationships.
--   'references' document -> document, from the corpus cross-references
--   'involves'   document -> actor
-- The remaining types are reserved for the supplemental registries
-- (domains, incidents) that are not imported yet.
CREATE TABLE IF NOT EXISTS graph_edges (
    edge_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    src_node_id BIGINT NOT NULL REFERENCES graph_nodes(node_id) ON DELETE CASCADE,
    dst_node_id BIGINT NOT NULL REFERENCES graph_nodes(node_id) ON DELETE CASCADE,
    edge_type   TEXT NOT NULL
                   CHECK (edge_type IN (
                       'causal_next', 'references', 'authored_by', 'involves',
                       'owns_domain', 'about_domain', 'triggered_by', 'part_of')),
    weight      DOUBLE PRECISION,
    props       JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (src_node_id, dst_node_id, edge_type)
);

-- Foreign keys are not indexed automatically, and traversal walks both ways.
CREATE INDEX IF NOT EXISTS graph_edges_src_idx  ON graph_edges (src_node_id, edge_type);
CREATE INDEX IF NOT EXISTS graph_edges_dst_idx  ON graph_edges (dst_node_id, edge_type);
CREATE INDEX IF NOT EXISTS graph_edges_type_idx ON graph_edges (edge_type);

COMMIT;
