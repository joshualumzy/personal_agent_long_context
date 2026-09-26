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

/** One node of a graph slice. `id` is the natural key: a source id, or a name. */
export interface GraphNode {
  id: string;
  type: "document" | "actor";
  label: string;
  sourceType?: string;
  category?: string;
  department?: string;
  simulationDay?: number;
  isIncident?: boolean;
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
  incidentsOnly?: boolean;
  includeActors?: boolean;
  limit?: number;
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
