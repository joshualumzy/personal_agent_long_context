-- =============================================================================
-- OrgForge Knowledge Base — PostgreSQL Schema
-- Personal Assistant Hackathon
--
-- Design principles (per postgresql-table-design skill):
--   • Normalize to 3NF; denormalize only where reads are proven hot.
--   • BIGINT GENERATED ALWAYS AS IDENTITY for surrogate keys.
--   • TIMESTAMPTZ for all event time; TEXT + CHECK over varchar(n).
--   • Index every FK column and every real query access path (PG does NOT
--     auto-index FKs).
--   • JSONB (GIN) only for genuinely semi-structured attributes.
--
-- Three storage roles in ONE PostgreSQL instance:
--   1. Relational core  — artifacts, sim_events, actors, domains, assignments
--   2. Vector search    — pgvector column on artifact bodies (RAG / Letta)
--   3. Graph layer       — explicit nodes/edges tables, exportable to Neo4j
--                          for the causal-chain visualization demo
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector: semantic retrieval
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- fuzzy title/name lookups (optional)


-- =============================================================================
-- SECTION 1 — RELATIONAL CORE
-- Mirrors the OrgForge corpus schema (one row per document) plus the
-- structured reference/ground-truth tables from the supplemental files.
-- =============================================================================

-- Small, stable enum-like sets are modelled as TEXT + CHECK so they can evolve
-- during the hackathon without ALTER TYPE churn.

