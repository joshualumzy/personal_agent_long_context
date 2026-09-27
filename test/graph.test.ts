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
import type { CompanyKnowledge, GraphNode, GraphSlice } from "../src/company-domain.js";
import { graphNodeId, parseGraphNodeId } from "../src/company-domain.js";

function node(type: GraphNode["type"], refKey: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id: `${type}:${refKey}`, refKey, type, label: refKey, ...extra };
}

/** The Departments overview: one department, its lead and a member, a domain. */
const org: GraphSlice = {
  nodes: [
    node("organization", "Engineering_Backend", { subtype: "department", label: "Engineering Backend" }),
    node("person", "Jax", { subtype: "employee" }),
    node("person", "Janice", { subtype: "employee" }),
    node("item", "titandb", { subtype: "domain", label: "TitanDB" }),
  ],
  edges: [
    { source: "person:Jax", target: "organization:Engineering_Backend", type: "leads" },
    { source: "person:Jax", target: "organization:Engineering_Backend", type: "member_of" },
    { source: "person:Janice", target: "organization:Engineering_Backend", type: "member_of" },
    { source: "item:titandb", target: "organization:Engineering_Backend", type: "belongs_to" },
  ],
  truncated: false,
};

/** A question's graph: the question in the middle, three seeds. */
const asked: GraphSlice = {
  nodes: [
    node("query", "TitanDB"),
    node("item", "titandb", { subtype: "domain", label: "TitanDB" }),
    node("event", "ENG-112", { subtype: "incident", label: "Incident ENG-112: missing cost tag" }),
    node("item", "ENG-112", { subtype: "jira", label: "Investigate the cost tag", isIncident: true }),
  ],
  edges: [
    { source: "query:TitanDB", target: "item:titandb", type: "matches" },
    { source: "query:TitanDB", target: "event:ENG-112", type: "matches" },
    { source: "query:TitanDB", target: "item:ENG-112", type: "matches" },
    { source: "event:ENG-112", target: "item:ENG-112", type: "tracked_in" },
  ],
  truncated: false,
  centre: "query:TitanDB",
  evidence: [{ sourceId: "CONF-ENG-002", sourceType: "confluence", title: "TitanDB deep-dive", excerpt: "…" }],
};

/** Expanding the domain: two people and a "+4 more people". */
const titandbNeighbours: GraphSlice = {
  nodes: [
    node("item", "titandb", { subtype: "domain", label: "TitanDB" }),
    node("person", "Yusuf", { subtype: "employee" }),
    node("person", "Priya", { subtype: "employee" }),
    node("cluster", "cluster:people:item:titandb", {
      id: "cluster:people:item:titandb",
      label: "+4 more people",
      props: { parent: "item:titandb", category: "people", hidden: 4, offset: 2 },
    }),
  ],
  edges: [
    { source: "person:Yusuf", target: "item:titandb", type: "owns_domain" },
    { source: "person:Priya", target: "item:titandb", type: "knows_about" },
    { source: "item:titandb", target: "cluster:people:item:titandb", type: "more" },
  ],
  truncated: true,
  centre: "item:titandb",
};

/** The next page of that cluster: the rest, no further cluster. */
const titandbPage: GraphSlice = {
  nodes: [
    node("item", "titandb", { subtype: "domain", label: "TitanDB" }),
    ...["Chloe", "Jamie", "Deepa", "Ben"].map((name) => node("person", name, { subtype: "employee" })),
  ],
  edges: ["Chloe", "Jamie", "Deepa", "Ben"].map((name) => ({
    source: `person:${name}`, target: "item:titandb", type: "knows_about",
  })),
  truncated: false,
  centre: "item:titandb",
};

