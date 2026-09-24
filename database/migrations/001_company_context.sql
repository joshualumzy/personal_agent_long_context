BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS ingestion_batches (
    batch_id UUID PRIMARY KEY,
    dataset_name TEXT NOT NULL,
    dataset_revision TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    artifact_count INTEGER NOT NULL DEFAULT 0 CHECK (artifact_count >= 0),
    rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
    UNIQUE (dataset_name, dataset_revision)
);

CREATE TABLE IF NOT EXISTS employees (
    employee_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    role TEXT,
    department TEXT,
    current_assignments JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_documents (
    source_id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    title TEXT,
    body TEXT NOT NULL,
    simulation_day INTEGER,
    document_date DATE,
    occurred_at TIMESTAMPTZ,
    department TEXT,
    actors JSONB NOT NULL DEFAULT '[]'::jsonb,
    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    original_links JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_incident BOOLEAN NOT NULL DEFAULT FALSE,
    is_external BOOLEAN NOT NULL DEFAULT FALSE,
    dataset_revision TEXT NOT NULL,
    batch_id UUID NOT NULL REFERENCES ingestion_batches(batch_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS source_documents_type_idx
    ON source_documents (source_type);
CREATE INDEX IF NOT EXISTS source_documents_department_idx
    ON source_documents (department);
CREATE INDEX IF NOT EXISTS source_documents_day_idx
    ON source_documents (simulation_day);
CREATE INDEX IF NOT EXISTS source_documents_occurred_at_idx
    ON source_documents (occurred_at);
CREATE INDEX IF NOT EXISTS source_documents_actors_gin
    ON source_documents USING GIN (actors);
CREATE INDEX IF NOT EXISTS source_documents_tags_gin
    ON source_documents USING GIN (tags);

CREATE TABLE IF NOT EXISTS document_chunks (
    chunk_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES source_documents(source_id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    content TEXT NOT NULL,
    search_vector TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(content, ''))
    ) STORED,
    UNIQUE (source_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS document_chunks_search_idx
    ON document_chunks USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS document_chunks_source_idx
    ON document_chunks (source_id);

CREATE TABLE IF NOT EXISTS document_links (
    source_id TEXT NOT NULL REFERENCES source_documents(source_id) ON DELETE CASCADE,
    related_source_id TEXT NOT NULL,
    relationship_type TEXT NOT NULL,
    PRIMARY KEY (source_id, related_source_id, relationship_type)
);

CREATE INDEX IF NOT EXISTS document_links_related_idx
    ON document_links (related_source_id);

COMMIT;
