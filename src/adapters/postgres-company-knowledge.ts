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
  node_subtype: string | null;
  label: string;
  props: Record<string, unknown> | null;
};

const GRAPH_NODE_TYPES = ["person", "organization", "item", "event", "document"] as const;

function isGraphNodeType(value: string): value is GraphNode["type"] {
  return (GRAPH_NODE_TYPES as readonly string[]).includes(value);
}

/** graph_nodes.props is denormalized precisely so this needs no extra query. */
function graphNode(row: GraphNodeRow): GraphNode {
  const props = row.props ?? {};
  const day = props.simulation_day;
  return {
    id: row.ref_key,
    type: isGraphNodeType(row.node_type) ? row.node_type : "item",
    label: row.label,
    ...(row.node_subtype ? { subtype: row.node_subtype } : {}),
    ...(typeof props.source_type === "string" ? { sourceType: props.source_type } : {}),
    ...(typeof props.category === "string" ? { category: props.category } : {}),
    ...(typeof props.department === "string" && props.department
      ? { department: props.department }
      : {}),
    ...(typeof day === "number" ? { simulationDay: day } : {}),
    ...(props.is_incident === true ? { isIncident: true } : {}),
    ...(row.props ? { props: row.props } : {}),
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
   * In this corpus an event produces the artifacts it results in — a ticket
   * lifecycle event produces the jira/PR item it is about, a design discussion
   * produces the confluence page it spawned — and artifacts never produce
   * events back. Siblings are found by following the incoming 'produced' edges
   * of a seed to the events that made it, then those events' other outgoing
   * 'produced' edges. The events are only ever traversed; what comes back is
   * artifacts (document or item), so nothing an employee could not have seen
   * is returned.
   *
   * Two hops exactly. A third hop leaves the shared cause behind and the
   * connection stops meaning anything.
   */
  async relatedThroughEvents(sourceIds: string[], limit: number): Promise<Evidence[]> {
    if (sourceIds.length === 0) return [];
    const result = await this.pool.query<EvidenceRow>(
      `WITH seeds AS (
         SELECT node_id FROM graph_nodes
         WHERE node_type IN ('document', 'item') AND ref_key = ANY($1::text[])
       ),
       causes AS (
         SELECT DISTINCT e.src_node_id AS node_id
         FROM graph_edges e JOIN seeds ON e.dst_node_id = seeds.node_id
         WHERE e.edge_type = 'produced'
       ),
       siblings AS (
         SELECT DISTINCT e.dst_node_id AS node_id
         FROM graph_edges e JOIN causes ON e.src_node_id = causes.node_id
         WHERE e.edge_type = 'produced'
       )
       SELECT d.source_id, d.source_type, d.title,
              left(d.body, 1800) AS excerpt, d.occurred_at, d.department,
              NULL::double precision AS score
       FROM siblings
       JOIN graph_nodes n ON n.node_id = siblings.node_id
                          AND n.node_type IN ('document', 'item')
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
      : request.edgeTypes && request.edgeTypes.length > 0
        ? await this.nodesByEdgeTypes(request.edgeTypes, limit)
        : await this.filteredNodes(request, limit);

    if (documents.length === 0) return { nodes: [], edges: [], truncated: false };

    const keys = documents.map((node) => node.id);
    const actors = request.includeActors
      ? await this.actorsOf(keys, limit)
      : [];

    const nodes = [...documents, ...actors];
    const edges = await this.edgesWithin(nodes.map((node) => node.id), request.edgeTypes);
    return { nodes, edges, truncated: documents.length >= limit };
  }

  /** Nodes reachable from a seed along 'produced'/'escalated_via', depth- and
   * cycle-bounded. The seed is looked up by ref_key alone — an incident's seed
   * is an 'event' node, a confluence page's is a 'document' — so this does not
   * assume what kind of node the caller is starting from. */
  private async causalChainNodes(seed: string, depth: number, limit: number) {
    const bounded = Math.min(Math.max(depth, 1), 6);
    const result = await this.pool.query<GraphNodeRow>(
      `WITH RECURSIVE chain AS (
           SELECT node_id, 0 AS depth, ARRAY[node_id] AS path
           FROM graph_nodes
           WHERE ref_key = $1
         UNION ALL
           SELECT e.dst_node_id, c.depth + 1, c.path || e.dst_node_id
           FROM chain c
           JOIN graph_edges e ON e.src_node_id = c.node_id
                              AND e.edge_type IN ('produced', 'escalated_via')
           WHERE c.depth < $2 AND NOT e.dst_node_id = ANY(c.path)
       )
       SELECT DISTINCT n.ref_key, n.node_type, n.node_subtype, n.label, n.props
       FROM chain c JOIN graph_nodes n ON n.node_id = c.node_id
       ORDER BY n.ref_key
       LIMIT $3`,
      [seed, bounded, limit],
    );
    return result.rows.map(graphNode);
  }

  private async filteredNodes(request: GraphSliceRequest, limit: number) {
    // Filtering by category/sourceType/department/incident is about an
    // artifact or an event, never a person node — actors carry none of those
    // props — so this excludes 'person' rather than assuming 'document'.
    const conditions = ["node_type <> 'person'"];
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
    if (request.subtype) {
      conditions.push(`node_subtype = ${next()}`);
      parameters.push(request.subtype);
    }
    if (request.incidentsOnly) conditions.push("(props->>'is_incident')::boolean");

    parameters.push(limit);
    const result = await this.pool.query<GraphNodeRow>(
      // node_subtype has to be selected, not just filtered on: the view tells
      // an incident from a sprint plan by it, and leaving it out of the SELECT
      // silently stripped it from every node this path returned.
      `SELECT ref_key, node_type, node_subtype, label, props
       FROM graph_nodes
       WHERE ${conditions.join(" AND ")}
       ORDER BY (props->>'simulation_day')::int NULLS LAST, ref_key
       LIMIT $${parameters.length}`,
      parameters,
    );
    return result.rows.map(graphNode);
  }

  /**
   * Every node touched by an edge of one of these types, for a layer tab
   * that is about a relationship kind rather than a seed or a category —
   * the person layer (['involves']) and the causal layer
   * (['caused_by','escalated_via']) both select this way: there is no
   * single node to start from, the edge type itself is the filter.
   */
  private async nodesByEdgeTypes(edgeTypes: string[], limit: number) {
    const result = await this.pool.query<GraphNodeRow>(
      `SELECT DISTINCT n.ref_key, n.node_type, n.node_subtype, n.label, n.props
       FROM graph_edges e
       JOIN graph_nodes n ON n.node_id IN (e.src_node_id, e.dst_node_id)
       WHERE e.edge_type = ANY($1::text[])
       ORDER BY n.ref_key
       LIMIT $2`,
      [edgeTypes, limit],
    );
    return result.rows.map(graphNode);
  }

  private async actorsOf(nodeKeys: string[], limit: number) {
    const result = await this.pool.query<GraphNodeRow>(
      `SELECT DISTINCT a.ref_key, a.node_type, a.node_subtype, a.label, a.props
       FROM graph_nodes d
       JOIN graph_edges e ON e.src_node_id = d.node_id AND e.edge_type = 'involves'
       JOIN graph_nodes a ON a.node_id = e.dst_node_id AND a.node_type = 'person'
       WHERE d.ref_key = ANY($1::text[])
       ORDER BY a.ref_key
       LIMIT $2`,
      [nodeKeys, limit],
    );
    return result.rows.map(graphNode);
  }

  /** Only edges with both ends inside the slice, so the view never dangles
   * one. edgeTypes narrows it further when a layer tab asked for one — the
   * person layer's nodes are still only reachable by 'involves', but two of
   * them could also share an unrelated edge type, which the tab should not
   * show. */
  private async edgesWithin(keys: string[], edgeTypes?: string[]): Promise<GraphEdge[]> {
    if (keys.length === 0) return [];
    const parameters: unknown[] = [keys];
    let typeFilter = "";
    if (edgeTypes && edgeTypes.length > 0) {
      parameters.push(edgeTypes);
      typeFilter = ` AND e.edge_type = ANY($${parameters.length}::text[])`;
    }
    const result = await this.pool.query<{ source: string; target: string; edge_type: string }>(
      `SELECT s.ref_key AS source, t.ref_key AS target, e.edge_type
       FROM graph_edges e
       JOIN graph_nodes s ON s.node_id = e.src_node_id
       JOIN graph_nodes t ON t.node_id = e.dst_node_id
       WHERE s.ref_key = ANY($1::text[]) AND t.ref_key = ANY($1::text[])${typeFilter}`,
      parameters,
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
