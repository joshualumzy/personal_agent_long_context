import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";
import type {
  CompanyKnowledge,
  GraphExpandRequest,
  GraphNode,
  GraphQueryRequest,
  GraphSlice,
} from "../src/company-domain.js";
import {
  budgetNeighbours,
  categoryOf,
  clusterId,
  edgePriority,
  parseClusterId,
  rankNeighbours,
  type NeighbourCandidate,
} from "../src/graph-neighbourhood.js";

function node(type: GraphNode["type"], refKey: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id: `${type}:${refKey}`, refKey, type, label: refKey, ...extra };
}

function candidate(
  parent: string,
  neighbour: GraphNode,
  edgeType: string,
  degree = 1,
): NeighbourCandidate {
  return { node: neighbour, edges: [{ source: parent, target: neighbour.id, type: edgeType }], degree };
}

describe("a neighbourhood cut down to something readable", () => {
  test("every stored kind of node has a category a reader would filter by", () => {
    assert.equal(categoryOf({ type: "person", subtype: "employee" }), "people");
    assert.equal(categoryOf({ type: "person", subtype: "external_contact" }), "partners");
    assert.equal(categoryOf({ type: "organization", subtype: "department" }), "departments");
    assert.equal(categoryOf({ type: "organization", subtype: "customer" }), "partners");
    assert.equal(categoryOf({ type: "item", subtype: "domain" }), "domains");
    assert.equal(categoryOf({ type: "item", subtype: "jira" }), "work");
    assert.equal(categoryOf({ type: "event", subtype: "incident" }), "events");
    assert.equal(categoryOf({ type: "document", subtype: "confluence" }), "documents");
    assert.equal(categoryOf({ type: "query" }), null);
  });

  test("a typed relationship outranks being named together, then the most recent wins", () => {
    const parent = "person:Jax";
    const ranked = rankNeighbours([
      candidate(parent, node("item", "OLD", { props: { occurred_at: "2026-01-02" } }), "involves", 50),
      candidate(parent, node("item", "NEW", { props: { occurred_at: "2026-03-01" } }), "involves"),
      candidate(parent, node("item", "FIXED", { props: { occurred_at: "2026-01-01" } }), "assigned_to"),
    ]);
    assert.deepEqual(ranked.map((entry) => entry.node.refKey), ["FIXED", "NEW", "OLD"]);
    assert.ok(edgePriority("fixed_by") > edgePriority("knows_about"));
    assert.ok(edgePriority("knows_about") > edgePriority("involves"));
  });

  test("each category keeps its budget and folds the rest into one expandable cluster", () => {
    const parent = "item:titandb";
    const people = Array.from({ length: 7 }, (_, index) =>
      candidate(parent, node("person", `P${index}`, { subtype: "employee" }), "knows_about"));
    const docs = Array.from({ length: 2 }, (_, index) =>
      candidate(parent, node("document", `D${index}`, { subtype: "confluence" }), "about_domain"));

    const cut = budgetNeighbours(parent, [...people, ...docs], { budget: 3 });

    const shownPeople = cut.nodes.filter((entry) => entry.type === "person");
    assert.equal(shownPeople.length, 3);
    assert.equal(cut.nodes.filter((entry) => entry.type === "document").length, 2);

    const cluster = cut.nodes.find((entry) => entry.type === "cluster");
    assert.ok(cluster, "the four people not shown should be folded, not dropped");
    assert.equal(cluster!.id, clusterId(parent, "people"));
    assert.equal(cluster!.label, "+4 more people");
    assert.deepEqual(cluster!.props, { parent, category: "people", hidden: 4, offset: 3 });
    assert.ok(cut.edges.some((edge) => edge.source === parent && edge.target === cluster!.id));
    assert.deepEqual(cut.folded, [{ category: "people", hidden: 4 }]);

    // Every node drawn is joined to the parent, so nothing floats.
    for (const shown of cut.nodes) {
      assert.ok(cut.edges.some((edge) => edge.target === shown.id || edge.source === shown.id));
    }
  });

  test("a cluster's next page starts after what is already drawn", () => {
    const parent = "item:titandb";
    const people = Array.from({ length: 7 }, (_, index) =>
      candidate(parent, node("person", `P${index}`, { subtype: "employee" }), "knows_about", 10 - index));
    const first = budgetNeighbours(parent, people, { budget: 3 });
    const next = budgetNeighbours(parent, people, { budget: 3, offset: 3, categories: ["people"] });

    const firstIds = first.nodes.filter((entry) => entry.type === "person").map((entry) => entry.id);
    const nextIds = next.nodes.filter((entry) => entry.type === "person").map((entry) => entry.id);
    assert.equal(nextIds.length, 3);
    assert.ok(nextIds.every((id) => !firstIds.includes(id)));
    assert.equal(next.nodes.find((entry) => entry.type === "cluster")?.label, "+1 more person");
  });

  test("filtering by category drops the others entirely", () => {
    const parent = "person:Jax";
    const cut = budgetNeighbours(parent, [
      candidate(parent, node("item", "ENG-1", { subtype: "jira" }), "assigned_to"),
      candidate(parent, node("item", "titandb", { subtype: "domain" }), "knows_about"),
    ], { budget: 5, categories: ["domains"] });
    assert.deepEqual(cut.nodes.map((entry) => entry.id), ["item:titandb"]);
  });

  test("a cluster id round-trips, and nothing else parses as one", () => {
    assert.deepEqual(parseClusterId(clusterId("person:Jax", "work")), {
      parentId: "person:Jax",
      category: "work",
    });
    assert.equal(parseClusterId("person:Jax"), null);
    assert.equal(parseClusterId("cluster:nonsense:person:Jax"), null);
  });
});

