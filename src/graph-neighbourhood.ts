/**
 * How a node's neighbourhood is cut down to something readable.
 *
 * A person in this graph touches hundreds of nodes, a domain thousands, so an
 * expansion cannot return everything. Neither can it cut arbitrarily — the
 * first N by id is what made the old layer tabs useless. The rule here: group
 * the neighbours by category, rank each group, keep the first `budget` of
 * each, and fold the rest into one cluster node per category that says how
 * many there are and can itself be expanded.
 *
 * Pure: the adapter fetches the candidates, this decides which are shown.
 */
import type { GraphEdge, GraphNode } from "./company-domain.js";

/** What a reader filters by. Coarser than node type on purpose: a reader
 * thinks "people" and "customers & vendors", not "person/external_contact". */
export const GRAPH_CATEGORIES = [
  "people",
  "departments",
  "domains",
  "work",
  "events",
  "documents",
  "partners",
] as const;
export type GraphCategory = (typeof GRAPH_CATEGORIES)[number];

export function isGraphCategory(value: string): value is GraphCategory {
  return (GRAPH_CATEGORIES as readonly string[]).includes(value);
}

export function categoryOf(node: Pick<GraphNode, "type" | "subtype">): GraphCategory | null {
  switch (node.type) {
    case "person":
      // Someone writing in for a vendor or customer is part of that
      // relationship, not of the company's own people.
      return node.subtype === "external_contact" ? "partners" : "people";
    case "organization":
      return node.subtype === "department" ? "departments" : "partners";
    case "item":
      return node.subtype === "domain" ? "domains" : "work";
    case "event":
      return "events";
    case "document":
      return "documents";
    default:
      return null;
  }
}

/**
 * How much an edge says about why two nodes are related. A typed relationship
 * ("fixed by", "wrote", "member of") outranks being named together
 * ("involves"), and a page counting toward a domain's documentation
 * ("updates domain", 5.5 domains a page) is the weakest statement of all.
 */
const EDGE_PRIORITY: Record<string, number> = {
  tracked_in: 3,
  fixed_by: 3,
  implemented_by: 3,
  documented_by: 3,
  produced: 3,
  caused_by: 3,
  wrote: 3,
  about_domain: 3,
  for_customer: 3,
  from_vendor: 3,
  contact_for: 3,
  member_of: 3,
  leads: 3,
  belongs_to: 3,
  owns_domain: 3,
  cites: 3,
  part_of: 3,
  raised_by: 3,
  received_by: 3,
  authored_by: 2,
  reviewed_by: 2,
  led_by: 2,
  assigned_to: 2,
  knows_about: 2,
  involves: 1,
  updates_domain: 1,
};

export function edgePriority(edgeType: string): number {
  return EDGE_PRIORITY[edgeType] ?? 1;
}

/** One neighbour of the node being expanded, with every edge joining them. */
export interface NeighbourCandidate {
  node: GraphNode;
  edges: GraphEdge[];
  /** Total edges the neighbour has, anywhere in the graph. */
  degree: number;
}

export interface BudgetedNeighbourhood {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Whole categories folded away, with how many were not shown. */
  folded: Array<{ category: GraphCategory; hidden: number }>;
}

/** When something happened, for recency ranking: events and items carry
 * occurred_at, incidents opened_at. */
function timeOf(node: GraphNode): string {
  const props = node.props ?? {};
  const value = props.occurred_at ?? props.opened_at;
  return typeof value === "string" ? value : "";
}

export function rankNeighbours(candidates: NeighbourCandidate[]): NeighbourCandidate[] {
  const strength = (candidate: NeighbourCandidate) =>
    Math.max(...candidate.edges.map((edge) => edgePriority(edge.type)));
  return [...candidates].sort(
    (left, right) =>
      strength(right) - strength(left) ||
      timeOf(right.node).localeCompare(timeOf(left.node)) ||
      right.degree - left.degree ||
      left.node.label.localeCompare(right.node.label),
  );
}

export function clusterId(parentId: string, category: GraphCategory): string {
  return `cluster:${category}:${parentId}`;
}

/** The inverse of clusterId, or null for anything that is not one. */
export function parseClusterId(id: string): { parentId: string; category: GraphCategory } | null {
  const match = /^cluster:([a-z]+):(.+)$/.exec(id);
  if (!match || !isGraphCategory(match[1]!)) return null;
  return { category: match[1] as GraphCategory, parentId: match[2]! };
}

const CATEGORY_NOUN: Record<GraphCategory, [string, string]> = {
  people: ["person", "people"],
  departments: ["department", "departments"],
  domains: ["domain", "domains"],
  work: ["work item", "work items"],
  events: ["event", "events"],
  documents: ["document", "documents"],
  partners: ["customer or vendor", "customers and vendors"],
};

/**
 * Keep the best `budget` neighbours of each category (after skipping the
 * first `offset`, which a cluster's own expansion uses to page past what is
 * already drawn), and fold each category's remainder into one cluster node
 * joined to the parent.
 */
export function budgetNeighbours(
  parentId: string,
  candidates: NeighbourCandidate[],
  options: { budget: number; offset?: number; categories?: GraphCategory[] },
): BudgetedNeighbourhood {
  const offset = options.offset ?? 0;
  const wanted = options.categories && options.categories.length > 0
    ? new Set(options.categories)
    : null;

  const byCategory = new Map<GraphCategory, NeighbourCandidate[]>();
  for (const candidate of candidates) {
    const category = categoryOf(candidate.node);
    if (!category || (wanted && !wanted.has(category))) continue;
    const group = byCategory.get(category) ?? [];
    group.push(candidate);
    byCategory.set(category, group);
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const folded: BudgetedNeighbourhood["folded"] = [];

  for (const category of GRAPH_CATEGORIES) {
    const group = byCategory.get(category);
    if (!group) continue;
    const ranked = rankNeighbours(group).slice(offset);
    const shown = ranked.slice(0, options.budget);
    for (const candidate of shown) {
      nodes.push(candidate.node);
      edges.push(...candidate.edges);
    }

    const hidden = ranked.length - shown.length;
    if (hidden > 0) {
      const [one, many] = CATEGORY_NOUN[category];
      const id = clusterId(parentId, category);
      nodes.push({
        id,
        refKey: id,
        type: "cluster",
        label: `+${hidden} more ${hidden === 1 ? one : many}`,
        props: { parent: parentId, category, hidden, offset: offset + shown.length },
      });
      edges.push({ source: parentId, target: id, type: "more" });
      folded.push({ category, hidden });
    }
  }

  return { nodes, edges, folded };
}
