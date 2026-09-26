import pg from "pg";
import type { CompanyKnowledge, EmployeeContext, Evidence } from "../company-domain.js";
import type { EmbeddingProvider } from "../embeddings.js";
import { pgVector } from "../embeddings.js";

type EvidenceRow = {
  source_id: string;
  source_type: string;
  title: string | null;
  excerpt: string;
  occurred_at: Date | null;
  department: string | null;
  score: number | null;
};

function evidence(row: EvidenceRow): Evidence {
  return {
    sourceId: row.source_id,
    sourceType: row.source_type,
    title: row.title ?? row.source_id,
    excerpt: row.excerpt,
    ...(row.occurred_at ? { occurredAt: row.occurred_at.toISOString() } : {}),
    ...(row.department ? { department: row.department } : {}),
    ...(row.score === null ? {} : { score: Number(row.score) }),
  };
}

/** Reciprocal-rank fusion gives exact keyword matches and semantic matches equal input weight. */
function fuseEvidence(keyword: Evidence[], semantic: Evidence[], limit: number): Evidence[] {
  const ranked = new Map<string, { item: Evidence; score: number }>();
  for (const list of [keyword, semantic]) {
    list.forEach((item, index) => {
      const current = ranked.get(item.sourceId);
      const score = (current?.score ?? 0) + 1 / (60 + index + 1);
      ranked.set(item.sourceId, { item: { ...item, score }, score });
    });
  }
  return [...ranked.values()]
    .sort((left, right) => right.score - left.score || left.item.sourceId.localeCompare(right.item.sourceId))
    .slice(0, limit)
    .map(({ item }) => item);
}

/**
 * Company evidence out of Postgres.
 *
 * Every method here returns artifacts only. `source_documents` also holds the
 * simulation's own event rows, whose bodies state things no employee could know
 * — detected knowledge gaps, causal chains, the ticket a change will spawn.
 * Chunking already excludes them, so keyword and semantic search cannot reach
 * them, but `related` and `sources` read document bodies directly and so filter
 * on category themselves.
 */
export class PostgresCompanyKnowledge implements CompanyKnowledge {
  readonly pool: pg.Pool;