describe("the query and expand routes", () => {
  const started: Array<{ close(): Promise<void> }> = [];
  after(async () => {
    for (const app of started) await app.close();
  });

  async function start(companyKnowledge?: CompanyKnowledge) {
    const app = buildApp({
      memory: new DeterministicMemoryProvider(),
      ...(companyKnowledge ? { companyKnowledge } : {}),
    });
    started.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  const answer: GraphSlice = {
    nodes: [node("query", "TitanDB"), node("item", "titandb", { subtype: "domain" })],
    edges: [{ source: "query:TitanDB", target: "item:titandb", type: "matches" }],
    truncated: false,
    centre: "query:TitanDB",
  };

  function knowledge(queries: GraphQueryRequest[], expansions: GraphExpandRequest[]): CompanyKnowledge {
    return {
      async employee() { return null; },
      async search() { return []; },
      async related() { return []; },
      async sources() { return []; },
      async graphQuery(request) {
        queries.push(request);
        return answer;
      },
      async graphExpand(request) {
        expansions.push(request);
        return request.id === "person:Nobody" ? { nodes: [], edges: [], truncated: false } : answer;
      },
    };
  }

  test("a query passes its words, categories and seat count through", async () => {
    const queries: GraphQueryRequest[] = [];
    const base = await start(knowledge(queries, []));
    const response = await fetch(`${base}/api/v1/graph/query?q=${encodeURIComponent(" TitanDB ")}&categories=domains,%20people&seeds=5`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as GraphSlice).centre, "query:TitanDB");
    assert.deepEqual(queries[0], { query: "TitanDB", categories: ["domains", "people"], seeds: 5 });
  });

  test("a query without words is refused rather than answered with everything", async () => {
    const base = await start(knowledge([], []));
    assert.equal((await fetch(`${base}/api/v1/graph/query?q=%20`)).status, 400);
  });

  test("an expansion passes its node, budget, page and plan choice through", async () => {
    const expansions: GraphExpandRequest[] = [];
    const base = await start(knowledge([], expansions));
    const id = "cluster:people:item:titandb";
    const response = await fetch(`${base}/api/v1/graph/expand?id=${encodeURIComponent(id)}&budget=4&offset=6&includePlans=true`);
    assert.equal(response.status, 200);
    assert.deepEqual(expansions[0], { id, budget: 4, offset: 6, includePlans: true });
  });

  test("expanding a node that does not exist is a 404, and no id is a 400", async () => {
    const base = await start(knowledge([], []));
    assert.equal((await fetch(`${base}/api/v1/graph/expand?id=person:Nobody`)).status, 404);
    assert.equal((await fetch(`${base}/api/v1/graph/expand`)).status, 400);
  });

  test("without the graph configured both routes say so", async () => {
    const base = await start();
    assert.equal((await fetch(`${base}/api/v1/graph/query?q=x`)).status, 503);
    assert.equal((await fetch(`${base}/api/v1/graph/expand?id=x`)).status, 503);
  });
});