function graphKnowledge(): CompanyKnowledge {
  return {
    async employee() { return null; },
    async search() { return []; },
    async related() { return []; },
    async sources() { return []; },
    async graphView(name) { return name === "org" ? org : { nodes: [], edges: [], truncated: false }; },
    async graphQuery() { return asked; },
    async graphExpand(request) { return request.offset ? titandbPage : titandbNeighbours; },
  };
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

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

  /** The /graph page in jsdom, with every request answered by `respond` and
   * recorded in `asked`. */
  async function open(path: string, respond: (url: URL) => unknown) {
    const { base } = await start(graphKnowledge());
    const page = path.split("?")[0];
    const [html, script] = await Promise.all([
      fetch(`${base}${page}`).then((response) => response.text()),
      fetch(`${base}/graph/app.js`).then((response) => response.text()),
    ]);
    const dom = new JSDOM(html, { url: `${base}${path}`, runScripts: "outside-only" });
    const { window } = dom;
    const requests: URL[] = [];
    Object.defineProperty(window, "fetch", {
      value: async (url: string) => {
        const parsed = new URL(url, base);
        requests.push(parsed);
        return new Response(JSON.stringify(respond(parsed)), { status: 200 });
      },
      configurable: true,
    });
    window.eval(script);
    await settle();
    return { window, document: window.document, requests };
  }

  const ids = (document: Document) =>
    [...document.querySelectorAll(".node")].map((group) => group.getAttribute("data-id"));

  test("a node id carries its type, because the natural key alone is shared", () => {
    assert.equal(graphNodeId("event", "ENG-112"), "event:ENG-112");
    assert.deepEqual(parseGraphNodeId("event:ENG-112"), { type: "event", refKey: "ENG-112" });
    assert.deepEqual(parseGraphNodeId("ENG-112"), { refKey: "ENG-112" });
    assert.deepEqual(parseGraphNodeId("Standup: Backend"), { refKey: "Standup: Backend" });
    assert.deepEqual(parseGraphNodeId("person:Ana: Ops"), { type: "person", refKey: "Ana: Ops" });
  });

  test("with nothing asked, the page opens on the departments, readable by keyboard and table", async () => {
    const { window, document, requests } = await open("/graph", () => org);

    assert.equal(requests[0]!.pathname, "/api/v1/graph/view/org");
    const nodes = [...document.querySelectorAll(".node")];
    assert.equal(nodes.length, 4);
    assert.ok(nodes.every((group) => group.getAttribute("tabindex") === "0"));
    assert.match(document.querySelector('.node[data-id="organization:Engineering_Backend"]')!
      .getAttribute("aria-label")!, /Department/);
    // One shape per kind, so the picture reads without colour.
    assert.equal(document.querySelectorAll(".node polygon.n-person").length, 2);
    assert.equal(document.querySelectorAll(".node polygon.n-organization").length, 1);
    assert.equal(document.querySelectorAll(".node circle.n-item").length, 1);
    // The table carries the same relationships.
    assert.equal(document.querySelectorAll("#edge-rows tr").length, 4);
    assert.match(document.querySelector("#table-summary")!.textContent!, /4 items, 4 relationships/);
    // The Departments tab says it is the one showing, and the URL says so too.
    assert.equal(document.querySelector('.view-tab[data-view="org"]')!.getAttribute("aria-pressed"), "true");
    assert.match(window.location.search, /view=org/);
    window.close();
  });

  test("each overview tab asks for its own view", async () => {
    const { window, document, requests } = await open("/graph", () => org);
    for (const view of ["expertise", "incidents", "documents", "customers", "timeline"]) {
      document.querySelector<HTMLButtonElement>(`.view-tab[data-view="${view}"]`)!
        .dispatchEvent(new window.Event("click"));
      await settle(20);
      assert.equal(requests.at(-1)!.pathname, `/api/v1/graph/view/${view}`);
    }
    window.close();
  });

  test("the company graph is overviews only; questions have their own page", async () => {
    const { window, document } = await open("/graph", () => org);
    assert.equal(document.querySelector("#ask"), null, "no question box on the company graph");
    assert.equal(document.querySelector('.view-tab[data-view="query"]'), null);
    assert.equal(document.body.dataset.mode, "company");
    // The company graph opens in no one's frame; the answer page opens in the chat's.
    const { base } = await start(graphKnowledge());
    const company = await fetch(`${base}/graph`);
    assert.match(company.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    const answer = await fetch(`${base}/graph/answer?q=x`);
    assert.equal(answer.status, 200);
    assert.match(answer.headers.get("content-security-policy")!, /frame-ancestors 'self'/);
    assert.equal(answer.headers.get("x-frame-options"), "SAMEORIGIN");
    window.close();
  });

  test("an answer's graph is seeded from the evidence the answer cited", async () => {
    const { window, document, requests } = await open(
      "/graph/answer?q=TitanDB&sources=CONF-ENG-002,ENG-112&embed=1",
      (url) => (url.pathname === "/api/v1/graph/query" ? asked : titandbNeighbours),
    );
    const first = requests[0]!;
    assert.equal(first.pathname, "/api/v1/graph/query");
    assert.equal(first.searchParams.get("q"), "TitanDB");
    assert.equal(first.searchParams.get("sources"), "CONF-ENG-002,ENG-112");
    assert.ok(document.body.classList.contains("embedded"), "inside the chat's dialog");
    assert.equal(document.querySelector("#question-title")!.textContent, "TitanDB");

    // Centring on something else is a fresh search, without the answer's sources…
    document.querySelector('.node[data-id="event:ENG-112"]')!.dispatchEvent(new window.Event("focus"));
    const centre = [...document.querySelectorAll("#details button")]
      .find((button) => button.textContent === "Centre on this")!;
    centre.dispatchEvent(new window.Event("click"));
    await settle();
    assert.equal(requests.at(-1)!.searchParams.get("q"), "Incident ENG-112: missing cost tag");
    assert.equal(requests.at(-1)!.searchParams.get("sources"), null);
    assert.equal(document.querySelector("#question-title")!.textContent, "Incident ENG-112: missing cost tag");
    const restore = document.querySelector<HTMLButtonElement>("#restore")!;
    assert.equal(restore.disabled, false, "the way back to the answer's own graph");

    // …and Back to start returns to the answer's graph, sources and all.
    restore.dispatchEvent(new window.Event("click"));
    await settle();
    assert.equal(requests.at(-1)!.searchParams.get("sources"), "CONF-ENG-002,ENG-112");
    window.close();
  });

  test("a question is drawn with itself in the middle, and grows by clicking", async () => {
    const { window, document, requests } = await open("/graph/answer?q=TitanDB", (url) => {
      if (url.pathname === "/api/v1/graph/query") return asked;
      if (url.pathname === "/api/v1/graph/expand") {
        return url.searchParams.get("offset") ? titandbPage : titandbNeighbours;
      }
      return org;
    });

    assert.equal(requests[0]!.pathname, "/api/v1/graph/query");
    assert.equal(requests[0]!.searchParams.get("q"), "TitanDB");
    assert.deepEqual(ids(document).sort(), asked.nodes.map((entry) => entry.id).sort());
    // The question sits at the centre of the picture.
    assert.equal(
      document.querySelector('.node[data-id="query:TitanDB"]')!.getAttribute("transform"),
      "translate(0.0 0.0)",
    );
    // The same key on two kinds of thing is two nodes, each with its own edge.
    assert.ok(ids(document).includes("event:ENG-112") && ids(document).includes("item:ENG-112"));

    // Clicking a seed opens it up: its neighbours are added, nothing is lost,
    // and nothing already drawn moves.
    const before = ids(document);
    const seedSpot = document.querySelector('.node[data-id="event:ENG-112"]')!.getAttribute("transform");
    document.querySelector('.node[data-id="item:titandb"]')!.dispatchEvent(new window.Event("click"));
    await settle();
    const expansion = requests.at(-1)!;
    assert.equal(expansion.pathname, "/api/v1/graph/expand");
    assert.equal(expansion.searchParams.get("id"), "item:titandb");
    const grown = ids(document);
    for (const id of before) assert.ok(grown.includes(id), `${id} should survive the expansion`);
    assert.ok(grown.includes("person:Yusuf") && grown.includes("cluster:people:item:titandb"));
    assert.equal(
      document.querySelector('.node[data-id="event:ENG-112"]')!.getAttribute("transform"),
      seedSpot,
    );

    // Clicking the "+4 more people" pages in the rest, in its place.
    document.querySelector('.node[data-id="cluster:people:item:titandb"]')!
      .dispatchEvent(new window.Event("click"));
    await settle();
    const page = requests.at(-1)!;
    assert.equal(page.searchParams.get("id"), "cluster:people:item:titandb");
    assert.equal(page.searchParams.get("offset"), "2");
    const paged = ids(document);
    assert.ok(!paged.includes("cluster:people:item:titandb"), "the cluster is replaced by what it stood for");
    for (const name of ["Chloe", "Jamie", "Deepa", "Ben"]) assert.ok(paged.includes(`person:${name}`));

    // Back to start returns to the question's own first picture.
    document.querySelector("#restore")!.dispatchEvent(new window.Event("click"));
    await settle(20);
    assert.deepEqual(ids(document).sort(), asked.nodes.map((entry) => entry.id).sort());
    window.close();
  });

  test("the question sits in the middle as a pill with its words inside, and every item says what it is", async () => {
    const { document } = await open("/graph/answer?q=TitanDB", (url) => (url.pathname === "/api/v1/graph/query" ? asked : org));

    const question = document.querySelector('.node[data-id="query:TitanDB"]')!;
    assert.ok(question.querySelector("rect.n-query"), "the question is a pill, not a dot");
    assert.match(question.querySelector("text.pill-label")!.textContent!, /TitanDB/);
    assert.equal(question.querySelector("text.sub"), null, "the pill needs no second line");

    const domain = document.querySelector('.node[data-id="item:titandb"]')!;
    assert.match(domain.querySelector("text.caption")!.textContent!, /TitanDB/);
    assert.match(domain.querySelector("text.sub")!.textContent!, /knowledge domain/i);
  });

  test("the question's evidence is what its details show", async () => {
    const { window, document } = await open("/graph/answer?q=TitanDB", () => asked);
    document.querySelector('.node[data-id="query:TitanDB"]')!.dispatchEvent(new window.Event("focus"));
    const evidenceTab = [...document.querySelectorAll(".detail-tab")]
      .find((button) => button.textContent === "Evidence")!;
    evidenceTab.dispatchEvent(new window.Event("click"));
    await settle(20);
    assert.match(document.querySelector("#details")!.textContent!, /TitanDB deep-dive/);
    window.close();
  });

  test("turning a category off hides it, and expansions stop asking for it", async () => {
    const { window, document, requests } = await open("/graph/answer?q=TitanDB", (url) =>
      url.pathname === "/api/v1/graph/expand" ? titandbNeighbours : asked);

    const people = document.querySelector<HTMLInputElement>("#category-people")!;
    people.checked = false;
    people.dispatchEvent(new window.Event("change"));

    document.querySelector('.node[data-id="item:titandb"]')!.dispatchEvent(new window.Event("click"));
    await settle();
    const categories = requests.at(-1)!.searchParams.get("categories")!.split(",");
    assert.ok(!categories.includes("people"));
    assert.ok(categories.includes("domains"));
    // Nothing of the hidden category is drawn or listed — cluster included.
    assert.ok(ids(document).every((id) => !id!.startsWith("person:") && !id!.startsWith("cluster:people")));
    assert.match(document.querySelector("#status-line")!.textContent!, /hidden by the filters/);
    window.close();
  });

  test("the emergent graph has a page of its own", async () => {
    const { base } = await start(graphKnowledge());
    const page = await fetch(`${base}/graph/emergent`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /emergent\.js/);
    assert.equal((await fetch(`${base}/graph/emergent.js`)).status, 200);
    // The recorded page no longer offers it as a source; it links to it.
    const html = await fetch(`${base}/graph`).then((response) => response.text());
    assert.doesNotMatch(html, /id="source"/);
    assert.match(html, /href="\/graph\/emergent"/);
  });

  test("each question gets its own emergent graph, and it says which question that is", async () => {
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

    const { base } = await start(graphKnowledge());
    const [html, script] = await Promise.all([
      fetch(`${base}/graph/emergent`).then((response) => response.text()),
      fetch(`${base}/graph/emergent.js`).then((response) => response.text()),
    ]);
    const dom = new JSDOM(html, { url: `${base}/graph/emergent`, runScripts: "outside-only" });
    const { window } = dom;
    const requested: string[] = [];
    Object.defineProperty(window, "fetch", {
      value: async (url: string) => {
        const path = String(url);
        requested.push(path);
        if (path.endsWith("/api/v1/graph/emergent")) {
          return new Response(JSON.stringify(index), { status: 200 });
        }
        if (path.includes("/emergent/graphs/")) {
          return new Response(JSON.stringify(emergent), { status: 200 });
        }
        return new Response(JSON.stringify({ enabled: false, running: null }), { status: 200 });
      },
      configurable: true,
    });
    window.eval(script);
    await settle(200);

    const document = window.document;
    // One question is chosen from the ones that have a graph, newest first.
    const picker = document.querySelector("#question") as HTMLSelectElement;
    assert.equal(picker.options.length, 2);
    assert.match(picker.options[0]!.textContent!, /pacing dashboard/);
    assert.ok(requested.some((path) => path.includes("/emergent/graphs/")));

    // Named as one question's reading, and said to contain nothing from others.
    const provenance = document.querySelector("#provenance") as HTMLElement;
    assert.equal(provenance.hidden, false);
    assert.match(provenance.textContent!, /why did the TiDB migration slip/);
    assert.match(provenance.textContent!, /One question, one graph/);

    // Its own taxonomy gets its own shapes.
    assert.equal(document.querySelectorAll(".node circle.n-entity").length, 2);
    assert.equal(document.querySelectorAll(".node rect.n-kind").length, 1);

    // The relationship name is the finding, so it survives into the table and
    // the details.
    assert.match(document.querySelector("#edge-rows")!.textContent!, /blocked by/);
    const jenkins = [...document.querySelectorAll(".node")].find((group) =>
      group.getAttribute("aria-label")?.includes("jenkins"))!;
    jenkins.dispatchEvent(new window.Event("click"));
    assert.match(document.querySelector("#details")!.textContent!, /blocked by/);

    window.close();
  });

  test("a graph name that is not one the exporter makes is refused", async () => {
    const { base } = await start(graphKnowledge());
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
    const { base } = await start(graphKnowledge());
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
    const { base } = await start(graphKnowledge());
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
      companyKnowledge: graphKnowledge(),
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