  constructor(databaseUrl: string, private readonly embeddings?: EmbeddingProvider) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  }

  async employee(employeeId: string): Promise<EmployeeContext | null> {
    const result = await this.pool.query<{
      employee_id: string;
      display_name: string;
      role: string | null;
      department: string | null;
      current_assignments: unknown;
    }>(
      `SELECT employee_id, display_name, role, department, current_assignments
       FROM employees WHERE employee_id = $1`,
      [employeeId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      employeeId: row.employee_id,
      displayName: row.display_name,
      ...(row.role ? { role: row.role } : {}),
      ...(row.department ? { department: row.department } : {}),
      currentAssignments: Array.isArray(row.current_assignments)
        ? row.current_assignments.filter((value): value is string => typeof value === "string")
        : [],
    };
  }

  async search(query: string, limit: number): Promise<Evidence[]> {
    const normalizedLimit = Math.min(Math.max(limit, 1), 12);
    const keyword = this.keywordSearch(query, normalizedLimit);
    if (!this.embeddings) return keyword;

    try {
      const [keywordResult, vectors] = await Promise.all([
        keyword,
        this.embeddings.embed([query], "query"),
      ]);
      const semanticResult = await this.semanticSearch(vectors[0]!, normalizedLimit);
      return fuseEvidence(keywordResult, semanticResult, normalizedLimit);
    } catch {
      // Keyword retrieval remains available when a hosted embedding provider is unavailable.
      return keyword;
    }
  }

  private async keywordSearch(query: string, limit: number): Promise<Evidence[]> {
    const result = await this.pool.query<EvidenceRow>(
      `WITH requested AS (SELECT websearch_to_tsquery('english', $1) AS query),
       ranked AS (
         SELECT c.source_id, c.content,
                ts_rank_cd(c.search_vector, requested.query) AS score,
                row_number() OVER (
                  PARTITION BY c.source_id
                  ORDER BY ts_rank_cd(c.search_vector, requested.query) DESC
                ) AS source_rank
         FROM document_chunks c, requested
         WHERE c.search_vector @@ requested.query
       )
       SELECT d.source_id, d.source_type, d.title,
              ranked.content AS excerpt, d.occurred_at, d.department, ranked.score
       FROM ranked JOIN source_documents d USING (source_id)
       WHERE ranked.source_rank = 1
       ORDER BY ranked.score DESC, d.occurred_at DESC NULLS LAST
       LIMIT $2`,
      [query, limit],
    );
    return result.rows.map(evidence);
  }

  private async semanticSearch(vector: number[], limit: number): Promise<Evidence[]> {
    const result = await this.pool.query<EvidenceRow>(
      `WITH ranked AS (
         SELECT c.source_id, c.content,
                1 - (c.embedding <=> $1::vector) AS score,
                row_number() OVER (
                  PARTITION BY c.source_id
                  ORDER BY c.embedding <=> $1::vector ASC
                ) AS source_rank
         FROM document_chunks c
         WHERE c.embedding IS NOT NULL
       )
       SELECT d.source_id, d.source_type, d.title,
              ranked.content AS excerpt, d.occurred_at, d.department, ranked.score
       FROM ranked JOIN source_documents d USING (source_id)
       WHERE ranked.source_rank = 1
       ORDER BY ranked.score DESC, d.occurred_at DESC NULLS LAST
       LIMIT $2`,
      [pgVector(vector), limit],
    );
    return result.rows.map(evidence);
  }

  async related(sourceIds: string[], limit: number): Promise<Evidence[]> {
    if (sourceIds.length === 0) return [];
    const result = await this.pool.query<EvidenceRow>(
      `WITH related_ids AS (
         SELECT related_source_id AS source_id
         FROM document_links WHERE source_id = ANY($1::text[])
         UNION
         SELECT source_id
         FROM document_links WHERE related_source_id = ANY($1::text[])
       )
       SELECT DISTINCT d.source_id, d.source_type, d.title,
              left(d.body, 1800) AS excerpt, d.occurred_at, d.department,
              NULL::double precision AS score
       FROM related_ids r JOIN source_documents d USING (source_id)
       WHERE d.category = 'artifact'
       ORDER BY d.occurred_at DESC NULLS LAST
       LIMIT $2`,
      [sourceIds, Math.min(Math.max(limit, 1), 12)],
    );
    return result.rows.map(evidence);
  }

  /**
   * Artifacts reached by stepping through the event that produced the seeds.
   *
   * In this corpus a simulation event references the artifacts it produced, and
   * artifacts never reference events, so siblings are found by following the
   * incoming edges of a seed to the events that caused it, then the outgoing
   * edges of those events. The events are only ever traversed; what comes back
   * is artifacts, so nothing an employee could not have seen is returned.
   *
   * Two hops exactly. A third hop leaves the shared cause behind and the
   * connection stops meaning anything.
   */
  async relatedThroughEvents(sourceIds: string[], limit: number): Promise<Evidence[]> {
    if (sourceIds.length === 0) return [];
    const result = await this.pool.query<EvidenceRow>(
      `WITH seeds AS (
         SELECT node_id FROM graph_nodes
         WHERE node_type = 'document' AND ref_key = ANY($1::text[])
       ),
       causes AS (
         SELECT DISTINCT e.src_node_id AS node_id
         FROM graph_edges e JOIN seeds ON e.dst_node_id = seeds.node_id
         WHERE e.edge_type = 'references'
       ),
       siblings AS (
         SELECT DISTINCT e.dst_node_id AS node_id
         FROM graph_edges e JOIN causes ON e.src_node_id = causes.node_id
         WHERE e.edge_type = 'references'
       )
       SELECT d.source_id, d.source_type, d.title,
              left(d.body, 1800) AS excerpt, d.occurred_at, d.department,
              NULL::double precision AS score
       FROM siblings
       JOIN graph_nodes n ON n.node_id = siblings.node_id AND n.node_type = 'document'
       JOIN source_documents d ON d.source_id = n.ref_key
       WHERE d.category = 'artifact'
         AND NOT (d.source_id = ANY($1::text[]))
       ORDER BY d.occurred_at DESC NULLS LAST
       LIMIT $2`,
      [sourceIds, Math.min(Math.max(limit, 1), 12)],
    );
    return result.rows.map(evidence);
  }

  async sources(sourceIds: string[]): Promise<Evidence[]> {
    if (sourceIds.length === 0) return [];
    const result = await this.pool.query<EvidenceRow>(
      `SELECT source_id, source_type, title, body AS excerpt,
              occurred_at, department, NULL::double precision AS score
       FROM source_documents
       WHERE source_id = ANY($1::text[]) AND category = 'artifact'`,
      [sourceIds],
    );
    return result.rows.map(evidence);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
