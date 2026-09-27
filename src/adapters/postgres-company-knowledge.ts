import pg from "pg";
import type {
  CompanyKnowledge,
  DayPlanEntry,
  RosterEntry,
  TodoItem,
  EmployeeContext,
  EmployeePersona,
  Evidence,
  GraphEdge,
  GraphNode,
  GraphSlice,
  GraphNodeType,
  GraphExpandRequest,
  GraphQueryRequest,
} from "../company-domain.js";
import {
  budgetNeighbours,
  categoryOf,
  isGraphCategory,
  parseClusterId,
  type GraphCategory,
  type NeighbourCandidate,
} from "../graph-neighbourhood.js";
import { GRAPH_NODE_TYPES, GRAPH_VIEWS, graphNodeId, parseGraphNodeId } from "../company-domain.js";
import type { GraphViewName } from "../company-domain.js";
import type { EmbeddingProvider } from "../embeddings.js";
import { pgVector } from "../embeddings.js";
import { verifyPassword } from "../auth.js";
import { asOfCutoff, type AsOf } from "../as-of.js";
import { assembleHealth, HEALTH_WINDOW_DAYS, type DomainHealth, type DomainHealthInputs } from "../domain-health.js";

type GraphNodeRow = {
  /** BIGINT, which pg returns as a string. Used only inside the adapter: the
   * wire identity is graphNodeId(node_type, ref_key). */
  node_id: string;
  ref_key: string;
  node_type: string;
  node_subtype: string | null;
  label: string;
  props: Record<string, unknown> | null;
};

function isGraphNodeType(value: string): value is GraphNodeType {
  return (GRAPH_NODE_TYPES as readonly string[]).includes(value);
}

function wireNodeType(nodeType: string): GraphNodeType {
  return isGraphNodeType(nodeType) ? nodeType : "item";
}

