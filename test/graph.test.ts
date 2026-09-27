import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { createSessionToken } from "../src/auth.js";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";
import { EmergentMemory } from "../src/emergent-memory.js";
import type { CompanyKnowledge, GraphNode, GraphQueryRequest, GraphSlice } from "../src/company-domain.js";
import { graphNodeId, parseGraphNodeId } from "../src/company-domain.js";
import type { ConversationMessage, ConversationStore, ConversationSummary } from "../src/conversation-domain.js";
import type { MeetingActions, MeetingState } from "../src/meetings/domain.js";

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

/** The documents web: two pages, their author, a domain, the discussion one
 * came from, and a "Page created" event that is folded away. */
const documentsWeb: GraphSlice = {
    nodes: [
      node("document", "CONF-1", {
        subtype: "confluence", label: "TitanDB runbook", props: { occurred_at: "2026-01-10T09:00:00+00:00" },
      }),
      node("document", "CONF-2", {
        subtype: "confluence", label: "TitanDB migration notes", props: { occurred_at: "2026-02-03T09:00:00+00:00" },
      }),
      node("person", "Priya", { subtype: "employee" }),
      node("item", "titandb", { subtype: "domain", label: "TitanDB" }),
      node("event", "EVT-1", { subtype: "confluence_created", label: "Page created: TitanDB runbook" }),
      node("event", "DD-1", {
        subtype: "design_discussion", label: "Discussion: migrate TitanDB", props: { occurred_at: "2026-02-01T09:00:00+00:00" },
      }),
    ],
    edges: [
      { source: "event:EVT-1", target: "document:CONF-1", type: "produced" },
      { source: "event:DD-1", target: "document:CONF-2", type: "produced" },
      { source: "person:Priya", target: "document:CONF-1", type: "wrote" },
      { source: "person:Priya", target: "document:CONF-2", type: "wrote" },
      { source: "document:CONF-1", target: "item:titandb", type: "about_domain" },
      { source: "document:CONF-2", target: "document:CONF-1", type: "cites" },
    ],
    truncated: false,
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
  /** With `frames`, the page gets animation frames (jsdom has none), so what
   * animates can be watched. */
  async function open(path: string, respond: (url: URL) => unknown, { frames = false } = {}) {
    const { base } = await start(graphKnowledge());
    const page = path.split("?")[0];
    const [html, script] = await Promise.all([
      fetch(`${base}${page}`).then((response) => response.text()),
      fetch(`${base}/graph/app.js`).then((response) => response.text()),
    ]);
    const dom = new JSDOM(html, { url: `${base}${path}`, runScripts: "outside-only" });
    const { window } = dom;
    if (frames) {
      window.eval(`
        window.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 16);
        window.cancelAnimationFrame = (handle) => clearTimeout(handle);`);
    }
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

  test("with nothing asked, the page opens on the documents web, which items can be pulled around in", async () => {
    const { window, document, requests } = await open("/graph", () => documentsWeb);

    assert.equal(requests[0]!.pathname, "/api/v1/graph/view/documents");
    assert.equal(document.querySelector('.view-tab[data-view="documents"]')!.getAttribute("aria-pressed"), "true");
    // A "Page created" event only repeats the page it made, so it is folded
    // away with its line; the discussion that led to a page stays.
    assert.deepEqual(ids(document).sort(), [
      "document:CONF-1", "document:CONF-2", "event:DD-1", "item:titandb", "person:Priya",
    ]);
    // Drawn as arcs.
    assert.equal(document.querySelectorAll("#canvas path.edge").length, 5);
    // Laid out by forces: settled, and no two items on the same spot.
    assert.ok(document.querySelector("#canvas")!.classList.contains("force"));
    const spots = ids(document).map((id) =>
      document.querySelector(`.node[data-id="${id}"]`)!.getAttribute("transform"));
    assert.equal(new Set(spots).size, spots.length);

    // Dragging an item leaves it where it was dropped, and letting go is not
    // a click that opens it up.
    const priya = document.querySelector('.node[data-id="person:Priya"]')!;
    const [x, y] = priya.getAttribute("transform")!.match(/-?[\d.]+/g)!.map(Number);
    priya.querySelector(".shape")!.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 }));
    window.dispatchEvent(new window.MouseEvent("pointermove", { clientX: 100, clientY: 50 }));
    window.dispatchEvent(new window.MouseEvent("pointerup", { clientX: 100, clientY: 50 }));
    priya.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(priya.getAttribute("transform"), `translate(${(x! + 100).toFixed(1)} ${(y! + 50).toFixed(1)})`);
    const trail = () => [...document.querySelectorAll("#trail button, #trail .trail-here")].map((step) => step.textContent);
    assert.deepEqual(trail(), ["TitanDB migration notes"], "the drop did not refocus");
    window.close();
  });

  test("the documents web opens on one focus, lit with its neighbours, and a click moves the focus", async () => {
    const { window, document, requests } = await open("/graph", () => documentsWeb);
    const lit = (id: string) => document.querySelector(`.node[data-id="${id}"]`)!.getAttribute("class")!;
    // The most connected item is the focus (CONF-1 and CONF-2 tie; by name),
    // its neighbours are near, the next ring is mid, and its lines are named.
    assert.match(lit("document:CONF-2"), /the-focus/);
    for (const id of ["document:CONF-1", "person:Priya", "event:DD-1"]) assert.match(lit(id), /\bnear\b/);
    assert.match(lit("item:titandb"), /\bmid\b/);
    // Every line between lit items is named, the neighbours' own links too
    // (Priya also wrote CONF-1), and points the way it reads.
    assert.deepEqual([...document.querySelectorAll(".edge-label")].map((label) => label.textContent).sort(),
      ["cites", "produced", "wrote", "wrote"]);
    assert.equal(document.querySelectorAll(".edge-arrow.story").length, 4);
    // The way a line reads is a soft bead at its far end, not a spike: the web floats.
    assert.equal(document.querySelectorAll("circle.edge-arrow.story").length, 4);
    assert.match(document.querySelector("#details .name")!.textContent!, /TitanDB migration notes/);

    // Clicking a neighbour makes it the focus, with a trail back; it does not
    // ask the server for more.
    document.querySelector('.node[data-id="person:Priya"]')!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.match(lit("person:Priya"), /the-focus/);
    const trail = () => [...document.querySelectorAll("#trail button, #trail .trail-here")].map((step) => step.textContent);
    assert.deepEqual(trail(), ["TitanDB migration notes", "Priya"]);
    assert.ok(!requests.some((url) => url.pathname === "/api/v1/graph/expand"));
    document.querySelector<HTMLButtonElement>("#trail button")!.dispatchEvent(new window.Event("click"));
    assert.match(lit("document:CONF-2"), /the-focus/);
    assert.deepEqual(trail(), ["TitanDB migration notes"]);
    window.close();
  });

  test("the focus's neighbours spread round it, never bunched, though not evenly spaced either", async () => {
    // The documents web as the record draws it (test/fixtures/documents-web.json,
    // exported from the demo company): kubernetes-deploy, the most connected,
    // with five pages and incidents about it, the incidents joined to their
    // write-ups, and all of them to people and pages of their own.
    const record = JSON.parse(readFileSync(new URL("./fixtures/documents-web.json", import.meta.url), "utf8")) as GraphSlice;
    const { window, document } = await open("/graph", () => record);
    assert.match(document.querySelector('.node[data-id="item:kubernetes-deploy"]')!.getAttribute("class")!, /the-focus/);
    const at = (id: string) => document.querySelector(`.node[data-id="${id}"]`)!
      .getAttribute("transform")!.match(/-?[\d.]+/g)!.map(Number);
    const [cx, cy] = at("item:kubernetes-deploy");
    const near = [...document.querySelectorAll(".node.near:not(.the-focus)")].map((group) => group.getAttribute("data-id")!);
    const angles = near.map((id) => { const [x, y] = at(id); return (Math.atan2(y - cy, x - cx) * 180) / Math.PI; })
      .sort((a, b) => a - b);
    const gaps = angles.map((angle, i) => (i + 1 < angles.length ? angles[i + 1]! : angles[0]! + 360) - angle);
    // The incidents and their write-ups pull each other together, into thin
    // slivers with the focus; each gap keeps most of an even share.
    const share = 360 / near.length;
    assert.ok(Math.min(...gaps) >= share * 0.6, `gaps ${gaps.map((gap) => gap.toFixed(0)).join(", ")}`);
    window.close();
  });

  test("the settled documents web floats smoothly, its layout still", async () => {
    const { window, document } = await open("/graph", () => documentsWeb, { frames: true });
    // The float runs until the window closes, whatever the assertions do.
    try {
      await settle(2600);
      const drawn = (id: string) => document.querySelector(`.node[data-id="${id}"]`)!
        .getAttribute("transform")!.match(/-?[\d.]+/g)!.map(Number);
      const samples: Array<{ priya: number[]; page: number[] }> = [];
      for (let count = 0; count < 6; count += 1) {
        samples.push({ priya: drawn("person:Priya"), page: drawn("document:CONF-1") });
        await settle(250);
      }
      const xs = samples.map((sample) => sample.priya[0]!);
      const ys = samples.map((sample) => sample.priya[1]!);
      // Things move on screen…
      assert.ok(Math.max(...xs) - Math.min(...xs) > 0.5 || Math.max(...ys) - Math.min(...ys) > 0.5, "it floats");
      // …within the float's reach, so the layout underneath is not moving…
      assert.ok(Math.max(...xs) - Math.min(...xs) <= 14 && Math.max(...ys) - Math.min(...ys) <= 14);
      // …and neighbours sway together: the line between them keeps its length.
      const length = ({ priya, page }: { priya: number[]; page: number[] }) =>
        Math.hypot(priya[0]! - page[0]!, priya[1]! - page[1]!);
      const lengths = samples.map(length);
      assert.ok(Math.max(...lengths) - Math.min(...lengths) < 2, `line length held: ${lengths.map((value) => value.toFixed(1))}`);
    } finally {
      window.close();
    }
  });

  test("the departments overview is readable by keyboard and table", async () => {
    const { window, document, requests } = await open("/graph?view=org", () => org);

    assert.equal(requests[0]!.pathname, "/api/v1/graph/view/org");
    const nodes = [...document.querySelectorAll(".node")];
    assert.equal(nodes.length, 4);
    assert.ok(nodes.every((group) => group.getAttribute("tabindex") === "0"));
    assert.match(document.querySelector('.node[data-id="organization:Engineering_Backend"]')!
      .getAttribute("aria-label")!, /Department/);
    // One shape per kind, so the picture reads without colour.
    assert.equal(document.querySelectorAll(".node .shape.n-person").length, 2);
    assert.equal(document.querySelectorAll(".node .shape.n-organization").length, 1);
    // Corners are soft, as the rest of the picture is: drawn as rounded paths, never sharp polygons.
    assert.equal(document.querySelectorAll(".node polygon.shape").length, 0);
    assert.match(document.querySelector(".node path.n-person")!.getAttribute("d")!, /Q/);
    assert.equal(document.querySelectorAll(".node circle.n-item").length, 1);
    // The table carries the same relationships.
    assert.equal(document.querySelectorAll("#edge-rows tr").length, 4);
    assert.match(document.querySelector("#table-summary")!.textContent!, /4 items, 4 relationships/);
    // The Departments tab says it is the one showing, and the URL says so too.
    assert.equal(document.querySelector('.view-tab[data-view="org"]')!.getAttribute("aria-pressed"), "true");
    assert.match(window.location.search, /view=org/);
    // Under the tabs, what the chosen overview answers.
    assert.match(document.querySelector("#view-about")!.textContent!, /who leads it/);
    window.close();
  });

  test("each overview tab asks for its own view", async () => {
    const { window, document, requests } = await open("/graph", () => org);
    for (const view of ["org", "expertise", "incidents", "documents", "customers", "timeline"]) {
      document.querySelector<HTMLButtonElement>(`.view-tab[data-view="${view}"]`)!
        .dispatchEvent(new window.Event("click"));
      await settle(20);
      assert.equal(requests.at(-1)!.pathname, `/api/v1/graph/view/${view}`);
    }
    window.close();
  });

  test("Where today touched leads the Work group, and is what ?view=today opens on", async () => {
    const today: GraphSlice & { touched: string[] } = {
      nodes: [
        node("query", "Today"),
        node("event", "NOC-1", { subtype: "meeting", label: "NOC call" }),
        node("item", "ENG-210", { subtype: "jira", label: "Fix the ingestion race", isIncident: true }),
      ],
      edges: [
        { source: "query:Today", target: "event:NOC-1", type: "matches" },
        { source: "query:Today", target: "item:ENG-210", type: "matches" },
      ],
      truncated: false,
      centre: "query:Today",
      touched: ["event:NOC-1", "item:ENG-210"],
    };
    const { window, document, requests } = await open("/graph?view=today", (url) =>
      url.pathname === "/api/v1/graph/today" ? today : org);

    assert.equal(requests[0]!.pathname, "/api/v1/graph/today");
    const work = [...document.querySelectorAll('[aria-labelledby="group-work"] .view-tab')].map((button) => button.getAttribute("data-view"));
    assert.equal(work[0], "today");
    assert.equal(document.querySelector('.view-tab[data-view="today"]')!.getAttribute("aria-pressed"), "true");

    // What today touched carries the butter highlight; the centre pill does not.
    assert.ok(document.querySelector('.node[data-id="event:NOC-1"] .shape')!.classList.contains("touched"));
    assert.ok(document.querySelector('.node[data-id="item:ENG-210"] .shape')!.classList.contains("touched"));
    assert.ok(!document.querySelector('.node[data-id="query:Today"] .shape')!.classList.contains("touched"));
    window.close();
  });

  test("nothing today touched, the page says so instead of drawing a silent empty picture", async () => {
    const { window, document } = await open("/graph?view=today", (url) =>
      url.pathname === "/api/v1/graph/today" ? { nodes: [], edges: [], truncated: false, touched: [] } : org);

    assert.equal(document.querySelectorAll(".node").length, 0);
    assert.match(document.querySelector("#status-line")!.textContent!, /nothing/i);
    assert.match(document.querySelector("#details")!.textContent!, /nothing/i);
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

  test("an answer's graph gives the picture the room: how to read it sits in the side rail, briefly", async () => {
    const { document } = await open("/graph/answer?q=TitanDB&embed=1", (url) => (url.pathname === "/api/v1/graph/query" ? asked : org));

    const rail = document.querySelector("aside.rail")!;
    assert.ok(rail.querySelector("#details"), "details lead the rail");
    assert.ok(rail.querySelector("#canvas-help"), "how to read it is in the rail");
    assert.ok(rail.querySelector("#legend"), "and so are the shapes");
    assert.equal(document.querySelector("#picture #canvas-help"), null, "not under the picture");
    assert.equal(document.querySelector("#picture h2"), null, "the picture needs no heading");
    assert.ok(document.querySelector("#picture .picture-actions #fit"), "Fit stays with the picture");
    assert.ok(document.querySelector("#canvas-help")!.textContent!.trim().length < 140, "one or two short lines");
    assert.doesNotMatch(document.querySelector("#details")!.textContent!, /Click anything/, "the rail does not say it twice");
  });

  test("a department's lead is drawn apart from its members", async () => {
    const { window, document } = await open("/graph?view=org", () => org);
    const jax = document.querySelector('.node[data-id="person:Jax"]')!;
    assert.ok(jax.classList.contains("lead"));
    assert.match(jax.querySelector(".caption")!.textContent!, /Jax · lead/);
    assert.ok(!document.querySelector('.node[data-id="person:Janice"]')!.classList.contains("lead"));
    assert.equal(document.querySelectorAll("#canvas line.edge.leads").length, 1);
    // People sit left of their department, so their names go on the left,
    // clear of their own lines.
    assert.ok(document.querySelector('.node[data-id="person:Janice"] .caption')!.classList.contains("left"));
    assert.match(document.querySelector("#edge-legend")!.textContent!, /Leads/);

    // Hovering an item lights it and what it is joined to, and nothing else.
    document.querySelector('.node[data-id="item:titandb"]')!.dispatchEvent(new window.Event("mouseenter"));
    const lit = [...document.querySelectorAll(".node.on")].map((group) => group.getAttribute("data-id")).sort();
    assert.deepEqual(lit, ["item:titandb", "organization:Engineering_Backend"]);
    document.querySelector('.node[data-id="item:titandb"]')!.dispatchEvent(new window.Event("mouseleave"));
    assert.equal(document.querySelectorAll(".node.on").length, 0);
    window.close();
  });

  test("opening an item under the pointer does not leave the new picture faded", async () => {
    const { window, document } = await open("/graph/answer?q=TitanDB", (url) =>
      url.pathname === "/api/v1/graph/expand" ? titandbNeighbours : asked);
    const titandb = document.querySelector('.node[data-id="item:titandb"]')!;
    titandb.dispatchEvent(new window.Event("mouseenter"));
    assert.ok(document.querySelector("#canvas")!.classList.contains("focus"));
    titandb.dispatchEvent(new window.Event("click"));
    await settle();
    assert.ok(ids(document).includes("person:Yusuf"), "it opened up");
    assert.ok(!document.querySelector("#canvas")!.classList.contains("focus"));
    window.close();
  });

  test("who knows what is a matrix of domains by departments", async () => {
    const expertise: GraphSlice = {
      nodes: [
        node("organization", "Engineering_Backend", { subtype: "department", label: "Engineering Backend" }),
        node("organization", "Engineering_Mobile", { subtype: "department", label: "Engineering Mobile" }),
        node("person", "Jax", { subtype: "employee" }),
        node("person", "Janice", { subtype: "employee" }),
        node("person", "Chloe", { subtype: "employee" }),
        node("person", "Bill", { subtype: "employee" }),
        node("item", "redis-cache", {
          subtype: "domain", label: "redis-cache",
          props: { primary_owner: "Jax", former_owner: "Chloe" },
        }),
        node("item", "titandb", {
          subtype: "domain", label: "TitanDB",
          props: { primary_owner: "Janice", former_owner: "Bill" },
        }),
      ],
      edges: [
        { source: "person:Jax", target: "organization:Engineering_Backend", type: "member_of" },
        { source: "person:Janice", target: "organization:Engineering_Backend", type: "member_of" },
        { source: "person:Chloe", target: "organization:Engineering_Mobile", type: "member_of" },
        { source: "person:Jax", target: "item:titandb", type: "knows_about" },
        { source: "person:Chloe", target: "item:redis-cache", type: "knows_about" },
        { source: "person:Bill", target: "item:titandb", type: "owns_domain" },
      ],
      truncated: false,
    };
    const { window, document } = await open("/graph?view=expertise", () => expertise);

    assert.ok(document.querySelector("#canvas")!.hasAttribute("hidden"), "no diagram for this view");
    const rows = [...document.querySelectorAll(".matrix tbody tr")];
    // Domains by name. OrgForge's own gap flag is the hiring backtest's answer
    // key (test/gap-boundary.test.ts): the page neither sorts nor tags by it.
    assert.deepEqual(rows.map((row) => row.querySelector("th")!.textContent), ["redis-cache", "TitanDB"]);
    assert.equal(document.querySelector(".gap-tag"), null);
    const titandb = rows[1]!;
    // One of Backend's two people knows TitanDB; no one in Mobile does.
    const cells = [...titandb.querySelectorAll("td.cell button")].map((button) => button.textContent);
    assert.deepEqual(cells, ["50", "0"]);
    // Bill owned it and is in no department any more; Chloe owned redis-cache
    // and still works here.
    const owners = titandb.querySelectorAll("td.owner");
    assert.match(owners[1]!.textContent!, /Bill.*no longer here/);
    assert.ok(owners[1]!.classList.contains("left"));
    assert.ok(!rows[0]!.querySelectorAll("td.owner")[1]!.classList.contains("left"));

    // A cell opens up to the people behind the number.
    titandb.querySelector<HTMLButtonElement>("td.cell button")!.dispatchEvent(new window.Event("click"));
    assert.match(document.querySelector("#details")!.textContent!, /TitanDB in Engineering Backend.*1 of 2 people.*Jax/);
    // The table still lists every relationship.
    assert.equal(document.querySelectorAll("#edge-rows tr").length, 6);
    window.close();
  });

  test("incidents are rows under their cause, and one opens into its own drawing", async () => {
    const incidents: GraphSlice = {
      nodes: [
        node("event", "ENG-112", {
          subtype: "incident", label: "Incident ENG-112: missing cost tag",
          props: { opened_at: "2026-01-05T09:00:00+00:00" },
        }),
        node("event", "ENG-173", {
          subtype: "incident", label: "Incident ENG-173: HPA misconfigured",
          props: { opened_at: "2026-02-04T09:00:00+00:00" },
        }),
        node("event", "ZD-101", {
          subtype: "zd_ticket", label: "ZD-101 from Metro United FC",
          props: { occurred_at: "2026-02-17T09:00:00+00:00" },
        }),
        node("item", "ENG-112", { subtype: "jira", label: "Investigate the cost tag" }),
        node("item", "PR-106", { subtype: "pr" }),
        node("item", "kubernetes-deploy", { subtype: "domain" }),
        node("document", "CONF-ENG-054", { subtype: "confluence", label: "Postmortem: ENG-112" }),
        node("person", "Sanjay", { subtype: "employee" }),
        node("person", "Jax", { subtype: "employee" }),
      ],
      edges: [
        { source: "event:ENG-112", target: "person:Sanjay", type: "raised_by" },
        { source: "event:ENG-112", target: "person:Jax", type: "received_by" },
        { source: "event:ENG-112", target: "item:ENG-112", type: "tracked_in" },
        { source: "event:ENG-112", target: "item:PR-106", type: "fixed_by" },
        { source: "event:ENG-112", target: "document:CONF-ENG-054", type: "produced" },
        { source: "event:ENG-112", target: "item:kubernetes-deploy", type: "about_domain" },
        { source: "item:ENG-112", target: "item:kubernetes-deploy", type: "about_domain" },
        { source: "event:ENG-173", target: "event:ENG-112", type: "caused_by" },
        { source: "event:ZD-101", target: "event:ENG-173", type: "caused_by" },
      ],
      truncated: false,
    };
    const { window, document } = await open("/graph?view=incidents", () => incidents);

    // One chain: the cause, then what followed, each a step further in. The
    // ticket that shares the incident's key is not a row of its own.
    const groups = document.querySelectorAll(".lane-group");
    assert.equal(groups.length, 1);
    const rows = [...groups[0]!.querySelectorAll("button.lane")];
    assert.deepEqual(rows.map((row) => row.querySelector(".what b")!.textContent), ["ENG-112", "ENG-173", "ZD-101"]);
    assert.deepEqual(rows.map((row) => (row as HTMLElement).style.getPropertyValue("--depth").trim()), ["0", "1", "2"]);
    assert.match(rows[0]!.textContent!, /Sanjay → Jax.*PR-106.*CONF-ENG-054.*kubernetes-deploy/);
    assert.doesNotMatch(rows[0]!.textContent!, /tracked in/);
    assert.match(groups[0]!.textContent!, /2 more followed from ENG-112/);

    // Choosing it draws it with what it is directly joined to, each line named.
    rows[0]!.dispatchEvent(new window.Event("click"));
    assert.ok(!document.querySelector("#canvas")!.hasAttribute("hidden"));
    assert.deepEqual(ids(document).sort(), [
      "document:CONF-ENG-054", "event:ENG-112", "event:ENG-173", "item:PR-106",
      "item:kubernetes-deploy", "person:Jax", "person:Sanjay",
    ]);
    assert.equal(
      document.querySelector('.node[data-id="event:ENG-112"]')!.getAttribute("transform"),
      "translate(0.0 0.0)",
    );
    const labels = [...document.querySelectorAll(".edge-label")].map((label) => label.textContent);
    assert.ok(labels.includes("fixed by") && labels.includes("caused by"));
    assert.equal(document.querySelectorAll(".edge-arrow").length, 1, "the chain has an arrowhead");

    // Back to start returns to the rows.
    const restore = document.querySelector<HTMLButtonElement>("#restore")!;
    assert.equal(restore.disabled, false);
    restore.dispatchEvent(new window.Event("click"));
    assert.ok(document.querySelector("#canvas")!.hasAttribute("hidden"));
    assert.equal(document.querySelectorAll("button.lane").length, 3);
    window.close();
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
    // The Show menu's button says a filter is on, once the menu is closed.
    assert.equal(document.querySelector("#show-summary")!.textContent, "6 of 7");
    assert.ok(document.querySelector("#show-menu")!.classList.contains("filtered"));
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

// -----------------------------------------------------------------------
// GET /api/v1/graph/today: "Where today touched", the company graph slice
// built from the evidence the signed-in employee's own meetings and
// conversations cited today.
// -----------------------------------------------------------------------

/** A day's-ago-and-hour ISO timestamp built from local calendar components,
 * so it reads as "today" (or "yesterday") the same way the route's own
 * localDay() does, whatever the machine's time zone. */
function localISO(daysAgo: number, hour = 10): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

function meetingState(
  meetingId: string,
  employeeId: string,
  startedAt: string,
  evidenceSourceIds: string[],
): MeetingState {
  return {
    meetingId,
    title: `${employeeId}'s meeting`,
    employeeId,
    status: "ended",
    startedAt,
    segments: [],
    decisions: [],
    actions: evidenceSourceIds.length === 0 ? [] : [{
      id: `${meetingId}-a1`,
      meetingId,
      kind: "answer_question",
      tier: "auto",
      status: "executed",
      title: "Answered a question",
      trigger: { segmentIndex: 0, speaker: employeeId, quote: "what changed?" },
      payload: { question: "what changed?", answer: "…", citedSourceIds: evidenceSourceIds },
      payloadHash: "hash",
      version: 1,
      evidence: evidenceSourceIds.map((sourceId) => ({ sourceId, sourceType: "jira", title: sourceId, excerpt: "…" })),
      dedupeKey: `${meetingId}-a1`,
      createdAt: startedAt,
    }],
    trace: [],
  };
}

/** A minimal MeetingActions backing only list() and get(), which is all the
 * today route reads. */
function fakeMeetings(states: MeetingState[]): MeetingActions {
  const byId = new Map(states.map((state) => [state.meetingId, state]));
  return {
    async start() { throw new Error("not used in this test"); },
    async append() { throw new Error("not used in this test"); },
    async end() { throw new Error("not used in this test"); },
    async get(meetingId) { return byId.get(meetingId) ?? null; },
    async list() {
      return [...byId.values()].map((state) => ({
        meetingId: state.meetingId,
        title: state.title,
        status: state.status,
        startedAt: state.startedAt,
        actionCount: state.actions.length,
      }));
    },
    async approve() { throw new Error("not used in this test"); },
    async reject() { throw new Error("not used in this test"); },
    async edit() { throw new Error("not used in this test"); },
    subscribe() { return () => {}; },
    async idle() {},
  };
}

function assistantMessage(conversationId: string, sourceIds: string[], createdAt: string): ConversationMessage {
  return {
    messageId: `${conversationId}-assistant`,
    conversationId,
    role: "assistant",
    content: "Here is what I found.",
    metadata: { sources: sourceIds.map((sourceId) => ({ sourceId, sourceType: "confluence", title: sourceId, excerpt: "…" })) },
    createdAt,
  };
}

/** A minimal ConversationStore backing only list() and get(). */
function fakeConversations(entries: Array<{ summary: ConversationSummary; messages: ConversationMessage[] }>): ConversationStore {
  return {
    async list(userId) { return entries.filter((entry) => entry.summary.userId === userId).map((entry) => entry.summary); },
    async get(conversationId, userId) {
      const entry = entries.find((candidate) =>
        candidate.summary.conversationId === conversationId && candidate.summary.userId === userId);
      return entry ? { conversation: entry.summary, messages: entry.messages } : null;
    },
    async create() { throw new Error("not used in this test"); },
    async appendMessage() { throw new Error("not used in this test"); },
    async updateTitle() { throw new Error("not used in this test"); },
    async delete() { throw new Error("not used in this test"); },
  };
}

/** A knowledge base whose graphQuery echoes back one node per known evidence
 * source id, so a test can see exactly what evidence it was asked with. */
function fakeGraphKnowledge() {
  const queries: GraphQueryRequest[] = [];
  const bySource: Record<string, GraphNode> = {
    "ENG-210": node("item", "ENG-210", { subtype: "jira", label: "Fix the ingestion race" }),
    "CONF-99": node("document", "CONF-99", { label: "Runbook: NOC calls" }),
    "PRIYA-1": node("item", "PRIYA-1", { label: "Priya's own ticket" }),
    "PRIYA-2": node("document", "PRIYA-2", { label: "Priya's doc" }),
  };
  const knowledge: CompanyKnowledge = {
    async employee(employeeId) {
      const names: Record<string, string> = { jax: "Jax", priya: "Priya" };
      const name = names[employeeId];
      return name ? { employeeId, displayName: name, currentAssignments: [] } : null;
    },
    async search() { return []; },
    async related() { return []; },
    async sources() { return []; },
    async graphQuery(request) {
      queries.push(request);
      const centre = { id: `query:${request.query}`, refKey: request.query, type: "query" as const, label: request.query };
      const seeds = (request.evidence ?? []).map((id) => bySource[id]).filter((n): n is GraphNode => Boolean(n));
      if (seeds.length === 0) return { nodes: [centre], edges: [], truncated: false, centre: centre.id, evidence: [] };
      return {
        nodes: [centre, ...seeds],
        edges: seeds.map((seed) => ({ source: centre.id, target: seed.id, type: "matches" })),
        truncated: false,
        centre: centre.id,
        evidence: (request.evidence ?? []).map((sourceId) => ({ sourceId, sourceType: "x", title: sourceId, excerpt: "" })),
      };
    },
  };
  return { knowledge, queries };
}

describe("where today touched", () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  after(async () => { for (const app of apps) await app.close(); });

  function start(setup: {
    companyKnowledge?: CompanyKnowledge;
    meetings?: MeetingActions;
    conversationStore?: ConversationStore;
  }) {
    const app = buildApp({
      memory: new DeterministicMemoryProvider(),
      ...(setup.companyKnowledge ? { companyKnowledge: setup.companyKnowledge } : {}),
      ...(setup.meetings ? { meetings: { service: setup.meetings } } : {}),
      ...(setup.conversationStore ? { conversationStore: setup.conversationStore } : {}),
    });
    apps.push(app);
    return app;
  }

  test("gathers only the signed-in employee's own evidence, from today's meetings and conversations", async () => {
    const { knowledge, queries } = fakeGraphKnowledge();
    const meetings = fakeMeetings([
      meetingState("m-jax-today", "jax", localISO(0), ["ENG-210"]),
      meetingState("m-jax-yesterday", "jax", localISO(1), ["OLD-1"]),
      meetingState("m-priya-today", "priya", localISO(0), ["PRIYA-1"]),
    ]);
    const conversations = fakeConversations([
      {
        summary: { conversationId: "c-jax-today", userId: "jax", title: "t", createdAt: localISO(0), updatedAt: localISO(0) },
        messages: [assistantMessage("c-jax-today", ["CONF-99"], localISO(0))],
      },
      {
        summary: { conversationId: "c-jax-yesterday", userId: "jax", title: "t", createdAt: localISO(1), updatedAt: localISO(1) },
        messages: [assistantMessage("c-jax-yesterday", ["OLD-2"], localISO(1))],
      },
      {
        summary: { conversationId: "c-priya-today", userId: "priya", title: "t", createdAt: localISO(0), updatedAt: localISO(0) },
        messages: [assistantMessage("c-priya-today", ["PRIYA-2"], localISO(0))],
      },
    ]);
    const app = start({ companyKnowledge: knowledge, meetings, conversationStore: conversations });

    const jax = await app.inject({ url: "/api/v1/graph/today?userId=jax" });
    assert.equal(jax.statusCode, 200);
    const jaxBody = jax.json();
    assert.equal(jaxBody.centre, "query:Today");
    assert.deepEqual(jaxBody.touched.sort(), ["document:CONF-99", "item:ENG-210"]);
    assert.deepEqual(jaxBody.nodes.map((entry: GraphNode) => entry.id).sort(), ["document:CONF-99", "item:ENG-210", "query:Today"]);
    const jaxQuery = queries.at(-1)!;
    assert.equal(jaxQuery.query, "Today");
    assert.deepEqual([...(jaxQuery.evidence ?? [])].sort(), ["CONF-99", "ENG-210"]);

    // Priya's own request sees only her own evidence, never Jax's.
    const priya = await app.inject({ url: "/api/v1/graph/today?userId=priya" });
    assert.deepEqual(priya.json().touched.sort(), ["document:PRIYA-2", "item:PRIYA-1"]);
    const priyaQuery = queries.at(-1)!;
    assert.deepEqual([...(priyaQuery.evidence ?? [])].sort(), ["PRIYA-1", "PRIYA-2"]);
  });

  test("nothing touched today is an empty slice, and the graph is not even asked", async () => {
    const { knowledge, queries } = fakeGraphKnowledge();
    const meetings = fakeMeetings([meetingState("m-jax-yesterday", "jax", localISO(1), ["OLD-1"])]);
    const conversations = fakeConversations([]);
    const app = start({ companyKnowledge: knowledge, meetings, conversationStore: conversations });

    const response = await app.inject({ url: "/api/v1/graph/today?userId=jax" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { nodes: [], edges: [], truncated: false, touched: [] });
    assert.equal(queries.length, 0);
  });

  test("without meetings or a conversation store configured, there is simply nothing to show", async () => {
    const { knowledge } = fakeGraphKnowledge();
    const app = start({ companyKnowledge: knowledge });
    const response = await app.inject({ url: "/api/v1/graph/today?userId=jax" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { nodes: [], edges: [], truncated: false, touched: [] });
  });

  test("without the graph configured, the route is a 503", async () => {
    const app = start({
      companyKnowledge: {
        async employee() { return { employeeId: "jax", displayName: "Jax", currentAssignments: [] }; },
        async search() { return []; },
        async related() { return []; },
        async sources() { return []; },
      },
    });
    const response = await app.inject({ url: "/api/v1/graph/today?userId=jax" });
    assert.equal(response.statusCode, 503);
  });

  test("there is no person parameter: another employee's day cannot be asked for, and signing out leaves no day at all", async () => {
    const SECRET = "graph-today-test-secret-that-is-at-least-32-characters";
    const { knowledge } = fakeGraphKnowledge();
    const meetings = fakeMeetings([meetingState("m-jax-today", "jax", localISO(0), ["ENG-210"])]);
    const app = buildApp({
      memory: new DeterministicMemoryProvider(),
      sessionConfig: { secret: SECRET },
      companyKnowledge: knowledge,
      meetings: { service: meetings },
    });
    apps.push(app);
    const headers = { authorization: `Bearer ${createSessionToken("jax", SECRET)}` };

    const asked = await app.inject({ url: "/api/v1/graph/today?userId=priya", headers });
    assert.equal(asked.statusCode, 400);
    assert.equal((await app.inject({ url: "/api/v1/graph/today" })).statusCode, 401);
  });
});
