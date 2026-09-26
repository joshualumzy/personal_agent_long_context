import pg from "pg";
import type {
  CompanyKnowledge,
  EmployeeContext,
  Evidence,
  GraphEdge,
  GraphNode,
  GraphSlice,
  GraphSliceRequest,
} from "../company-domain.js";
import type { EmbeddingProvider } from "../embeddings.js";
import { pgVector } from "../embeddings.js";

type GraphNodeRow = {
  ref_key: string;
  node_type: string;
  label: string;
  props: Record<string, unknown> | null;
};

/** graph_nodes.props is denormalized precisely so this needs no extra query. */
function graphNode(row: GraphNodeRow): GraphNode {
  const props = row.props ?? {};
  const day = props.simulation_day;
  return {
    id: row.ref_key,
    type: row.node_type === "actor" ? "actor" : "document",
    label: row.label,
    ...(typeof props.source_type === "string" ? { sourceType: props.source_type } : {}),
    ...(typeof props.category === "string" ? { category: props.category } : {}),
    ...(typeof props.department === "string" && props.department
      ? { department: props.department }
      : {}),
    ...(typeof day === "number" ? { simulationDay: day } : {}),
    ...(props.is_incident === true ? { isIncident: true } : {}),
  };
}

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

  /**
   * A renderable piece of the graph.
   *
   * The whole graph is 22,606 nodes, which no force layout survives, so every
   * slice is bounded. A force-directed SVG stays readable to roughly a hundred
   * nodes; past that the view should cluster rather than draw more, which is why
   * `limit` is capped here instead of trusted from the caller.
   *
   * Unlike retrieval, a slice may include simulation events: the causal chain is
   * the thing worth looking at, and only labels and types cross the wire — never
   * a document body, which is where the oracle material lives.
   */
  async graphSlice(request: GraphSliceRequest): Promise<GraphSlice> {
    const limit = Math.min(Math.max(request.limit ?? 80, 1), 150);

    const documents = request.seed
      ? await this.causalChainNodes(request.seed, request.depth ?? 3, limit)
      : await this.filteredNodes(request, limit);

    if (documents.length === 0) return { nodes: [], edges: [], truncated: false };

    const keys = documents.map((node) => node.id);
    const actors = request.includeActors
      ? await this.actorsOf(keys, limit)
      : [];

    const nodes = [...documents, ...actors];
    const edges = await this.edgesWithin(nodes.map((node) => node.id));
    return { nodes, edges, truncated: documents.length >= limit };
  }

  /** Documents reachable from a seed along 'references', depth- and cycle-bounded. */
  private async causalChainNodes(seed: string, depth: number, limit: number) {
    const bounded = Math.min(Math.max(depth, 1), 6);
    const result = await this.pool.query<GraphNodeRow>(
      `WITH RECURSIVE chain AS (
           SELECT node_id, 0 AS depth, ARRAY[node_id] AS path
           FROM graph_nodes
           WHERE node_type = 'document' AND ref_key = $1
         UNION ALL
           SELECT e.dst_node_id, c.depth + 1, c.path || e.dst_node_id
           FROM chain c
           JOIN graph_edges e ON e.src_node_id = c.node_id
                              AND e.edge_type = 'references'
           WHERE c.depth < $2 AND NOT e.dst_node_id = ANY(c.path)
       )
       SELECT DISTINCT n.ref_key, n.node_type, n.label, n.props
       FROM chain c JOIN graph_nodes n ON n.node_id = c.node_id
       ORDER BY n.ref_key
       LIMIT $3`,
      [seed, bounded, limit],
    );
    return result.rows.map(graphNode);
  }

  private async filteredNodes(request: GraphSliceRequest, limit: number) {
    const conditions = ["node_type = 'document'"];
    const parameters: unknown[] = [];
    const next = () => `$${parameters.length + 1}`;

    if (request.category) {
      conditions.push(`props->>'category' = ${next()}`);
      parameters.push(request.category);
    }
    if (request.sourceType) {
      conditions.push(`props->>'source_type' = ${next()}`);
      parameters.push(request.sourceType);
    }
    if (request.department) {
      conditions.push(`props->>'department' = ${next()}`);
      parameters.push(request.department);
    }
    if (request.incidentsOnly) conditions.push("(props->>'is_incident')::boolean");

    parameters.push(limit);
    const result = await this.pool.query<GraphNodeRow>(
      `SELECT ref_key, node_type, label, props
       FROM graph_nodes
       WHERE ${conditions.join(" AND ")}
       ORDER BY (props->>'simulation_day')::int NULLS LAST, ref_key
       LIMIT $${parameters.length}`,
      parameters,
    );
    return result.rows.map(graphNode);
  }

  private async actorsOf(documentKeys: string[], limit: number) {
    const result = await this.pool.query<GraphNodeRow>(
      `SELECT DISTINCT a.ref_key, a.node_type, a.label, a.props
       FROM graph_nodes d
       JOIN graph_edges e ON e.src_node_id = d.node_id AND e.edge_type = 'involves'
       JOIN graph_nodes a ON a.node_id = e.dst_node_id AND a.node_type = 'actor'
       WHERE d.node_type = 'document' AND d.ref_key = ANY($1::text[])
       ORDER BY a.ref_key
       LIMIT $2`,
      [documentKeys, limit],
    );
    return result.rows.map(graphNode);
  }

  /** Only edges with both ends inside the slice, so the view never dangles one. */
  private async edgesWithin(keys: string[]): Promise<GraphEdge[]> {
    if (keys.length === 0) return [];
    const result = await this.pool.query<{ source: string; target: string; edge_type: string }>(
      `SELECT s.ref_key AS source, t.ref_key AS target, e.edge_type
       FROM graph_edges e
       JOIN graph_nodes s ON s.node_id = e.src_node_id
       JOIN graph_nodes t ON t.node_id = e.dst_node_id
       WHERE s.ref_key = ANY($1::text[]) AND t.ref_key = ANY($1::text[])`,
      [keys],
    );
    return result.rows.map((row) => ({
      source: row.source,
      target: row.target,
      type: row.edge_type,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
