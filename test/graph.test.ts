import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";
import { EmergentMemory } from "../src/emergent-memory.js";
import type {
  CompanyKnowledge,
  GraphSlice,
  GraphSliceRequest,
} from "../src/company-domain.js";
import { graphNodeId, parseGraphNodeId } from "../src/company-domain.js";

/** One artifact, one event that produced it, one person, and a second artifact. */
const slice: GraphSlice = {
  nodes: [
    { id: "document:CONF-ENG-022", refKey: "CONF-ENG-022", type: "document", label: "Design: vendor audit", category: "artifact", sourceType: "confluence", department: "Engineering_Backend" },
    { id: "event:EVT-2-sprint_planned-9", refKey: "EVT-2-sprint_planned-9", type: "event", label: "Sprint Planned", category: "sim_event", sourceType: "sprint_planned" },
    { id: "item:HR-101", refKey: "HR-101", type: "item", label: "Conduct vendor audit", category: "artifact", sourceType: "jira", isIncident: true },
    { id: "person:Jax", refKey: "Jax", type: "person", label: "Jax" },
  ],
  edges: [
    { source: "event:EVT-2-sprint_planned-9", target: "document:CONF-ENG-022", type: "produced" },
    { source: "event:EVT-2-sprint_planned-9", target: "item:HR-101", type: "produced" },
    { source: "document:CONF-ENG-022", target: "person:Jax", type: "involves" },
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
    assert.ok(labels.some((label) => label?.includes("Event")));
    assert.ok(labels.some((label) => label?.includes("Document")));

    // Shape, not just colour, distinguishes the kinds: one shape per kind.
    assert.equal(document.querySelectorAll(".node polygon.n-person").length, 1);
    assert.equal(document.querySelectorAll(".node rect.n-event").length, 1);
    assert.equal(document.querySelectorAll(".node polygon.n-document").length, 1);
    assert.equal(document.querySelectorAll(".node circle.n-item").length, 1);
    // The incident state is an outline on the shape it already has, never a
    // different fill — otherwise a node loses its kind to its status.
    assert.equal(document.querySelectorAll(".node circle.n-item.incident").length, 1);

    // The table carries the same relationships, so the picture is not the only
    // way to read them.
    assert.equal(document.querySelectorAll("#edge-rows tr").length, slice.edges.length);
    assert.match(document.querySelector("#table-summary")!.textContent!, /4 items, 3 relationships/);

    // Selecting a node reports it and what it connects to.
    nodes[0]!.dispatchEvent(new window.Event("click"));
    const details = document.querySelector("#details")!.textContent!;
    assert.match(details, /Design: vendor audit/);
    assert.match(details, /Connected to/);

    // On the main tab a click also re-centers the graph on the clicked node —
    // a second, background fetch (the mock resolves it immediately, but it is
    // still a promise this test has to let settle before closing the window).
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The page polls on an interval, and jsdom timers are real Node timers, so
    // the window has to be closed or the test process never exits.
    window.close();
  });

  test("clicking a node grows the picture, and Restore original puts it back", async () => {
    // The expansion has to return something the base slice does not, or a
    // merge and a replacement would look identical.
    const expansion: GraphSlice = {
      nodes: [
        { id: "document:CONF-ENG-022", refKey: "CONF-ENG-022", type: "document", label: "Design: vendor audit" },
        { id: "item:NEW-1", refKey: "NEW-1", type: "item", label: "Newly reached ticket" },
      ],
      edges: [{ source: "document:CONF-ENG-022", target: "item:NEW-1", type: "produced" }],
      truncated: false,
    };

    const { base } = await start(knowledgeWithGraph([]));
    const [html, script] = await Promise.all([
      fetch(`${base}/graph`).then((response) => response.text()),
      fetch(`${base}/graph/app.js`).then((response) => response.text()),
    ]);
    const dom = new JSDOM(html, { url: `${base}/graph`, runScripts: "outside-only" });
    const { window } = dom;
    Object.defineProperty(window, "fetch", {
      value: async (url: string) =>
        new Response(
          JSON.stringify(String(url).includes("seed=") ? expansion : slice),
          { status: 200 },
        ),
      configurable: true,
    });
    window.eval(script);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const document = window.document;
    assert.equal(document.querySelectorAll(".node").length, 4, "the first draw");

    // Expanding keeps everything already on screen and adds what it reached.
    const before = [...document.querySelectorAll(".node")]
      .map((node) => node.getAttribute("data-id"));
    document.querySelector('.node[data-id="document:CONF-ENG-022"]')!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 40));

    const after = [...document.querySelectorAll(".node")]
      .map((node) => node.getAttribute("data-id"));
    assert.equal(after.length, 5, "the expansion should add a node, not replace the slice");
    assert.ok(after.includes("item:NEW-1"), "the newly reached node should be drawn");
    for (const id of before) {
      assert.ok(after.includes(id), `${id} should survive an expansion`);
    }

    // Restore original is the way back from a grown picture.
    document.querySelector("#restore")!.dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(document.querySelectorAll(".node").length, 4, "restored to the first draw");

    window.close();
  });

  test("a node id carries its type, because the natural key alone is shared", () => {
    assert.equal(graphNodeId("event", "ENG-112"), "event:ENG-112");
    assert.deepEqual(parseGraphNodeId("event:ENG-112"), { type: "event", refKey: "ENG-112" });
    // A bare key is what a search hit or a typed seed gives: no type, and it
    // matches every node sharing the key.
    assert.deepEqual(parseGraphNodeId("ENG-112"), { refKey: "ENG-112" });
    // Only a known type is a prefix, so a key containing a colon survives.
    assert.deepEqual(parseGraphNodeId("Standup: Backend"), { refKey: "Standup: Backend" });
    assert.deepEqual(parseGraphNodeId("person:Ana: Ops"), { type: "person", refKey: "Ana: Ops" });
  });

  test("an incident and the jira ticket sharing its key are two nodes, each with its own edges", async () => {
    // The corpus keys an incident's event node and its jira item identically
    // ("ENG-112"). Keyed by that alone, the view kept one and attached both
    // nodes' edges to it.
    const shared: GraphSlice = {
      nodes: [
        { id: "event:ENG-112", refKey: "ENG-112", type: "event", subtype: "incident", label: "TitanDB latency incident" },
        { id: "item:ENG-112", refKey: "ENG-112", type: "item", subtype: "jira", label: "Investigate TitanDB latency" },
        { id: "document:CONF-ENG-040", refKey: "CONF-ENG-040", type: "document", label: "Postmortem: TitanDB latency" },
        { id: "event:EVT-7-ticket_progress-3", refKey: "EVT-7-ticket_progress-3", type: "event", label: "Ticket progress" },
      ],
      edges: [
        { source: "event:ENG-112", target: "document:CONF-ENG-040", type: "produced" },
        { source: "event:EVT-7-ticket_progress-3", target: "item:ENG-112", type: "produced" },
      ],
      truncated: false,
    };

    const { base } = await start(knowledgeWithGraph([]));
    const [html, script] = await Promise.all([
      fetch(`${base}/graph`).then((response) => response.text()),
      fetch(`${base}/graph/app.js`).then((response) => response.text()),
    ]);
    const dom = new JSDOM(html, { url: `${base}/graph`, runScripts: "outside-only" });
    const { window } = dom;
    Object.defineProperty(window, "fetch", {
      value: async () => new Response(JSON.stringify(shared), { status: 200 }),
      configurable: true,
    });
    window.eval(script);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const document = window.document;
    const ids = [...document.querySelectorAll(".node")].map((node) => node.getAttribute("data-id"));
    assert.equal(ids.length, 4);
    assert.ok(ids.includes("event:ENG-112") && ids.includes("item:ENG-112"));

    // Each keeps its own relationship, named by label in the table.
    const rows = [...document.querySelectorAll("#edge-rows tr")].map((row) => row.textContent!);
    assert.ok(rows.some((row) => /TitanDB latency incident.*Postmortem/.test(row)));
    assert.ok(rows.some((row) => /Ticket progress.*Investigate TitanDB latency/.test(row)));

    // The details show the natural key a person would cite, not the prefixed id.
    document.querySelector('.node[data-id="item:ENG-112"]')!
      .dispatchEvent(new window.Event("click"));
    const details = document.querySelector("#details")!.textContent!;
    assert.match(details, /ENG-112/);
    assert.doesNotMatch(details, /item:ENG-112/);
    await new Promise((resolve) => setTimeout(resolve, 30));

    window.close();
  });

  test("each question gets its own graph, and it says which question that is", async () => {
    const index = {
      graphs: [
        {
          question: "why did the TiDB migration slip",
          slug: "why_did_the_tidb_migration_slip_50ff7f52",
          extracted_at: "2026-09-26T13:20:00+00:00",
          node_count: 3,
          edge_count: 2,
        },
        {
          question: "what went wrong with the pacing dashboard",
          slug: "what_went_wrong_b40b6a93",
          extracted_at: "2026-09-26T13:30:00+00:00",
          node_count: 2,
          edge_count: 1,
        },
      ],
      semantic_only: true,
    };
    const emergent = {
      nodes: [
        { id: "u1", type: "Entity", label: "tidb" },
        { id: "u2", type: "Entity", label: "jenkins migration step" },
        { id: "u3", type: "EntityType", label: "database" },
      ],
      edges: [
        { source: "u2", target: "u1", type: "blocked_by" },
        { source: "u1", target: "u3", type: "is_a" },
      ],
      meta: {
        source: "cognee",
        question: "why did the TiDB migration slip",
        slug: "why_did_the_tidb_migration_slip_50ff7f52",
        extracted_at: "2026-09-26T13:20:00+00:00",
        semantic_only: true,
      },
    };

    const { base } = await start(knowledgeWithGraph([]));
    const [html, script] = await Promise.all([
      fetch(`${base}/graph`).then((response) => response.text()),
      fetch(`${base}/graph/app.js`).then((response) => response.text()),
    ]);
    const dom = new JSDOM(html, { url: `${base}/graph`, runScripts: "outside-only" });
    const { window } = dom;
    const asked: string[] = [];
    Object.defineProperty(window, "fetch", {
      value: async (url: string) => {
        const path = String(url);
        asked.push(path);
        if (path.endsWith("/api/v1/graph/emergent")) {
          return new Response(JSON.stringify(index), { status: 200 });
        }
        if (path.includes("/emergent/graphs/")) {
          return new Response(JSON.stringify(emergent), { status: 200 });
        }
        return new Response(JSON.stringify(slice), { status: 200 });
      },
      configurable: true,
    });
    window.eval(script);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const document = window.document;
    const source = document.querySelector("#source") as HTMLSelectElement;
    source.value = "emergent";
    source.dispatchEvent(new window.Event("change"));
    document.querySelector("#controls")!.dispatchEvent(new window.Event("submit"));
    await new Promise((resolve) => setTimeout(resolve, 200));

    // One question is chosen from the ones that have a graph, newest first.
    const picker = document.querySelector("#question") as HTMLSelectElement;
    assert.equal((document.querySelector("#question-field") as HTMLElement).hidden, false);
    assert.equal(picker.options.length, 2);
    assert.match(picker.options[0]!.textContent!, /pacing dashboard/);
    assert.ok(
      asked.some((path) => path.includes("/emergent/graphs/")),
      "the chosen question's own graph should be fetched",
    );

    // The slicing controls belong to the recorded graph only.
    assert.equal((document.querySelector("#view-field") as HTMLElement).hidden, true);
    assert.equal((document.querySelector("#legend-emergent") as HTMLElement).hidden, false);
    assert.equal((document.querySelector("#legend-recorded") as HTMLElement).hidden, true);

    // Named as one question's reading, and said to contain nothing from others.
    const provenance = document.querySelector("#provenance") as HTMLElement;
    assert.equal(provenance.hidden, false);
    assert.match(provenance.textContent!, /why did the TiDB migration slip/);
    assert.match(provenance.textContent!, /One question, one graph/);
    assert.doesNotMatch(provenance.textContent!, /pacing dashboard/);

    // Its own taxonomy gets its own shapes.
    assert.equal(document.querySelectorAll(".node circle.n-entity").length, 2);
    assert.equal(document.querySelectorAll(".node rect.n-kind").length, 1);

    // The relationship name is the finding, so it survives into the table and
    // the details instead of being flattened to "references".
    assert.match(document.querySelector("#edge-rows")!.textContent!, /blocked by/);
    const jenkins = [...document.querySelectorAll(".node")].find((node) =>
      node.getAttribute("aria-label")?.includes("jenkins"),
    )!;
    jenkins.dispatchEvent(new window.Event("click"));
    assert.match(document.querySelector("#details")!.textContent!, /blocked by/);

    window.close();
  });

  test("a graph name that is not one the exporter makes is refused", async () => {
    const { base } = await start(knowledgeWithGraph([]));
    for (const slug of ["../../etc/passwd", "Has Capitals", "dots.here"]) {
      const response = await fetch(
        `${base}/api/v1/graph/emergent/graphs/${encodeURIComponent(slug)}`,
      );
      assert.ok(
        response.status === 400 || response.status === 404,
        `${slug} should be refused, got ${response.status}`,
      );
    }
  });

  test("with nothing extracted yet, the emergent route explains how to make one", async () => {
    const { base } = await start(knowledgeWithGraph([]));
    const response = await fetch(`${base}/api/v1/graph/emergent`);
    if (response.status === 404) {
      const body = (await response.json()) as { message: string };
      assert.match(body.message, /cognee_memory\.py/);
    } else {
      // An export from an earlier run is also a valid state.
      assert.equal(response.status, 200);
    }
  });

  test("without extraction configured, the status route says so instead of pretending", async () => {
    const { base } = await start(knowledgeWithGraph([]));
    const response = await fetch(`${base}/api/v1/graph/emergent/status`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { enabled: boolean; running: string | null };
    assert.equal(body.enabled, false);
    assert.equal(body.running, null);
  });

  test("with extraction configured, the status route reports what is in flight", async () => {
    // Held open so the question is still running when the route is asked, then
    // released: a promise that never settles would keep the worker busy for the
    // rest of the process.
    let release: () => void = () => {};
    const held = new Promise<{ code: number; stderr: string }>((resolve) => {
      release = () => resolve({ code: 0, stderr: "" });
    });

    const memory = new EmergentMemory({
      python: "/nonexistent/python",
      projectRoot: "/nonexistent",
      questionsFile: join(mkdtempSync(join(tmpdir(), "em-route-")), "questions.json"),
      run: () => held,
    });
    memory.enqueue("why did the TiDB migration slip");

    const app = buildApp({
      memory: new DeterministicMemoryProvider(),
      companyKnowledge: knowledgeWithGraph([]),
      emergentMemory: memory,
    });
    started.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/graph/emergent/status`);
    const body = (await response.json()) as {
      enabled: boolean;
      running: string | null;
      queued: number;
    };
    assert.equal(body.enabled, true);
    assert.equal(body.running, "why did the TiDB migration slip");
    assert.equal(body.queued, 0);

    release();
  });
});
