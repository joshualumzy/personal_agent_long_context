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

/** One node of a graph slice. `id` is the natural key: a source id, a domain
 * key, or a resolved person name. */
export interface GraphNode {
  id: string;
  type: "person" | "organization" | "item" | "event" | "document";
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
}

/** How to choose a slice: a causal chain from one document, or a filter. */
export interface GraphSliceRequest {
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
