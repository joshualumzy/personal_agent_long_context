import type { ChatBlock } from "./agent-extension.js";

export interface EmployeeContext {
  employeeId: string;
  displayName: string;
  role?: string;
  department?: string;
  currentAssignments: string[];
}

export interface Evidence {
  sourceId: string;
  sourceType: string;
  title: string;
  excerpt: string;
  occurredAt?: string;
  department?: string;
  score?: number;
}

export const GRAPH_NODE_TYPES = ["person", "organization", "item", "event", "document"] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

/**
 * A graph node's identity on the wire: its type and its natural key together.
 *
 * The natural key alone is not unique. graph_nodes is keyed on
 * (node_type, ref_key), and the corpus gives the same key to different
 * things on purpose: an incident's event node and the jira ticket it was
 * tracked in are both "ENG-112", and a Zendesk ticket's lifecycle event and
 * the ticket itself are both "ZD-101". Using ref_key as the id attached edges
 * to the wrong one of each pair and let the view's merge drop the other.
 */
export function graphNodeId(type: GraphNodeType, refKey: string): string {
  return `${type}:${refKey}`;
}

/**
 * The inverse of graphNodeId, tolerant of a bare natural key ("ENG-112"), which
 * is what a search hit or a hand-typed seed gives. A bare key has no type, and
 * matches every node sharing that key. Only a known type counts as a prefix,
 * so a key that happens to contain a colon is not misread.
 */
export function parseGraphNodeId(id: string): { type?: GraphNodeType; refKey: string } {
  const colon = id.indexOf(":");
  if (colon > 0) {
    const prefix = id.slice(0, colon);
    if ((GRAPH_NODE_TYPES as readonly string[]).includes(prefix)) {
      return { type: prefix as GraphNodeType, refKey: id.slice(colon + 1) };
    }
  }
  return { refKey: id };
}

/** One node of a graph slice. `id` is `type:refKey` (see graphNodeId); `refKey`
 * is the natural key alone: a source id, a domain key, or a resolved person
 * name. */
export interface GraphNode {
  id: string;
  refKey: string;
  /** A stored node's type, or one of two the query API makes up: 'query',
   * the question a query graph is centred on, and 'cluster', the neighbours
   * of one category an expansion folded away (see graph-neighbourhood.ts). */
  type: GraphNodeType | "query" | "cluster";
  subtype?: string;
  label: string;
  sourceType?: string;
  category?: string;
  department?: string;
  simulationDay?: number;
  isIncident?: boolean;
  /**
   * The node's own denormalized facts, passed through as-is for the graph
   * view's Attributes tab. Never a document body — that stays out of a
   * slice on purpose (see graphSlice's own doc comment) — but an incident's
   * root_cause, a domain's ownership, a Zendesk ticket's linked incident are
   * all here because build_graph.py already put them in graph_nodes.props.
   */
  props?: Record<string, unknown>;
}

/** source and target are GraphNode ids (`type:refKey`). */
export interface GraphEdge {
  source: string;
  target: string;
  type: string;
}

export interface GraphSlice {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Set when the slice hit its node cap, so the view can say so. */
  truncated: boolean;
  /** The node the slice is about — a query graph's question, an expansion's
   * parent — so the view knows what to put in the middle. */
  centre?: string;
  /** The evidence a query graph's seeds were found from. */
  evidence?: Evidence[];
}

/** The fixed company-overview subgraphs, which need no question. */
export const GRAPH_VIEWS = [
  "org",
  "timeline",
  "customers",
  "expertise",
  "incidents",
  "documents",
] as const;
export type GraphViewName = (typeof GRAPH_VIEWS)[number];

/** A query graph: the question, and the graph nodes its evidence and its own
 * words point at. */
export interface GraphQueryRequest {
  query: string;
  /** Keep only seeds of these categories (see GRAPH_CATEGORIES). */
  categories?: string[];
  /** How many seeds at most. */
  seeds?: number;
}

/** One node's neighbourhood, or the next page of a cluster's. */
export interface GraphExpandRequest {
  /** A node id (`type:refKey`) or a cluster id from an earlier expansion. */
  id: string;
  categories?: string[];
  /** How many neighbours per category before the rest are folded. */
  budget?: number;
  /** For a cluster id: how many of its category are already drawn — the
   * `offset` its cluster node carries in props — so the next page starts
   * after them. */
  offset?: number;
  /** Include the 420 daily department-plan events, left out by default: a
   * person is on one every day, and they would bury everything else. */
  includePlans?: boolean;
}

/** How to choose a slice: a causal chain from one document, or a filter. */
export interface GraphSliceRequest {
  /** A node id (`type:refKey`), or a bare natural key matching every node
   * that shares it. */
  seed?: string;
  depth?: number;
  category?: string;
  sourceType?: string;
  department?: string;
  /**
   * Keep only nodes of this graph_nodes.node_subtype — 'incident', 'domain',
   * 'confluence' and so on. Narrower than node type, and what the main tab's
   * default view uses to ask for the twelve incidents specifically rather than
   * anything flagged as incident-related.
   */
  subtype?: string;
  /**
   * Keep only nodes of this node type. The filter path otherwise returns
   * anything that is not a person, which is right for a category filter and
   * wrong for the timeline, where only events have a time to be placed at.
   */
  nodeType?: string;
  incidentsOnly?: boolean;
  includeActors?: boolean;
  limit?: number;
  /**
   * Keep only edges of these types (and, transitively, only nodes an
   * edge-of-this-type touches). Drives the person/causal layer tabs — e.g.
   * ['involves'] for who is connected to what, ['caused_by','escalated_via']
   * for the causal chains — without needing a seed or a category filter.
   */
  edgeTypes?: string[];
}

export interface CompanyKnowledge {
  employee(employeeId: string): Promise<EmployeeContext | null>;
  search(query: string, limit: number): Promise<Evidence[]>;
  related(sourceIds: string[], limit: number): Promise<Evidence[]>;
  /**
   * Artifacts that share a cause with the given ones, found by stepping through
   * the simulation event that produced them and returning only what sits on the
   * far side. Weaker evidence than a direct link, and optional: an
   * implementation without the graph simply omits it.
   */
  relatedThroughEvents?(sourceIds: string[], limit: number): Promise<Evidence[]>;
  sources(sourceIds: string[]): Promise<Evidence[]>;
  /**
   * A renderable piece of the deterministic graph. Optional: an implementation
   * without the graph tables omits it.
   */
  graphSlice?(request: GraphSliceRequest): Promise<GraphSlice>;
  /** A question's graph: a centre node for the question, linked to the nodes
   * its evidence and its words point at. */
  graphQuery?(request: GraphQueryRequest): Promise<GraphSlice>;
  /** One node's neighbourhood, by category, ranked and budgeted. */
  graphExpand?(request: GraphExpandRequest): Promise<GraphSlice>;
  /** One of the fixed company-overview subgraphs (see GRAPH_VIEWS), or null
   * for a name that is not one. */
  graphView?(name: string): Promise<GraphSlice | null>;
  close?(): Promise<void>;
}

export interface CompanyQuestion {
  employeeId: string;
  question: string;
  /** User-scoped Letta context. It is context, never Company Evidence. */
  personalMemory?: string;
  /** The last few turns of this conversation, oldest first. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface CompanyAnswer {
  answer: string;
  sources: Evidence[];
  runId: string;
  toolCalls: Array<{ name: string; arguments: unknown }>;
  /** Live panels to show under the answer, in the order the model asked. */
  blocks?: ChatBlock[];
}