-- -----------------------------------------------------------------------------
-- 1.1  actors — the ~76 unique people (employees, vendors, customers)
--       Derived from the corpus `actors` field + sim_config personas.
-- -----------------------------------------------------------------------------
CREATE TABLE actors (
    actor_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,          -- "Jax", "Nora", "Bill"
    role          TEXT,                           -- "CTO", "iOS Engineer"
    dept          TEXT,                           -- nullable: externals have none
    actor_kind    TEXT NOT NULL DEFAULT 'employee'
                     CHECK (actor_kind IN ('employee','vendor','customer','unknown')),
    is_departed   BOOLEAN NOT NULL DEFAULT FALSE, -- genesis-gap employees
    departed_date DATE,                            -- Bill: 2024-06-01
    attrs         JSONB NOT NULL DEFAULT '{}',    -- persona archetype, tenure, style
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX actors_dept_idx        ON actors (dept);
CREATE INDEX actors_kind_idx        ON actors (actor_kind);
CREATE INDEX actors_name_trgm_idx   ON actors USING GIN (name gin_trgm_ops);
CREATE INDEX actors_attrs_gin       ON actors USING GIN (attrs);

-- -----------------------------------------------------------------------------
-- 1.2  documents — the 22,530 corpus rows (artifacts + sim_events + config)
--       This is the central table. It is event/log-shaped, so the natural
--       key is the OrgForge `doc_id`; we still add a surrogate BIGINT PK for
--       compact FKs from the graph tables.
-- -----------------------------------------------------------------------------
CREATE TABLE documents (
    document_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doc_id        TEXT NOT NULL UNIQUE,           -- "ORG-100", "CONF-ENG-001", "EVT-1-..."
    category      TEXT NOT NULL
                     CHECK (category IN ('artifact','sim_event','sim_config')),
    doc_type      TEXT NOT NULL,                  -- 'jira','slack','confluence','datadog_metric'...
                                                   -- ~57 values; kept as TEXT (evolving set)
    title         TEXT,
    body          TEXT,                            -- full text; source for embeddings

    -- Temporal coherence: every row carries day/date/timestamp
    sim_day       INTEGER,                         -- 1-indexed sim day (can be negative: genesis)
    doc_date      DATE,
    ts            TIMESTAMPTZ,                     -- ms-accurate event time

    dept          TEXT,                            -- owning dept; empty/NULL if cross-dept
    is_incident   BOOLEAN NOT NULL DEFAULT FALSE,
    is_external   BOOLEAN NOT NULL DEFAULT FALSE,

    -- Semi-structured payloads from the corpus (kept as JSONB, queried via GIN)
    tags          JSONB NOT NULL DEFAULT '[]',    -- ["jira","vendor","causal_chain"]
    artifact_ids  JSONB NOT NULL DEFAULT '{}',    -- {"jira":"ORG-100","source_email":"..."}
    facts         JSONB NOT NULL DEFAULT '{}',    -- raw SimEvent facts (empty for artifacts)

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Access paths we actually query:
CREATE INDEX documents_doc_type_idx   ON documents (doc_type);
CREATE INDEX documents_category_idx   ON documents (category);
CREATE INDEX documents_sim_day_idx    ON documents (sim_day);           -- "what happened on day N"
CREATE INDEX documents_ts_idx         ON documents (ts);                -- timeline scans
CREATE INDEX documents_dept_idx       ON documents (dept);
CREATE INDEX documents_incident_idx   ON documents (document_id) WHERE is_incident;  -- partial: hot subset
CREATE INDEX documents_external_idx   ON documents (document_id) WHERE is_external;
CREATE INDEX documents_tags_gin       ON documents USING GIN (tags jsonb_path_ops);
CREATE INDEX documents_artids_gin     ON documents USING GIN (artifact_ids jsonb_path_ops);
CREATE INDEX documents_facts_gin      ON documents USING GIN (facts);
CREATE INDEX documents_title_trgm     ON documents USING GIN (title gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- 1.3  document_actors — junction: which actors appear in each document
--       (M:N; the corpus stores actors as a JSON list — we normalize it so
--        "all docs involving Jax" is an indexed join, not a JSONB scan.)
-- -----------------------------------------------------------------------------
CREATE TABLE document_actors (
    document_id BIGINT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    actor_id    BIGINT NOT NULL REFERENCES actors(actor_id)       ON DELETE CASCADE,
    PRIMARY KEY (document_id, actor_id)
);
CREATE INDEX document_actors_actor_idx ON document_actors (actor_id);  -- reverse lookup

-- -----------------------------------------------------------------------------
-- 1.4  domains — the 10 knowledge domains + genesis-gap ownership history
--       Source: domain_registry.json
-- -----------------------------------------------------------------------------
CREATE TABLE domains (
    domain_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE,          -- "TitanDB", "legacy auth service"
    is_orphaned    BOOLEAN NOT NULL DEFAULT FALSE,
    current_owner  BIGINT REFERENCES actors(actor_id) ON DELETE SET NULL,
    attrs          JSONB NOT NULL DEFAULT '{}',   -- owner history, coverage curve
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX domains_owner_idx ON domains (current_owner);
CREATE INDEX domains_attrs_gin ON domains USING GIN (attrs);

-- -----------------------------------------------------------------------------
-- 1.5  domain_coverage — per-sim-day documentation coverage (time-series)
--       Lets you answer "who owned TitanDB / how documented was it on day N".
-- -----------------------------------------------------------------------------
CREATE TABLE domain_coverage (
    domain_id            BIGINT NOT NULL REFERENCES domains(domain_id) ON DELETE CASCADE,
    sim_day              INTEGER NOT NULL,
    documentation_pct    NUMERIC(5,4) NOT NULL CHECK (documentation_pct BETWEEN 0 AND 1),
    owner_id             BIGINT REFERENCES actors(actor_id) ON DELETE SET NULL,
    PRIMARY KEY (domain_id, sim_day)
);

-- -----------------------------------------------------------------------------
-- 1.6  incidents — the 12 P1/P2 incidents with open/resolve timestamps
--       Source: simulation_snapshot.json (oracle for eval).
-- -----------------------------------------------------------------------------
CREATE TABLE incidents (
    incident_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ext_key       TEXT UNIQUE,                    -- external incident id if present
    title         TEXT NOT NULL,
    severity      TEXT CHECK (severity IN ('P1','P2','P3')),
    opened_ts     TIMESTAMPTZ NOT NULL,
    resolved_ts   TIMESTAMPTZ,                    -- NULL while open
    root_domain   BIGINT REFERENCES domains(domain_id) ON DELETE SET NULL,  -- e.g. TitanDB
    attrs         JSONB NOT NULL DEFAULT '{}',
    CHECK (resolved_ts IS NULL OR resolved_ts >= opened_ts)
);
CREATE INDEX incidents_opened_idx ON incidents (opened_ts);
CREATE INDEX incidents_domain_idx ON incidents (root_domain);
CREATE INDEX incidents_open_idx   ON incidents (incident_id) WHERE resolved_ts IS NULL;

-- -----------------------------------------------------------------------------
-- 1.7  assignment_scores — per-(engineer, ticket, day) scoring breakdown
--       Source: assignment_scores.parquet. Powers the S3 recruitment/
--       matching demo ("was this assignment optimal given org state?").
--       Insert-heavy, wide, one row per triple — no surrogate PK needed.
-- -----------------------------------------------------------------------------
CREATE TABLE assignment_scores (
    engineer_id           BIGINT NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
    ticket_doc_id         BIGINT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    sim_day               INTEGER NOT NULL,
    skill_match           DOUBLE PRECISION,       -- embedding cosine similarity
    inverse_stress        DOUBLE PRECISION,
    centrality_penalty    DOUBLE PRECISION,       -- betweenness centrality penalty
    recency_bonus         DOUBLE PRECISION,
    composite_score       DOUBLE PRECISION,
    PRIMARY KEY (engineer_id, ticket_doc_id, sim_day)
);
CREATE INDEX assignment_scores_ticket_idx ON assignment_scores (ticket_doc_id);
CREATE INDEX assignment_scores_day_idx    ON assignment_scores (sim_day);


-- =============================================================================
-- SECTION 2 — VECTOR SEARCH (pgvector)
-- Semantic retrieval over document bodies. This backs the S1 knowledge-base
-- assistant and S2 meeting-copilot RAG. If Letta manages Archival Memory it
-- can point at this same table/extension — one store, no separate vector DB.
--
-- Dimension: set to your embedding model. Examples:
--   • Amazon Titan Text Embeddings v2 -> 1024
--   • OpenAI text-embedding-3-small   -> 1536
-- Adjust vector(N) below to match.
-- =============================================================================
CREATE TABLE document_embeddings (
    document_id BIGINT PRIMARY KEY REFERENCES documents(document_id) ON DELETE CASCADE,
    model       TEXT NOT NULL,                    -- provenance of the vector
    embedding   vector(1024) NOT NULL,            -- <-- match your model dimension
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HNSW index for approximate nearest-neighbour. cosine distance (<=>) is the
-- usual choice for normalized text embeddings; swap the opclass if you use L2.
CREATE INDEX document_embeddings_hnsw
    ON document_embeddings
    USING hnsw (embedding vector_cosine_ops);

-- Typical query (RAG top-k over docs visible on/before a given sim day):
--   SELECT d.doc_id, d.title
--   FROM document_embeddings e
--   JOIN documents d USING (document_id)
--   WHERE d.sim_day <= :as_of_day
--   ORDER BY e.embedding <=> :query_vec
--   LIMIT 8;


-- =============================================================================
-- SECTION 3 — GRAPH LAYER  (kept for the causal-chain visualization demo)
--
-- OrgForge's `artifact_ids` cross-references, actor participation, and
-- domain ownership form a property graph. We model it EXPLICITLY here for two
-- reasons:
--   (a) In-Postgres traversal via recursive CTEs (no extra DB at query time).
--   (b) A clean, stable export surface -> Neo4j / vis.js / D3 for the demo.
--
-- Nodes and edges are generic so any entity type can participate. Node payload
-- is denormalized into JSONB `props` specifically to make graph export and
-- front-end rendering a single query with no joins.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 3.1  graph_nodes — one row per graph entity (document, actor, domain, incident)
-- -----------------------------------------------------------------------------
CREATE TABLE graph_nodes (
    node_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    node_type   TEXT NOT NULL
                   CHECK (node_type IN ('document','actor','domain','incident')),
    -- Reference back to the owning row in exactly one core table.
    ref_id      BIGINT NOT NULL,          -- documents.document_id / actors.actor_id / ...
    label       TEXT NOT NULL,            -- display label for the viz
    props       JSONB NOT NULL DEFAULT '{}',  -- denormalized attrs for rendering
    UNIQUE (node_type, ref_id)            -- one node per underlying entity
);
CREATE INDEX graph_nodes_type_idx  ON graph_nodes (node_type);
CREATE INDEX graph_nodes_props_gin ON graph_nodes USING GIN (props);

-- -----------------------------------------------------------------------------
-- 3.2  graph_edges — directed, typed relationships between nodes
--       edge_type captures the OrgForge semantics:
--         'causal_next'    document -> document  (artifact_ids causal chain)
--         'references'     document -> document  (generic cross-ref)
--         'authored_by'    document -> actor
--         'involves'       document -> actor
--         'owns_domain'    actor    -> domain
--         'about_domain'   document -> domain
--         'triggered_by'   incident -> domain    (semantic-similarity match)
--         'part_of'        document -> incident
-- -----------------------------------------------------------------------------
CREATE TABLE graph_edges (
    edge_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    src_node_id BIGINT NOT NULL REFERENCES graph_nodes(node_id) ON DELETE CASCADE,
    dst_node_id BIGINT NOT NULL REFERENCES graph_nodes(node_id) ON DELETE CASCADE,
    edge_type   TEXT NOT NULL
                   CHECK (edge_type IN (
                       'causal_next','references','authored_by','involves',
                       'owns_domain','about_domain','triggered_by','part_of')),
    weight      DOUBLE PRECISION,         -- e.g. relationship-graph edge weight
    props       JSONB NOT NULL DEFAULT '{}',
    -- No parallel duplicate edges of the same type between the same pair:
    UNIQUE (src_node_id, dst_node_id, edge_type)
);
-- FK columns MUST be indexed manually for traversal in both directions:
CREATE INDEX graph_edges_src_idx  ON graph_edges (src_node_id, edge_type);
CREATE INDEX graph_edges_dst_idx  ON graph_edges (dst_node_id, edge_type);
CREATE INDEX graph_edges_type_idx ON graph_edges (edge_type);


-- =============================================================================
-- SECTION 4 — WORKED QUERIES
-- =============================================================================

-- 4.1  Causal-chain traversal IN POSTGRES (no graph DB needed at query time).
--      Walk the 'causal_next' / 'references' edges forward from a seed doc,
--      cycle-safe, depth-bounded — this is what feeds the visualization.
--
--   WITH RECURSIVE chain AS (
--       SELECT n.node_id, n.label, 0 AS depth, ARRAY[n.node_id] AS path
--       FROM graph_nodes n
--       JOIN documents d ON d.document_id = n.ref_id AND n.node_type = 'document'
--       WHERE d.doc_id = :seed_doc_id            -- e.g. an incident postmortem
--     UNION ALL
--       SELECT e.dst_node_id, dn.label, c.depth + 1, c.path || e.dst_node_id
--       FROM chain c
--       JOIN graph_edges e ON e.src_node_id = c.node_id
--                          AND e.edge_type IN ('causal_next','references','triggered_by')
--       JOIN graph_nodes dn ON dn.node_id = e.dst_node_id
--       WHERE c.depth < 8                        -- depth guard
--         AND NOT e.dst_node_id = ANY(c.path)    -- cycle guard
--   )
--   SELECT DISTINCT node_id, label, depth FROM chain ORDER BY depth;

-- 4.2  Export the sub-graph for the front-end (nodes + edges in the reached set).
--      Run 4.1 as a CTE, collect node_ids, then:
--   SELECT edge_id, src_node_id, dst_node_id, edge_type, weight
--   FROM graph_edges
--   WHERE src_node_id = ANY(:reached) AND dst_node_id = ANY(:reached);

-- 4.3  Genesis-gap trace (the signature OrgForge chain):
--      incident -> triggered_by -> domain -> owns_domain(reverse) -> departed actor.
--   SELECT dom.name AS domain, a.name AS former_owner, a.departed_date
--   FROM incidents i
--   JOIN domains dom       ON dom.domain_id = i.root_domain
--   LEFT JOIN actors a     ON a.actor_id = dom.current_owner  -- or via coverage history
--   WHERE i.incident_id = :incident_id;
