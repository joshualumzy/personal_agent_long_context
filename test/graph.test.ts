import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";
import type {
  CompanyKnowledge,
  GraphSlice,
  GraphSliceRequest,
} from "../src/company-domain.js";

/** One artifact, one event that produced it, one person, and a second artifact. */
const slice: GraphSlice = {
  nodes: [
    { id: "CONF-ENG-022", type: "document", label: "Design: vendor audit", category: "artifact", sourceType: "confluence", department: "Engineering_Backend" },
    { id: "EVT-2-sprint_planned-9", type: "document", label: "Sprint Planned", category: "sim_event", sourceType: "sprint_planned" },
    { id: "HR-101", type: "document", label: "Conduct vendor audit", category: "artifact", sourceType: "jira", isIncident: true },
    { id: "Jax", type: "actor", label: "Jax" },
  ],
  edges: [
    { source: "EVT-2-sprint_planned-9", target: "CONF-ENG-022", type: "references" },
    { source: "EVT-2-sprint_planned-9", target: "HR-101", type: "references" },
    { source: "CONF-ENG-022", target: "Jax", type: "involves" },
  ],
  truncated: false,
};

function knowledgeWithGraph(requests: GraphSliceRequest[]): CompanyKnowledge {
  return {
    async employee() { return null; },
    async search() { return []; },
    async related() { return []; },
    async sources() { return []; },
    async graphSlice(request) {
      requests.push(request);
      return request.seed === "MISSING" ? { nodes: [], edges: [], truncated: false } : slice;
    },
  };
}

describe("the company graph", () => {
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
    return { app, base: `http://127.0.0.1:${port}` };
  }

  test("a slice is requested with the options the caller asked for", async () => {
    const requests: GraphSliceRequest[] = [];
    const { base } = await start(knowledgeWithGraph(requests));

    const response = await fetch(
      `${base}/api/v1/graph?seed=EVT-2-sprint_planned-9&depth=2&includeActors=true`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as GraphSlice;
    assert.equal(body.nodes.length, 4);
    assert.equal(body.edges.length, 3);
    assert.deepEqual(requests[0], {
      seed: "EVT-2-sprint_planned-9",
      depth: 2,
      incidentsOnly: false,
      includeActors: true,
    });
  });

  test("a selection that matches nothing is a 404, not an empty diagram", async () => {
    const { base } = await start(knowledgeWithGraph([]));
    const response = await fetch(`${base}/api/v1/graph?seed=MISSING`);
    assert.equal(response.status, 404);
  });

  test("without the graph configured the route says so rather than failing", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/v1/graph`);
    assert.equal(response.status, 503);
  });

  test("every relationship is in the table, and every node is reachable by keyboard", async () => {
    const { base } = await start(knowledgeWithGraph([]));
    const [html, script] = await Promise.all([
      fetch(`${base}/graph`).then((response) => response.text()),
      fetch(`${base}/graph/app.js`).then((response) => response.text()),
    ]);

    const dom = new JSDOM(html, { url: `${base}/graph`, runScripts: "outside-only" });
    const { window } = dom;
    Object.defineProperty(window, "fetch", {
      value: async () => new Response(JSON.stringify(slice), { status: 200 }),
      configurable: true,
    });
    window.eval(script);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const document = window.document;

    // The diagram: one focusable group per node, each announcing what it is.
    const nodes = [...document.querySelectorAll(".node")];
    assert.equal(nodes.length, 4);
    assert.ok(
      nodes.every((node) => node.getAttribute("tabindex") === "0"),
      "every node has to be a keyboard stop",
    );
    const labels = nodes.map((node) => node.getAttribute("aria-label"));
    assert.ok(labels.some((label) => label?.includes("Person")));
    assert.ok(labels.some((label) => label?.includes("part of an incident")));
    assert.ok(labels.some((label) => label?.includes("Simulation event")));

    // Shape, not just colour, distinguishes the three kinds.
    assert.equal(document.querySelectorAll(".node polygon.n-actor").length, 1);
    assert.equal(document.querySelectorAll(".node rect.n-event").length, 1);
    assert.equal(document.querySelectorAll(".node circle.n-artifact").length, 2);

    // The table carries the same relationships, so the picture is not the only
    // way to read them.
    assert.equal(document.querySelectorAll("#edge-rows tr").length, slice.edges.length);
    assert.match(document.querySelector("#table-summary")!.textContent!, /4 items, 3 relationships/);

    // Selecting a node reports it and what it connects to.
    nodes[0]!.dispatchEvent(new window.Event("click"));
    const details = document.querySelector("#details")!.textContent!;
    assert.match(details, /Design: vendor audit/);
    assert.match(details, /Connected to/);
  });
});