/** graph_nodes.props is denormalized precisely so this needs no extra query. */
function graphNode(row: GraphNodeRow): GraphNode {
  const props = row.props ?? {};
  const day = props.simulation_day;
  const type = wireNodeType(row.node_type);
  return {
    id: graphNodeId(type, row.ref_key),
    refKey: row.ref_key,
    type,
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


/** The daily department-plan events: a person is on one every day, so they
 * would bury everything else in an expansion or a query. Left out unless
 * asked for. */
const PLAN_SUBTYPES = ["dept_plan_created"];

/** How much each evidence route says a node is what the evidence is about
 * (evidence_nodes.via). The evidence being the node itself says the most; a
 * person merely named in it says the least. */
const VIA_WEIGHT: Record<string, number> = {
  self: 1,
  thread: 0.9,
  event: 0.8,
  link: 0.8,
  organization: 0.6,
  department: 0.15,
  person: 0.15,
};

/** A node named outright in the question outranks anything evidence adds up to. */
const NAMED_SCORE = 5;

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

/**
 * Extracts potential explicit artifact identifiers (e.g. Jira keys, Confluence docs, PRs, Slack timestamps)
 * from a search query to guarantee exact lookup precedence.
 */
function extractPotentialSourceIds(query: string): string[] {
  const matches = query.match(
    /\b(?:[A-Za-z0-9]+-[A-Za-z0-9_.-]+|[a-z0-9]+_[A-Za-z0-9_.:-]+)\b/gi,
  );
  if (!matches) return [];
  const set = new Set<string>();
  for (const match of matches) {
    set.add(match);
    set.add(match.toUpperCase());
    set.add(match.toLowerCase());
  }
  return [...set];
}

/** Reciprocal-rank fusion gives exact keyword matches and semantic matches equal input weight, prioritizing exact artifact IDs. */
function fuseEvidence(keyword: Evidence[], semantic: Evidence[], limit: number, exact: Evidence[] = []): Evidence[] {
  const ranked = new Map<string, { item: Evidence; score: number }>();
  exact.forEach((item, index) => {
    const score = 2.0 - index * 0.01;
    ranked.set(item.sourceId, { item: { ...item, score }, score });
  });
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
      avatar?: string | null;
    }>(
      `SELECT employee_id, display_name, role, department, current_assignments, avatar
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
      avatar: row.avatar ?? "👤",
      currentAssignments: Array.isArray(row.current_assignments)
        ? row.current_assignments.filter((value): value is string => typeof value === "string")
        : [],
    };
  }

  async listEmployees(): Promise<EmployeePersona[]> {
    try {
      const result = await this.pool.query<{
        employee_id: string;
        display_name: string;
        role: string | null;
        department: string | null;
        avatar: string | null;
      }>(
        `SELECT employee_id, display_name, role, department, avatar
         FROM employees
         ORDER BY
           CASE employee_id
             WHEN 'jax' THEN 1
             WHEN 'priya' THEN 2
             WHEN 'chloe' THEN 3
             WHEN 'marcus' THEN 4
             WHEN 'deepa' THEN 5
             ELSE 6
           END, display_name ASC`,
      );
      return result.rows.map((row) => ({
        employeeId: row.employee_id,
        displayName: row.display_name,
        ...(row.role ? { role: row.role } : {}),
        ...(row.department ? { department: row.department } : {}),
        avatar: row.avatar ?? "👤",
      }));
    } catch {
      const result = await this.pool.query<{
        employee_id: string;
        display_name: string;
        role: string | null;
        department: string | null;
      }>(
        `SELECT employee_id, display_name, role, department
         FROM employees ORDER BY display_name ASC`,
      );
      return result.rows.map((row) => ({
        employeeId: row.employee_id,
        displayName: row.display_name,
        ...(row.role ? { role: row.role } : {}),
        ...(row.department ? { department: row.department } : {}),
        avatar: "👤",
      }));
    }
  }

  async verifyEmployeePassword(employeeId: string, password: string): Promise<EmployeePersona | null> {
    if (!password || typeof password !== "string" || !password.trim()) {
      return null;
    }
    const result = await this.pool.query<{
      employee_id: string;
      display_name: string;
      role: string | null;
      department: string | null;
      avatar: string | null;
      password_hash: string | null;
    }>(
      `SELECT employee_id, display_name, role, department, avatar, password_hash
       FROM employees WHERE employee_id = $1`,
      [employeeId.trim().toLowerCase()],
    );
    const row = result.rows[0];
    if (!row || !row.password_hash) return null;
    if (!verifyPassword(password, row.password_hash)) {
      return null;
    }
    return {
      employeeId: row.employee_id,
      displayName: row.display_name,
      ...(row.role ? { role: row.role } : {}),
      ...(row.department ? { department: row.department } : {}),
      avatar: row.avatar ?? "👤",
    };
  }

  async search(query: string, limit: number): Promise<Evidence[]> {
    return this.searchBefore(query, limit, null);
  }

  /**
   * search, seeing only evidence that occurred before `cutoff` (an ISO
   * instant, see asOfCutoff) — or everything, undated rows included, when it
   * is null. The date is applied inside each query rather than to its results,
   * so a date early in the record still gets a full page of what existed then.
   */
  async searchBefore(query: string, limit: number, cutoff: string | null): Promise<Evidence[]> {
    const normalizedLimit = Math.min(Math.max(limit, 1), 12);
    const potentialIds = extractPotentialSourceIds(query);
    const exactPromise = potentialIds.length > 0 ? this.sourcesBefore(potentialIds, cutoff) : Promise.resolve([]);
    const keywordPromise = this.keywordSearch(query, normalizedLimit, cutoff);
    if (!this.embeddings) {
      const [keywordResult, exactResult] = await Promise.all([keywordPromise, exactPromise]);
      return fuseEvidence(keywordResult, [], normalizedLimit, exactResult);
    }

    try {
      const [keywordResult, exactResult, vectors] = await Promise.all([
        keywordPromise,
        exactPromise,
        this.embeddings.embed([query], "query"),
      ]);
      const semanticResult = await this.semanticSearch(vectors[0]!, normalizedLimit, cutoff);
      return fuseEvidence(keywordResult, semanticResult, normalizedLimit, exactResult);
    } catch {
      // Keyword retrieval remains available when a hosted embedding provider is unavailable.
      const [keywordResult, exactResult] = await Promise.all([keywordPromise, exactPromise]);
      return fuseEvidence(keywordResult, [], normalizedLimit, exactResult);
    }
  }

  private async keywordSearch(query: string, limit: number, cutoff: string | null): Promise<Evidence[]> {
    const result = await this.pool.query<EvidenceRow>(
      `WITH requested AS (SELECT websearch_to_tsquery('english', $1) AS query),
       ranked AS (
         SELECT c.source_id, c.content,
                ts_rank_cd(
                  c.search_vector || to_tsvector('english', coalesce(d.title, '') || ' ' || coalesce(d.source_type, '') || ' ' || coalesce(d.source_id, '') || ' ' || coalesce(d.actors::text, '')),
                  requested.query
                ) AS score,
                row_number() OVER (
                  PARTITION BY c.source_id
                  ORDER BY ts_rank_cd(
                    c.search_vector || to_tsvector('english', coalesce(d.title, '') || ' ' || coalesce(d.source_type, '') || ' ' || coalesce(d.source_id, '') || ' ' || coalesce(d.actors::text, '')),
                    requested.query
                  ) DESC
                ) AS source_rank
         FROM document_chunks c
         JOIN source_documents d USING (source_id), requested
         WHERE (c.search_vector || to_tsvector('english', coalesce(d.title, '') || ' ' || coalesce(d.source_type, '') || ' ' || coalesce(d.source_id, '') || ' ' || coalesce(d.actors::text, ''))) @@ requested.query
           AND ($3::timestamptz IS NULL OR d.occurred_at < $3::timestamptz)
       )
       SELECT d.source_id, d.source_type, d.title,
              ranked.content AS excerpt, d.occurred_at, d.department, ranked.score
       FROM ranked JOIN source_documents d USING (source_id)
       WHERE ranked.source_rank = 1
       ORDER BY ranked.score DESC, d.occurred_at DESC NULLS LAST
       LIMIT $2`,
      [query, limit, cutoff],
    );
    return result.rows.map(evidence);
  }

  private async semanticSearch(vector: number[], limit: number, cutoff: string | null): Promise<Evidence[]> {
    const result = await this.pool.query<EvidenceRow>(
      `WITH ranked AS (
         SELECT c.source_id, c.content,
                1 - (c.embedding <=> $1::vector) AS score,
                row_number() OVER (
                  PARTITION BY c.source_id
                  ORDER BY c.embedding <=> $1::vector ASC
                ) AS source_rank
         FROM document_chunks c
         JOIN source_documents cd ON cd.source_id = c.source_id
         WHERE c.embedding IS NOT NULL
           AND ($3::timestamptz IS NULL OR cd.occurred_at < $3::timestamptz)
       )
       SELECT d.source_id, d.source_type, d.title,
              ranked.content AS excerpt, d.occurred_at, d.department, ranked.score
       FROM ranked JOIN source_documents d USING (source_id)
       WHERE ranked.source_rank = 1
       ORDER BY ranked.score DESC, d.occurred_at DESC NULLS LAST
       LIMIT $2`,
      [pgVector(vector), limit, cutoff],
    );
    return result.rows.map(evidence);
  }

  async related(sourceIds: string[], limit: number): Promise<Evidence[]> {
    return this.relatedBefore(sourceIds, limit, null);
  }

  async relatedBefore(sourceIds: string[], limit: number, cutoff: string | null): Promise<Evidence[]> {
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
         AND ($3::timestamptz IS NULL OR d.occurred_at < $3::timestamptz)
       ORDER BY d.occurred_at DESC NULLS LAST
       LIMIT $2`,
      [sourceIds, Math.min(Math.max(limit, 1), 12), cutoff],
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
    return this.sourcesBefore(sourceIds, null);
  }

  async sourcesBefore(sourceIds: string[], cutoff: string | null): Promise<Evidence[]> {
    if (sourceIds.length === 0) return [];
    const result = await this.pool.query<EvidenceRow>(
      `SELECT source_id, source_type, title, body AS excerpt,
              occurred_at, department, NULL::double precision AS score
       FROM source_documents
       WHERE source_id = ANY($1::text[]) AND category = 'artifact'
         AND ($2::timestamptz IS NULL OR occurred_at < $2::timestamptz)`,
      [sourceIds, cutoff],
    );
    return result.rows.map(evidence);
  }

  /** Only edges with both ends among these nodes, so the view never dangles
   * one; edgeTypes narrows it to the relationships a view is about. */
  private async edgesWithin(nodeIds: string[], edgeTypes?: string[]): Promise<GraphEdge[]> {
    if (nodeIds.length === 0) return [];
    const parameters: unknown[] = [nodeIds];
    let typeFilter = "";
    if (edgeTypes && edgeTypes.length > 0) {
      parameters.push(edgeTypes);
      typeFilter = ` AND e.edge_type = ANY($${parameters.length}::text[])`;
    }
    // Matched on node_id, never on ref_key: a key shared by two nodes would
    // otherwise pull in an edge belonging to whichever one is not in the slice.
    const result = await this.pool.query<{
      source_type: string;
      source_key: string;
      target_type: string;
      target_key: string;
      edge_type: string;
    }>(
      `SELECT s.node_type AS source_type, s.ref_key AS source_key,
              t.node_type AS target_type, t.ref_key AS target_key, e.edge_type
       FROM graph_edges e
       JOIN graph_nodes s ON s.node_id = e.src_node_id
       JOIN graph_nodes t ON t.node_id = e.dst_node_id
       WHERE e.src_node_id = ANY($1::bigint[])
         AND e.dst_node_id = ANY($1::bigint[])${typeFilter}`,
      parameters,
    );
    return result.rows.map((row) => ({
      source: graphNodeId(wireNodeType(row.source_type), row.source_key),
      target: graphNodeId(wireNodeType(row.target_type), row.target_key),
      type: row.edge_type,
    }));
  }

  // -------------------------------------------------------------------------
  // Company overview
  // -------------------------------------------------------------------------

  /**
   * One of the fixed overview subgraphs. Each is chosen by a query of its own
   * that returns the whole relationship it names, rather than an edge type
   * and a LIMIT, which cut the old layer tabs off at an arbitrary id. Where
   * the whole relationship is too big to draw (a vendor's 27 tickets), it is
   * folded per node the same way an expansion is.
   */
  async graphView(name: string): Promise<GraphSlice | null> {
    if (!(GRAPH_VIEWS as readonly string[]).includes(name)) return null;
    switch (name as GraphViewName) {
      case "org":
        // Departments, who is in each (current and former, the edge carries
        // first/last day) and who leads it, and the domains each is
        // responsible for.
        return this.viewOf(
          `SELECT node_id FROM graph_nodes WHERE node_type = 'organization' AND node_subtype = 'department'
           UNION SELECT e.src_node_id FROM graph_edges e WHERE e.edge_type IN ('member_of', 'leads', 'belongs_to')`,
          ["member_of", "leads", "belongs_to"],
        );
      case "expertise":
        // Who owns and who knows each domain, with each person's department so
        // the view can group them.
        return this.viewOf(
          `SELECT node_id FROM graph_nodes WHERE node_type = 'item' AND node_subtype = 'domain'
           UNION SELECT e.src_node_id FROM graph_edges e WHERE e.edge_type IN ('knows_about', 'owns_domain')
           UNION SELECT e.dst_node_id FROM graph_edges e
                 WHERE e.edge_type = 'member_of'
                   AND e.src_node_id IN (SELECT src_node_id FROM graph_edges WHERE edge_type IN ('knows_about', 'owns_domain'))`,
          ["knows_about", "owns_domain", "member_of"],
        );
      case "incidents":
        // Every incident with what it recurred from, the ticket it was
        // tracked in, the PR that fixed it, its postmortem, its domains, the
        // customer tickets that escalated into it, and who raised and received
        // the escalation.
        return this.viewOf(
          `WITH incident AS (
             SELECT node_id FROM graph_nodes WHERE node_type = 'event' AND node_subtype = 'incident'
           )
           SELECT node_id FROM incident
           UNION SELECT e.dst_node_id FROM graph_edges e JOIN incident i ON i.node_id = e.src_node_id
                 WHERE e.edge_type IN ('tracked_in', 'fixed_by', 'produced', 'about_domain', 'caused_by', 'raised_by', 'received_by')
           UNION SELECT e.src_node_id FROM graph_edges e JOIN incident i ON i.node_id = e.dst_node_id
                 WHERE e.edge_type = 'caused_by'`,
          ["caused_by", "tracked_in", "fixed_by", "produced", "about_domain", "raised_by", "received_by", "documented_by"],
        );
      case "documents":
        return this.documentsView();
      case "customers":
        return this.partnersView();
      case "timeline":
        return this.timelineView();
    }
  }

  /** A view from a set of node ids: the nodes, and every edge of the given
   * types with both ends among them. */
  private async viewOf(nodeIdsSql: string, edgeTypes: string[]): Promise<GraphSlice> {
    const result = await this.pool.query<GraphNodeRow>(
      `SELECT node_id::text AS node_id, ref_key, node_type, node_subtype, label, props
       FROM graph_nodes WHERE node_id IN (${nodeIdsSql})`,
    );
    const edges = await this.edgesWithin(result.rows.map((row) => row.node_id), edgeTypes);
    const nodes = result.rows.map(graphNode);
    // A node the query chose but no edge of the view reaches (a department
    // with no members) is noise on a diagram about relationships.
    const touched = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
    return { nodes: nodes.filter((node) => touched.has(node.id)), edges, truncated: false };
  }

  /**
   * The document chain for the pages that matter most to it: the 30 pages
   * most connected by it (cited by other pages, written up from an incident
   * or a ticket, about a domain), each with the event that produced it, its
   * author, the domains it is about, and the citations among them. Not all
   * 479: that many pages drawn at once is a wall, and every page is a
   * query or an expansion away.
   */
  private async documentsView(): Promise<GraphSlice> {
    return this.viewOf(
      `WITH page AS (
         SELECT d.node_id
         FROM graph_nodes d
         WHERE d.node_type = 'document'
         ORDER BY (
           SELECT count(*) FROM graph_edges e
           WHERE (e.dst_node_id = d.node_id AND e.edge_type IN ('cites', 'documented_by', 'produced'))
              OR (e.src_node_id = d.node_id AND e.edge_type IN ('cites', 'about_domain'))
         ) DESC, d.ref_key
         LIMIT 30
       )
       SELECT node_id FROM page
       UNION SELECT e.src_node_id FROM graph_edges e JOIN page p ON p.node_id = e.dst_node_id
             WHERE e.edge_type IN ('produced', 'wrote')
       UNION SELECT e.dst_node_id FROM graph_edges e JOIN page p ON p.node_id = e.src_node_id
             WHERE e.edge_type IN ('about_domain', 'cites')
               AND e.dst_node_id IN (SELECT node_id FROM graph_nodes WHERE node_type = 'item' OR node_id IN (SELECT node_id FROM page))`,
      ["produced", "wrote", "about_domain", "cites", "part_of"],
    );
  }

  /**
   * Customers and vendors, the people who write in for them, and the work
   * that is about them: deals, invoices, surveys, customer tickets, and the
   * tickets vendor mail opened. A vendor opened up to 27 tickets, so each
   * organization's work is budgeted and the rest folded into a cluster that
   * expands like any other.
   */
  private async partnersView(): Promise<GraphSlice> {
    const organizations = await this.pool.query<GraphNodeRow>(
      `SELECT o.node_id::text AS node_id, o.ref_key, o.node_type, o.node_subtype, o.label, o.props
       FROM graph_nodes o
       WHERE o.node_type = 'organization' AND o.node_subtype IN ('customer', 'vendor')
         AND EXISTS (SELECT 1 FROM graph_edges e
                     WHERE e.dst_node_id = o.node_id
                       AND e.edge_type IN ('for_customer', 'from_vendor', 'contact_for'))
       ORDER BY o.node_subtype, o.ref_key`,
    );
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    for (const row of organizations.rows) {
      const organization = graphNode(row);
      nodes.set(organization.id, organization);
      const candidates = (await this.neighbours(row.node_id, false)).filter((candidate) =>
        candidate.edges.some((edge) =>
          ["for_customer", "from_vendor", "contact_for"].includes(edge.type)));
      for (const candidate of candidates) {
        candidate.edges = candidate.edges.filter((edge) =>
          ["for_customer", "from_vendor", "contact_for"].includes(edge.type));
      }
      const kept = budgetNeighbours(organization.id, candidates, { budget: 4 });
      for (const node of kept.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
      edges.push(...kept.edges);
    }
    return { nodes: [...nodes.values()], edges, truncated: false };
  }

  /**
   * What happened when, across the whole simulation. The milestones are
   * drawn as themselves — the incidents, the sprints, the customer tickets
   * — with the recurrence edges between incidents. Everything else that
   * happened on a day (page creations, discussions, ticket progress, plans:
   * about 2,300 events) is one summary node per day saying how many of what,
   * which expands like a cluster would.
   */
  private async timelineView(): Promise<GraphSlice> {
    const milestones = await this.viewOrEmpty(
      `SELECT node_id FROM graph_nodes
       WHERE node_type = 'event' AND node_subtype IN ('incident', 'sprint_planned', 'zd_ticket')`,
    );
    const days = await this.pool.query<{ day: string; first_at: Date; counts: Record<string, number> }>(
      `WITH daily AS (
         SELECT (props->>'occurred_at')::timestamptz::date AS day, node_subtype, count(*) AS n,
                min((props->>'occurred_at')::timestamptz) AS first_at
         FROM graph_nodes
         WHERE node_type = 'event'
           AND node_subtype NOT IN ('incident', 'sprint_planned', 'zd_ticket')
           AND props->>'occurred_at' IS NOT NULL
         GROUP BY 1, 2
       )
       SELECT day::text AS day, min(first_at) AS first_at, jsonb_object_agg(node_subtype, n) AS counts
       FROM daily GROUP BY day ORDER BY day`,
    );
    const summaries: GraphNode[] = days.rows.map((row) => {
      const total = Object.values(row.counts).reduce((sum, value) => sum + Number(value), 0);
      return {
        id: `day:${row.day}`,
        refKey: row.day,
        type: "cluster",
        label: `${row.day}: ${total} events`,
        props: { occurred_at: row.first_at.toISOString(), day: row.day, counts: row.counts, total },
      };
    });
    return {
      nodes: [...milestones.nodes, ...summaries],
      edges: milestones.edges,
      truncated: false,
    };
  }

  /** viewOf without dropping nodes no edge touches: a timeline's milestones
   * stand on their own. */
  private async viewOrEmpty(nodeIdsSql: string): Promise<GraphSlice> {
    const result = await this.pool.query<GraphNodeRow>(
      `SELECT node_id::text AS node_id, ref_key, node_type, node_subtype, label, props
       FROM graph_nodes WHERE node_id IN (${nodeIdsSql})`,
    );
    const edges = await this.edgesWithin(result.rows.map((row) => row.node_id), ["caused_by"]);
    return { nodes: result.rows.map(graphNode), edges, truncated: false };
  }

  // -------------------------------------------------------------------------
  // Query graph
  // -------------------------------------------------------------------------

  /**
   * A question's graph: a centre node standing for the question, linked to the
   * graph nodes the question points at. Two ways a node is pointed at:
   *
   *  - its name is in the question ("TitanDB", "Jax", "Metro United FC"),
   *    which is the strongest signal there is;
   *  - the question's evidence belongs to it. Most evidence is a slack
   *    message or an email, which is not a node; evidence_nodes (built with
   *    the graph) says which ticket, incident, page, customer, department or
   *    person each piece belongs to, and by which route. A ticket the
   *    evidence is about outranks a person it merely names.
   *
   * Only the centre and its seeds are returned, with the edges among them:
   * everything further is a click away (graphExpand), so the first picture
   * stays readable.
   */
  async graphQuery(request: GraphQueryRequest): Promise<GraphSlice> {
    const query = request.query.trim();
    const maxSeeds = Math.min(Math.max(request.seeds ?? 8, 1), 16);
    const categories = (request.categories ?? []).filter(isGraphCategory);

    const given = (request.evidence ?? []).filter(Boolean).slice(0, 20);
    let evidence = given.length > 0 ? await this.evidenceInOrder(given) : await this.search(query, 10);
    if (given.length === 0 && evidence.length < 3) {
      // Keyword search needs every term; a question rarely has them all in one
      // chunk. Accepting any term recovers it, at some cost in precision that
      // the scoring below absorbs.
      const loose = await this.anyTermSearch(query, 10);
      const seen = new Set(evidence.map((item) => item.sourceId));
      evidence = [...evidence, ...loose.filter((item) => !seen.has(item.sourceId))].slice(0, 10);
    }

    const scores = new Map<string, number>();
    const add = (nodeId: string, score: number) =>
      scores.set(nodeId, (scores.get(nodeId) ?? 0) + score);

    for (const row of await this.nodesNamedIn(query)) add(row.node_id, NAMED_SCORE);

    if (evidence.length > 0) {
      const routes = await this.pool.query<{ source_id: string; node_id: string; via: string }>(
        `SELECT e.source_id, e.node_id::text AS node_id, e.via
         FROM evidence_nodes e
         JOIN graph_nodes n ON n.node_id = e.node_id
         WHERE e.source_id = ANY($1::text[])
           AND NOT (n.node_type = 'event' AND n.node_subtype = ANY($2::text[]))`,
        [evidence.map((item) => item.sourceId), PLAN_SUBTYPES],
      );
      const rank = new Map(evidence.map((item, index) => [item.sourceId, index]));
      // Evidence that is itself a node counts as that node and nothing else:
      // its other routes (the event that created a page, the people on a
      // ticket) restate it, and only crowd it out of the seats.
      const isNode = new Set(
        routes.rows.filter((route) => route.via === "self").map((route) => route.source_id),
      );
      for (const route of routes.rows) {
        if (isNode.has(route.source_id) && route.via !== "self") continue;
        const position = rank.get(route.source_id) ?? evidence.length;
        add(route.node_id, (VIA_WEIGHT[route.via] ?? 0.1) / (position + 1));
      }
    }

    const candidates = await this.rowsByNodeId([...scores.keys()]);
    const ranked = candidates
      .map((row) => ({ row, node: graphNode(row), score: scores.get(row.node_id) ?? 0 }))
      .filter(({ node }) => {
        const category = categoryOf(node);
        return category !== null && (categories.length === 0 || categories.includes(category));
      })
      .sort((left, right) => right.score - left.score || left.node.label.localeCompare(right.node.label));

    // No single category may take every seat: a question about an incident
    // names a dozen people in its evidence, and they should not crowd out the
    // incident, its ticket and its domain.
    const perCategory = Math.max(2, Math.ceil(maxSeeds / 2));
    const taken = new Map<string, number>();
    const seeds: typeof ranked = [];
    for (const candidate of ranked) {
      if (seeds.length >= maxSeeds) break;
      const category = categoryOf(candidate.node)!;
      // People are named on almost everything, so they add up; three is
      // enough to say who was around without hiding what happened.
      const cap = category === "people" ? Math.min(3, perCategory) : perCategory;
      if ((taken.get(category) ?? 0) >= cap) continue;
      taken.set(category, (taken.get(category) ?? 0) + 1);
      seeds.push(candidate);
    }

    const centre: GraphNode = {
      id: `query:${query}`,
      refKey: query,
      type: "query",
      label: query,
    };
    if (seeds.length === 0) {
      return { nodes: [centre], edges: [], truncated: false, centre: centre.id, evidence };
    }

    const inner = await this.edgesWithin(seeds.map(({ row }) => row.node_id));
    return {
      nodes: [centre, ...seeds.map(({ node, score }) => ({
        ...node,
        props: { ...(node.props ?? {}), match_score: Number(score.toFixed(3)) },
      }))],
      edges: [
        ...seeds.map(({ node }) => ({ source: centre.id, target: node.id, type: "matches" })),
        ...inner,
      ],
      truncated: ranked.length > seeds.length,
      centre: centre.id,
      evidence,
    };
  }

  /**
   * One node's neighbourhood along every edge type, in both directions —
   * unlike the causal-chain slice, which follows only outgoing 'produced'
   * edges and so found nothing new from a person, a ticket or a domain.
   * Ranked and budgeted per category by budgetNeighbours; what does not fit is
   * folded into cluster nodes. Expanding a cluster id returns the next page of
   * that category.
   */
  async graphExpand(request: GraphExpandRequest): Promise<GraphSlice> {
    const budget = Math.min(Math.max(request.budget ?? 6, 1), 40);
    const cluster = parseClusterId(request.id);
    const parentId = cluster ? cluster.parentId : request.id;
    const categories: GraphCategory[] = cluster
      ? [cluster.category]
      : (request.categories ?? []).filter(isGraphCategory);
    // A cluster's next page is bigger: the reader asked for this category.
    const pageBudget = cluster ? Math.max(budget, 20) : budget;
    // Only a cluster pages: its node carried how far the previous page reached.
    const offset = cluster ? Math.max(request.offset ?? 0, 0) : 0;

    if (parentId.startsWith("day:")) {
      return this.expandDay(parentId, pageBudget, offset, request.includePlans === true);
    }

    const { type, refKey } = parseGraphNodeId(parentId);
    const parentRows = await this.pool.query<GraphNodeRow>(
      `SELECT node_id::text AS node_id, ref_key, node_type, node_subtype, label, props
       FROM graph_nodes WHERE ref_key = $1 AND ($2::text IS NULL OR node_type = $2)
       ORDER BY node_type LIMIT 1`,
      [refKey, type ?? null],
    );
    const parentRow = parentRows.rows[0];
    if (!parentRow) return { nodes: [], edges: [], truncated: false };
    const parent = graphNode(parentRow);

    const candidates = await this.neighbours(parentRow.node_id, request.includePlans === true);
    const kept = budgetNeighbours(parent.id, candidates, {
      budget: pageBudget,
      offset,
      ...(categories.length > 0 ? { categories } : {}),
    });

    return {
      nodes: [parent, ...kept.nodes],
      edges: kept.edges,
      truncated: kept.folded.length > 0,
      centre: parent.id,
    };
  }

  /**
   * A timeline day summary's events: everything that happened that day
   * except the milestones the timeline already draws, budgeted like any
   * other neighbourhood (a busy day has 60 events). Each is joined to the day
   * by an 'on_day' edge, since a day is not a stored node.
   */
  private async expandDay(
    dayId: string,
    budget: number,
    offset: number,
    includePlans: boolean,
  ): Promise<GraphSlice> {
    const day = dayId.slice("day:".length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { nodes: [], edges: [], truncated: false };
    const result = await this.pool.query<GraphNodeRow & { degree: string }>(
      `SELECT n.node_id::text AS node_id, n.ref_key, n.node_type, n.node_subtype, n.label, n.props,
              (SELECT count(*) FROM graph_edges x
               WHERE x.src_node_id = n.node_id OR x.dst_node_id = n.node_id) AS degree
       FROM graph_nodes n
       WHERE n.node_type = 'event'
         AND n.node_subtype NOT IN ('incident', 'sprint_planned', 'zd_ticket')
         AND ($2::boolean OR NOT (n.node_subtype = ANY($3::text[])))
         AND (n.props->>'occurred_at')::timestamptz::date = $1::date`,
      [day, includePlans, PLAN_SUBTYPES],
    );
    const candidates: NeighbourCandidate[] = result.rows.map((row) => {
      const node = graphNode(row);
      return { node, edges: [{ source: dayId, target: node.id, type: "on_day" }], degree: Number(row.degree) };
    });
    const centre: GraphNode = { id: dayId, refKey: day, type: "cluster", label: day, props: { day } };
    const kept = budgetNeighbours(dayId, candidates, { budget, offset });
    return { nodes: [centre, ...kept.nodes], edges: kept.edges, truncated: kept.folded.length > 0, centre: dayId };
  }

  private async neighbours(nodeId: string, includePlans: boolean): Promise<NeighbourCandidate[]> {
    const result = await this.pool.query<GraphNodeRow & {
      edge_type: string;
      source_type: string;
      source_key: string;
      target_type: string;
      target_key: string;
      degree: string;
    }>(
      `WITH touching AS (
         SELECT e.edge_type, e.src_node_id, e.dst_node_id,
                CASE WHEN e.src_node_id = $1 THEN e.dst_node_id ELSE e.src_node_id END AS other
         FROM graph_edges e
         WHERE e.src_node_id = $1 OR e.dst_node_id = $1
       )
       SELECT o.node_id::text AS node_id, o.ref_key, o.node_type, o.node_subtype, o.label, o.props,
              t.edge_type,
              s.node_type AS source_type, s.ref_key AS source_key,
              d.node_type AS target_type, d.ref_key AS target_key,
              (SELECT count(*) FROM graph_edges x
               WHERE x.src_node_id = o.node_id OR x.dst_node_id = o.node_id) AS degree
       FROM touching t
       JOIN graph_nodes o ON o.node_id = t.other
       JOIN graph_nodes s ON s.node_id = t.src_node_id
       JOIN graph_nodes d ON d.node_id = t.dst_node_id
       WHERE o.node_id <> $1
         AND ($2::boolean OR NOT (o.node_type = 'event' AND o.node_subtype = ANY($3::text[])))
       LIMIT 5000`,
      [nodeId, includePlans, PLAN_SUBTYPES],
    );

    const byNode = new Map<string, NeighbourCandidate>();
    for (const row of result.rows) {
      const edge: GraphEdge = {
        source: graphNodeId(wireNodeType(row.source_type), row.source_key),
        target: graphNodeId(wireNodeType(row.target_type), row.target_key),
        type: row.edge_type,
      };
      const existing = byNode.get(row.node_id);
      if (existing) {
        existing.edges.push(edge);
      } else {
        byNode.set(row.node_id, { node: graphNode(row), edges: [edge], degree: Number(row.degree) });
      }
    }
    return [...byNode.values()];
  }

  /** Nodes whose own name appears in the question as a whole word or phrase:
   * a domain, a person, a department, a customer or vendor — about ninety
   * names, so they are matched here rather than in SQL. Names shorter than
   * three characters are skipped, so "QA" does not match every "qa". A
   * department's key is matched with spaces for underscores ("Engineering
   * Backend"), as is a domain's ("aws cost structure"). */
  private async nodesNamedIn(query: string) {
    const result = await this.pool.query<GraphNodeRow>(
      `SELECT node_id::text AS node_id, ref_key, node_type, node_subtype, label, props
       FROM graph_nodes
       WHERE node_type IN ('person', 'organization')
          OR (node_type = 'item' AND node_subtype = 'domain')`,
    );
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = (name: string) =>
      name.length >= 3 &&
      new RegExp(`(^|[^\\p{L}\\p{N}])${escape(name)}($|[^\\p{L}\\p{N}])`, "iu").test(query);
    // Also with hyphens and underscores as spaces: "redis cache" names the
    // redis-cache domain, "Engineering Backend" the Engineering_Backend one.
    const spaced = (name: string) => name.replace(/[-_]/g, " ");
    return result.rows.filter(
      (row) =>
        named(row.label) ||
        named(spaced(row.label)) ||
        named(spaced(row.ref_key)),
    );
  }

  private async rowsByNodeId(nodeIds: string[]) {
    if (nodeIds.length === 0) return [];
    const result = await this.pool.query<GraphNodeRow>(
      `SELECT node_id::text AS node_id, ref_key, node_type, node_subtype, label, props
       FROM graph_nodes WHERE node_id = ANY($1::bigint[])`,
      [nodeIds],
    );
    return result.rows;
  }

  /** Evidence for the given source ids, in the order given: an answer lists
   * its sources most relevant first, and seed scoring reads that order. Ids
   * that are not employee-visible artifacts are dropped (sources() only
   * returns those), so nothing an answer could not have shown gets placed. */
  private async evidenceInOrder(sourceIds: string[]): Promise<Evidence[]> {
    // sources() returns whole bodies; the graph only needs enough to recognise
    // each piece by.
    const found = new Map((await this.sources(sourceIds)).map((item) => [
      item.sourceId,
      { ...item, excerpt: item.excerpt.length > 400 ? `${item.excerpt.slice(0, 399)}…` : item.excerpt },
    ]));
    return sourceIds.map((id) => found.get(id)).filter((item): item is Evidence => Boolean(item));
  }

  /** Keyword search accepting any of the question's terms, for when requiring
   * all of them finds too little. */
  private async anyTermSearch(query: string, limit: number): Promise<Evidence[]> {
    const result = await this.pool.query<EvidenceRow>(
      `WITH requested AS (
         SELECT to_tsquery('english',
                  replace(plainto_tsquery('english', $1)::text, '&', '|')) AS query
       ),
       ranked AS (
         SELECT c.source_id, c.content,
                ts_rank_cd(c.search_vector, requested.query) AS score,
                row_number() OVER (
                  PARTITION BY c.source_id
                  ORDER BY ts_rank_cd(c.search_vector, requested.query) DESC
                ) AS source_rank
         FROM document_chunks c, requested
         WHERE plainto_tsquery('english', $1)::text <> ''
           AND c.search_vector @@ requested.query
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

  /**
   * The working days the planner projection covers — the days with a
   * department plan — oldest first. Read once: the projection only changes
   * when build_timeline.py is re-run, which means a restart anyway.
   */
  async workingDays(): Promise<string[]> {
    this.workingDaysCache ??= this.pool
      .query<{ day: string }>("SELECT DISTINCT day::text AS day FROM day_plan_entry ORDER BY 1")
      .then((result) => result.rows.map((row) => row.day))
      .catch((error: unknown) => {
        this.workingDaysCache = undefined;
        throw error;
      });
    return this.workingDaysCache;
  }

  private workingDaysCache: Promise<string[]> | undefined;

  async todo(person: string, day: AsOf): Promise<TodoItem[]> {
    const result = await this.pool.query<{
      item_key: string; title: string | null; status: string; relation: "assignee" | "reporter";
      since: string; department: string | null; points: number | null; sprint_no: number | null;
      reporter: string | null; sources: string[];
    }>(
      `SELECT item_key, title, status, valid_from::text AS since, department, points, sprint_no,
              reporter, sources,
              CASE WHEN assignee = $1 THEN 'assignee' ELSE 'reporter' END AS relation
       FROM work_item_state
       WHERE valid_from <= $2::date AND (valid_to IS NULL OR valid_to > $2::date)
         AND status <> 'Done'
         AND (assignee = $1 OR (assignee IS NULL AND reporter = $1))
       ORDER BY (assignee = $1) DESC,
                CASE status WHEN 'In Progress' THEN 0 WHEN 'In Review' THEN 1 ELSE 2 END,
                valid_from, item_key`,
      [person, day],
    );
    return result.rows.map((row) => ({
      itemKey: row.item_key,
      title: row.title,
      status: row.status,
      relation: row.relation,
      since: row.since,
      department: row.department,
      points: row.points,
      sprintNo: row.sprint_no,
      reporter: row.reporter,
      sources: row.sources,
    }));
  }

  async dayPlan(person: string, day: AsOf): Promise<DayPlanEntry[]> {
    const result = await this.pool.query<{
      seq: number; title: string; activity_type: string | null; est_hours: string | null;
      collaborators: string[]; deferred: boolean; defer_reason: string | null;
      item_key: string | null; sources: string[];
    }>(
      `SELECT seq, title, activity_type, est_hours, collaborators, deferred, defer_reason, item_key, sources
       FROM day_plan_entry WHERE person = $1 AND day = $2::date ORDER BY seq`,
      [person, day],
    );
    return result.rows.map((row) => ({
      seq: row.seq,
      title: row.title,
      activityType: row.activity_type,
      // numeric comes back as a string
      estHours: row.est_hours === null ? null : Number(row.est_hours),
      collaborators: row.collaborators,
      deferred: row.deferred,
      deferReason: row.defer_reason,
      itemKey: row.item_key,
      sources: row.sources,
    }));
  }

  async roster(day: AsOf): Promise<RosterEntry[]> {
    const result = await this.pool.query<{
      person: string; joined_on: string | null; left_on: string | null;
      role: string | null; department: string | null; employed: boolean;
    }>(
      `SELECT person, joined_on::text AS joined_on, left_on::text AS left_on, role, department,
              ((joined_on IS NULL OR joined_on <= $1::date) AND (left_on IS NULL OR left_on > $1::date)) AS employed
       FROM employee_roster ORDER BY person`,
      [day],
    );
    // A join or leave after D is not known on D.
    return result.rows.map((row) => ({
      person: row.person,
      joinedOn: row.joined_on !== null && row.joined_on <= day ? row.joined_on : null,
      leftOn: row.left_on !== null && row.left_on <= day ? row.left_on : null,
      role: row.role,
      department: row.department,
      employed: row.employed,
    }));
  }

  /**
   * Every knowledge domain's health on day D (see src/domain-health.ts).
   * Only the graph, the ticket states, the roster and the dated owner history
   * are read, and only what had happened by the end of D; the evidence named
   * is limited to artifacts that existed by then.
   */
  async domainHealth(day: AsOf): Promise<DomainHealth[]> {
    // A past day's health never changes until the projections are rebuilt,
    // which means a restart; proposals read many days, so keep them.
    let cached = this.healthByDay.get(day);
    if (!cached) {
      cached = this.readDomainHealth(day).catch((error: unknown) => {
        this.healthByDay.delete(day);
        throw error;
      });
      this.healthByDay.set(day, cached);
    }
    return cached;
  }

  private readonly healthByDay = new Map<string, Promise<DomainHealth[]>>();

  private async readDomainHealth(day: AsOf): Promise<DomainHealth[]> {
    const cutoff = asOfCutoff(day);
    const [domains, owners, roster, pages, tickets, incidents] = await Promise.all([
      this.pool.query<{ key: string; name: string; department: string | null }>(
        `SELECT d.ref_key AS key, d.label AS name, dept.ref_key AS department
         FROM graph_nodes d
         LEFT JOIN graph_edges b ON b.src_node_id = d.node_id AND b.edge_type = 'belongs_to'
         LEFT JOIN graph_nodes dept ON dept.node_id = b.dst_node_id
         WHERE d.node_type = 'item' AND d.node_subtype = 'domain'`,
      ),
      this.pool.query<{ domain: string; owner: string; since: string | null }>(
        `SELECT domain_key AS domain, owner, valid_from::text AS since
         FROM domain_owner_history
         WHERE (valid_from IS NULL OR valid_from <= $1::date) AND (valid_to IS NULL OR valid_to > $1::date)`,
        [day],
      ),
      this.roster(day),
      // Pages about or updating a domain in the window, with who wrote them.
      this.pool.query<{ domain: string; person: string; source_id: string }>(
        `SELECT DISTINCT dom.ref_key AS domain, author.ref_key AS person, page.ref_key AS source_id
         FROM graph_nodes dom
         JOIN graph_edges about ON about.dst_node_id = dom.node_id AND about.edge_type IN ('about_domain', 'updates_domain')
         JOIN graph_nodes page ON page.node_id = about.src_node_id AND page.node_type = 'document'
         JOIN source_documents doc ON doc.source_id = page.ref_key AND doc.category = 'artifact'
         JOIN graph_edges wrote ON wrote.dst_node_id = page.node_id AND wrote.edge_type = 'wrote'
         JOIN graph_nodes author ON author.node_id = wrote.src_node_id AND author.node_type = 'person'
         WHERE dom.node_subtype = 'domain'
           AND doc.occurred_at >= $1::timestamptz - make_interval(days => $2) AND doc.occurred_at < $1::timestamptz`,
        [cutoff, HEALTH_WINDOW_DAYS],
      ),
      // Tickets about a domain, with whoever had them at some point in the window.
      this.pool.query<{ domain: string; person: string; source_id: string }>(
        `SELECT DISTINCT dom.ref_key AS domain, state.assignee AS person, item.ref_key AS source_id
         FROM graph_nodes dom
         JOIN graph_edges about ON about.dst_node_id = dom.node_id AND about.edge_type = 'about_domain'
         JOIN graph_nodes item ON item.node_id = about.src_node_id AND item.node_type = 'item'
         JOIN work_item_state state ON state.item_key = item.ref_key AND state.assignee IS NOT NULL
         WHERE dom.node_subtype = 'domain'
           AND state.valid_from <= $1::date
           AND (state.valid_to IS NULL OR state.valid_to > $1::date - $2::int)`,
        [day, HEALTH_WINDOW_DAYS - 1],
      ),
      // Incidents about a domain opened in the window, and the people on them.
      this.pool.query<{ domain: string; key: string; person: string | null }>(
        `SELECT dom.ref_key AS domain, incident.ref_key AS key, person.ref_key AS person
         FROM graph_nodes dom
         JOIN graph_edges about ON about.dst_node_id = dom.node_id AND about.edge_type = 'about_domain'
         JOIN graph_nodes incident ON incident.node_id = about.src_node_id AND incident.node_subtype = 'incident'
         LEFT JOIN graph_edges role ON role.src_node_id = incident.node_id
                                  AND role.edge_type IN ('involves', 'raised_by', 'received_by', 'led_by')
         LEFT JOIN graph_nodes person ON person.node_id = role.dst_node_id AND person.node_type = 'person'
         WHERE dom.node_subtype = 'domain'
           AND (incident.props->>'occurred_at')::timestamptz >= $1::timestamptz - make_interval(days => $2)
           AND (incident.props->>'occurred_at')::timestamptz < $1::timestamptz`,
        [cutoff, HEALTH_WINDOW_DAYS],
      ),
    ]);

    const work: DomainHealthInputs["work"] = [
      ...pages.rows.map((row) => ({ domain: row.domain, person: row.person, sourceId: row.source_id, kind: "page" as const })),
      ...tickets.rows.map((row) => ({ domain: row.domain, person: row.person, sourceId: row.source_id, kind: "ticket" as const })),
      ...incidents.rows
        .filter((row) => row.person)
        .map((row) => ({ domain: row.domain, person: row.person!, sourceId: row.key, kind: "incident" as const })),
    ];
    const health = assembleHealth({
      domains: domains.rows,
      owners: owners.rows,
      employed: new Set(roster.filter((row) => row.employed).map((row) => row.person)),
      leftOn: new Map(roster.filter((row) => row.leftOn).map((row) => [row.person, row.leftOn!])),
      work,
      incidents: incidents.rows.map((row) => ({ domain: row.domain, key: row.key })),
    });

    // Name as evidence only what an employee could open on D.
    const named = [...new Set(health.flatMap((row) => [...row.evidence.contributors, ...row.evidence.incidents]))];
    const visible = new Set((await this.sourcesBefore(named, cutoff)).map((item) => item.sourceId));
    return health.map((row) => ({
      ...row,
      evidence: {
        contributors: row.evidence.contributors.filter((id) => visible.has(id)),
        incidents: row.evidence.incidents.filter((id) => visible.has(id)),
      },
    }));
  }

  /** This knowledge seen from the end of day D (see src/as-of.ts). */
  asOf(day: AsOf): CompanyKnowledge {
    return new DatedCompanyKnowledge(this, day);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Company knowledge as it stood at the end of one working day.
 *
 * Retrieval sees only evidence that had occurred by then. Everything not yet
 * filtered by date is left out rather than passed through — the graph, and
 * relatedThroughEvents, which walks it — so a caller that asks for them finds
 * them missing, the same as on a deployment without the graph, instead of
 * being handed something from the future. Who the employees are does not
 * depend on the day.
 */
export class DatedCompanyKnowledge implements CompanyKnowledge {
  private readonly cutoff: string;

  constructor(
    private readonly knowledge: PostgresCompanyKnowledge,
    readonly day: AsOf,
  ) {
    this.cutoff = asOfCutoff(day);
  }

  employee(employeeId: string): Promise<EmployeeContext | null> {
    return this.knowledge.employee(employeeId);
  }

  listEmployees(): Promise<EmployeePersona[]> {
    return this.knowledge.listEmployees();
  }

  verifyEmployeePassword(employeeId: string, password: string): Promise<EmployeePersona | null> {
    return this.knowledge.verifyEmployeePassword(employeeId, password);
  }

  search(query: string, limit: number): Promise<Evidence[]> {
    return this.knowledge.searchBefore(query, limit, this.cutoff);
  }

  related(sourceIds: string[], limit: number): Promise<Evidence[]> {
    return this.knowledge.relatedBefore(sourceIds, limit, this.cutoff);
  }

  sources(sourceIds: string[]): Promise<Evidence[]> {
    return this.knowledge.sourcesBefore(sourceIds, this.cutoff);
  }

  workingDays(): Promise<string[]> {
    return this.knowledge.workingDays();
  }

  /** An earlier day may be looked back at; a later one is read as this one. */
  todo(person: string, day: AsOf): Promise<TodoItem[]> {
    return this.knowledge.todo(person, day > this.day ? this.day : day);
  }

  dayPlan(person: string, day: AsOf): Promise<DayPlanEntry[]> {
    return this.knowledge.dayPlan(person, day > this.day ? this.day : day);
  }

  roster(day: AsOf): Promise<RosterEntry[]> {
    return this.knowledge.roster(day > this.day ? this.day : day);
  }

  domainHealth(day: AsOf): Promise<DomainHealth[]> {
    return this.knowledge.domainHealth(day > this.day ? this.day : day);
  }
}
