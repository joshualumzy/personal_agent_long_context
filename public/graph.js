/**
 * The company graph, drawn from /api/v1/graph.
 *
 * Two views of one slice, kept in step: a diagram, and a table of every
 * relationship in it. The table is not a fallback bolted on afterwards — a
 * force-directed picture is unreadable to anyone not looking at it, and hard to
 * read precisely even then, so the table is where the relationships can actually
 * be checked. Both are built from the same response.
 *
 * Layout is a small force simulation run to completion before anything is drawn,
 * rather than animated into place: the result is identical and nothing moves
 * under the pointer. Nodes are told apart by shape as well as colour.
 *
 * The recorded graph is split into three layer tabs (main / people / causal
 * chains), each independently cached: the main tab is query-centered and
 * re-centers on click (a fresh request every time, since the center itself
 * changes), while the person and causal layers have no seed — one full
 * request each, cached after the first draw, since "the involves layer" is
 * a fixed thing to look at rather than something that follows a click.
 * Restore original resets whichever tab is open to its own cached slice.
 */

const SVG = "http://www.w3.org/2000/svg";
const $ = (selector) => document.querySelector(selector);

// A force layout stops being readable well before this many nodes; the server
// caps the slice too, and this is the view agreeing with it.
const MAX_DRAWN = 120;

// The main tab's own, tighter cap: it is meant to be read as "what is near
// this one thing", not "everything in the neighbourhood at once". Past this
// many nodes the view should be told to click into a smaller piece rather
// than rendering all of it.
const MAIN_LAYER_CAP = 20;

const LAYER_EDGE_TYPES = {
  person: ["involves"],
  causal: ["caused_by", "escalated_via"],
};

// Stands in for state.mainOriginalSeed when the main tab has drawn its
// no-question-asked-yet fallback, so the cache/restore logic always has a
// key to look up rather than needing an "is there really a seed" branch.
const MAIN_NO_SEED_KEY = "__no_seed__";

const state = {
  slice: null,
  selected: null,
  source: "recorded",
  extraction: null,
  questions: [],
  layer: "main",
  // The slice each tab first drew, keyed by layer name for person/causal
  // (one entry, since there is no seed to vary) and by seed id for main
  // (one entry per node visited, so returning to a node already seen does
  // not re-fetch it).
  cache: { main: new Map(), person: null, causal: null },
  // The main tab's own starting slice — what "Restore original" returns to —
  // kept separate from state.cache.main because that map grows as the user
  // clicks around; this is specifically the first one drawn.
  mainOriginalSeed: null,
  evidenceCache: new Map(),
};

function svg(tag, attributes = {}) {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    element.setAttribute(key, String(value));
  }
  return element;
}

function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

/** Deterministic start positions, so the same slice always lays out the same. */
function seedNumber(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0) / 4294967295;
}

function shortLabel(node) {
  const label = node.label || node.id;
  return label.length > 22 ? `${label.slice(0, 21)}…` : label;
}

function nodeKind(node) {
  // The emergent graph brings its own taxonomy: cognee labels every extracted
  // thing an Entity, and the categories it groups them under EntityType.
  if (node.type === "Entity") return "entity";
  if (node.type === "EntityType") return "kind";
  // The recorded graph's own five kinds. 'document' still splits on category,
  // since the deterministic graph only ever gives 'document' to a confluence
  // page — the category check exists for the earlier shape of this data and
  // stays harmless if it never matches 'sim_event' again.
  if (node.type === "person") return "person";
  if (node.type === "organization") return "organization";
  if (node.type === "item") return "item";
  if (node.type === "event") return "event";
  if (node.type === "document") return node.category === "artifact" ? "artifact" : "event";
  return "entity";
}

function describeKind(node) {
  switch (nodeKind(node)) {
    case "person": return "Person";
    case "organization": return "Organization";
    case "item": return node.isIncident ? "Item, part of an incident" : "Item";
    case "event": return "Simulation event";
    case "entity": return "Something named in the writing";
    case "kind": return "A kind of thing";
    default: return node.isIncident ? "Artifact, part of an incident" : "Artifact";
  }
}

/**
 * A plain spring/repulsion layout. Enough for a hundred nodes, and it avoids
 * pulling in a graph library for one page.
 */
function layout(nodes, edges) {
  const positions = new Map();
  nodes.forEach((node, index) => {
    const angle = seedNumber(node.id) * Math.PI * 2;
    const radius = 90 + (index % 7) * 26;
    positions.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 });
  });

  const linked = edges.filter((edge) => positions.has(edge.source) && positions.has(edge.target));
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of linked) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  for (let step = 0; step < 320; step += 1) {
    const cooling = 1 - step / 320;

    for (const [idA, a] of positions) {
      for (const [idB, b] of positions) {
        if (idA >= idB) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance = Math.hypot(dx, dy) || 0.01;
        const push = Math.min(2600 / (distance * distance), 14);
        const ux = (dx / distance) * push;
        const uy = (dy / distance) * push;
        a.vx += ux; a.vy += uy;
        b.vx -= ux; b.vy -= uy;
      }
    }

    for (const edge of linked) {
      const a = positions.get(edge.source);
      const b = positions.get(edge.target);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 0.01;
      const pull = (distance - 96) * 0.012;
      const ux = (dx / distance) * pull;
      const uy = (dy / distance) * pull;
      a.vx += ux; a.vy += uy;
      b.vx -= ux; b.vy -= uy;
    }

    for (const [id, point] of positions) {
      // Weak pull to the middle, weaker for well-connected nodes so hubs settle
      // centrally instead of being dragged outward by everything they touch.
      const gravity = 0.0016 / (1 + (degree.get(id) ?? 0) * 0.12);
      point.vx -= point.x * gravity * 60;
      point.vy -= point.y * gravity * 60;

      point.x += point.vx * cooling;
      point.y += point.vy * cooling;
      point.vx *= 0.82;
      point.vy *= 0.82;
    }
  }

  // Fit to the viewBox with a margin, so a sparse slice is not tiny and a dense
  // one does not spill outside.
  const xs = [...positions.values()].map((p) => p.x);
  const ys = [...positions.values()].map((p) => p.y);
  const spanX = Math.max(...xs) - Math.min(...xs) || 1;
  const spanY = Math.max(...ys) - Math.min(...ys) || 1;
  const scale = Math.min(720 / spanX, 520 / spanY, 2.4);
  const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const midY = (Math.max(...ys) + Math.min(...ys)) / 2;
  for (const point of positions.values()) {
    point.x = (point.x - midX) * scale;
    point.y = (point.y - midY) * scale;
  }
  return positions;
}

function shapeFor(node) {
  const kind = nodeKind(node);
  if (kind === "person" || kind === "actor") {
    return svg("polygon", { points: "0,-7 7,0 0,7 -7,0", class: "shape n-actor" });
  }
  if (kind === "organization") {
    return svg("polygon", { points: "-7,-6 7,-6 7,6 -7,6", class: "shape n-organization" });
  }
  if (kind === "event") {
    return svg("rect", { x: -6, y: -6, width: 12, height: 12, class: "shape n-event" });
  }
  if (kind === "item") {
    return svg("circle", {
      r: 7,
      class: `shape n-item${node.isIncident ? " incident" : ""}`,
    });
  }
  if (kind === "kind") {
    return svg("rect", { x: -6, y: -6, width: 12, height: 12, class: "shape n-kind" });
  }
  if (kind === "entity") {
    return svg("circle", { r: 7, class: "shape n-entity" });
  }
  return svg("circle", {
    r: 7,
    class: `shape n-artifact${node.isIncident ? " incident" : ""}`,
  });
}

/**
 * When a slice is larger than can be drawn, keep the best-connected nodes.
 * Taking the first N instead would drop exactly the hubs that make the picture
 * mean anything, and the emergent graph is routinely twice the cap.
 */
function mostConnected(nodes, edges, cap) {
  if (nodes.length <= cap) return nodes;
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (degree.has(edge.source)) degree.set(edge.source, degree.get(edge.source) + 1);
    if (degree.has(edge.target)) degree.set(edge.target, degree.get(edge.target) + 1);
  }
  return [...nodes]
    .sort((left, right) =>
      (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) ||
      left.id.localeCompare(right.id))
    .slice(0, cap);
}

function drawPicture() {
  const canvas = $("#canvas");
  const title = canvas.querySelector("title");
  canvas.replaceChildren(title);

  const { nodes, edges } = state.slice;
  const cap = state.layer === "main" ? MAIN_LAYER_CAP : MAX_DRAWN;
  const drawn = mostConnected(nodes, edges, cap);
  const visible = new Set(drawn.map((node) => node.id));
  const positions = layout(drawn, edges);

  const edgeLayer = svg("g");
  for (const edge of edges) {
    if (!visible.has(edge.source) || !visible.has(edge.target)) continue;
    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    edgeLayer.append(svg("line", {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `edge ${edge.type}`,
    }));
  }

  const nodeLayer = svg("g");
  for (const node of drawn) {
    const point = positions.get(node.id);
    // tabindex makes each node a stop, so the diagram is walkable without a
    // pointer; the group carries the label so focus announces something useful.
    const group = svg("g", {
      class: "node",
      transform: `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`,
      tabindex: "0",
      role: "button",
      "aria-label": `${node.label || node.id}. ${describeKind(node)}.`,
      "data-id": node.id,
    });
    group.append(
      svg("circle", { r: 12, class: "ring" }),
      shapeFor(node),
      Object.assign(svg("text", { y: 19, class: "caption" }), { textContent: shortLabel(node) }),
    );
    // Single click: select, and — on the main tab, where a node is something
    // to move toward rather than a fixed member of a fixed set — re-center
    // the graph on it. Double click: open its details, regardless of tab.
    group.addEventListener("click", () => {
      select(node.id);
      if (state.layer === "main") recenterOn(node.id);
    });
    group.addEventListener("dblclick", (event) => {
      event.preventDefault();
      openDetails(node.id);
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select(node.id);
        if (state.layer === "main") recenterOn(node.id);
      }
    });
    // Tabbing onto a node shows its details, so the rail follows the keyboard.
    group.addEventListener("focus", () => select(node.id));
    nodeLayer.append(group);
  }

  canvas.append(edgeLayer, nodeLayer);
}

function drawTable() {
  const { nodes, edges } = state.slice;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rows = edges.map((edge) => {
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    return h(
      "tr", {},
      h("td", {}, from?.label || edge.source),
      h("td", { class: "kind" }, from ? describeKind(from) : "—"),
      h("td", { class: "kind" }, edge.type.replace(/_/g, " ")),
      h("td", {}, to?.label || edge.target),
    );
  });
  $("#edge-rows").replaceChildren(...rows);
  $("#table-summary").textContent =
    `${nodes.length} items, ${edges.length} relationships.`;
}

function select(id) {
  state.selected = id;
  const { nodes, edges } = state.slice;
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) return;

  for (const group of document.querySelectorAll(".node")) {
    group.classList.toggle("selected", group.dataset.id === id);
  }

  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const neighbours = [];
  for (const edge of edges) {
    if (edge.source === id && byId.has(edge.target)) {
      neighbours.push({ node: byId.get(edge.target), direction: "to", type: edge.type });
    } else if (edge.target === id && byId.has(edge.source)) {
      neighbours.push({ node: byId.get(edge.source), direction: "from", type: edge.type });
    }
  }

  const facts = [["Kind", describeKind(node)]];
  // A cognee node id is a uuid, which tells a reader nothing; a source id does.
  if (state.source === "recorded") facts.push(["Identifier", node.id]);
  if (node.sourceType) facts.push(["Type", node.sourceType]);
  if (node.department) facts.push(["Department", node.department]);
  if (typeof node.simulationDay === "number") facts.push(["Day", String(node.simulationDay)]);

  const list = h("dl", {});
  for (const [term, value] of facts) {
    list.append(h("dt", {}, term), h("dd", {}, value));
  }

  const panel = $("#details");
  panel.replaceChildren(
    h("p", { class: "name" }, node.label || node.id),
    list,
    neighbours.length
      ? h("ul", { class: "neighbours" },
          h("li", { class: "kind" }, `Connected to ${neighbours.length}:`),
          // The relationship is named on every row. In the emergent graph that
          // name is the finding — "blocked by", "mitigated by", "has risk" — and
          // it is lost if the row only says which two things are joined.
          ...neighbours.slice(0, 14).map(({ node: other, direction, type }) =>
            h("li", {},
              h("span", { class: "kind" },
                `${direction === "to" ? "→ " : "← "}${type.replace(/_/g, " ")} `),
              h("button", { type: "button", onclick: () => focusNode(other.id) },
                other.label || other.id),
            )),
        )
      : h("p", { class: "hint-line" }, "Nothing else in this view connects to it."),
  );
}

/** Move focus to a node, so following a link keeps the keyboard in the diagram. */
function focusNode(id) {
  const group = document.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
  if (group) group.focus();
  else select(id);
}

/**
 * Re-center the main tab on a clicked node: a fresh graphSlice({seed, depth:1})
 * request, replacing the canvas rather than adding to it. The main tab is
 * "what is near this one thing", one thing at a time — not an
 * ever-accumulating picture — so a click moves the center instead of
 * appending a second neighbourhood onto the first.
 */
async function recenterOn(id) {
  // Re-centering is a recorded-graph, main-tab idea: the emergent graph is
  // one question's own fixed export, nothing to move a seed through.
  if (state.source !== "recorded" || state.layer !== "main") return;
  $("#status-line").textContent = "Loading…";
  try {
    const cached = state.cache.main.get(id);
    const slice = cached ?? await fetchSlice(`/api/v1/graph?${new URLSearchParams({
      seed: id,
      depth: "1",
      includeActors: $("#include-actors").checked ? "true" : "false",
    })}`);
    if (!cached) state.cache.main.set(id, slice);
    state.slice = slice;
    drawPicture();
    drawTable();
    reportCounts();
    $("#restore").disabled = false;
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Double-click: open the details panel with two sub-tabs.
 *
 * Attributes reads node.props as it already arrived on the wire — no
 * request, since a node with rich props (an incident's root_cause, a
 * domain's ownership) already carries them. Evidence is hybrid search over
 * the node's own label, fetched only the first time this tab is opened for
 * this node and cached after — not exact provenance for a specific edge
 * (the graph does not keep that), but the same retrieval a question about
 * this node would get.
 */
function openDetails(id) {
  const { nodes } = state.slice;
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) return;
  select(id);

  const panel = $("#details");
  const attributesTab = h("div", { class: "detail-pane" });
  const evidenceTab = h("div", { class: "detail-pane", hidden: true });
  renderAttributes(attributesTab, node);

  const attributesButton = h("button", {
    type: "button", class: "detail-tab on",
    onclick: () => {
      attributesButton.classList.add("on");
      evidenceButton.classList.remove("on");
      attributesTab.hidden = false;
      evidenceTab.hidden = true;
    },
  }, "Attributes");
  const evidenceButton = h("button", {
    type: "button", class: "detail-tab",
    onclick: async () => {
      attributesButton.classList.remove("on");
      evidenceButton.classList.add("on");
      attributesTab.hidden = true;
      evidenceTab.hidden = false;
      await renderEvidence(evidenceTab, node);
    },
  }, "Evidence");

  panel.replaceChildren(
    h("p", { class: "name" }, node.label || node.id),
    h("div", { class: "detail-tabs" }, attributesButton, evidenceButton),
    attributesTab,
    evidenceTab,
  );
}

/** node.props as delivered, plus the few flat fields the wire format already
 * has. Common bookkeeping fields (occurred_at is folded into a readable date
 * elsewhere, source_type/category/department duplicate what the node already
 * shows) are skipped so what is left is what actually distinguishes this
 * node — an incident's root_cause, a domain's primary_owner, and so on. */
function renderAttributes(container, node) {
  const skip = new Set(["source_type", "category", "department", "is_incident"]);
  const props = node.props ?? {};
  const entries = Object.entries(props).filter(
    ([key, value]) => !skip.has(key) && value !== null && value !== undefined,
  );

  const facts = [["Kind", describeKind(node)], ["Identifier", node.id]];
  if (node.sourceType) facts.push(["Type", node.sourceType]);
  if (node.department) facts.push(["Department", node.department]);

  const list = h("dl", {});
  for (const [term, value] of facts) list.append(h("dt", {}, term), h("dd", {}, value));
  for (const [key, value] of entries) {
    list.append(
      h("dt", {}, key.replace(/_/g, " ")),
      h("dd", {}, typeof value === "object" ? JSON.stringify(value) : String(value)),
    );
  }

  container.replaceChildren(
    list,
    entries.length === 0
      ? h("p", { class: "hint-line" }, "No additional attributes recorded for this node.")
      : null,
  );
}

/** Hybrid search over the node's own label, cached per node id so reopening
 * this tab does not refetch. */
async function renderEvidence(container, node) {
  const cached = state.evidenceCache.get(node.id);
  if (cached) return renderEvidenceList(container, cached);

  container.replaceChildren(h("p", { class: "hint-line" }, "Searching…"));
  try {
    const response = await fetch(
      `/api/v1/graph/evidence?${new URLSearchParams({ label: node.label || node.id, limit: "5" })}`,
    );
    if (!response.ok) throw new Error(`Evidence search failed (${response.status}).`);
    const body = await response.json();
    const evidence = Array.isArray(body.evidence) ? body.evidence : [];
    state.evidenceCache.set(node.id, evidence);
    renderEvidenceList(container, evidence);
  } catch (error) {
    container.replaceChildren(
      h("p", { class: "hint-line" }, error instanceof Error ? error.message : String(error)),
    );
  }
}

function renderEvidenceList(container, evidence) {
  if (evidence.length === 0) {
    container.replaceChildren(h("p", { class: "hint-line" }, "Nothing found for this label."));
    return;
  }
  container.replaceChildren(
    h("ul", { class: "evidence-list" },
      ...evidence.map((item) =>
        h("li", {},
          h("p", { class: "evidence-title" }, item.title || item.sourceId),
          h("p", { class: "evidence-excerpt" }, item.excerpt || ""),
        )),
    ),
  );
}

function showError(message) {
  const banner = $("#error");
  banner.textContent = message;
  banner.hidden = false;
}

/**
 * Which questions have a graph. Each is extracted on its own, so each has its own
 * picture: merging them would leave a relationship impossible to attribute to the
 * question that found it.
 */
async function loadQuestions() {
  const select = $("#question");
  try {
    const response = await fetch("/api/v1/graph/emergent");
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      state.questions = [];
      select.replaceChildren();
      throw new Error(body.message || "No extracted graphs yet.");
    }
    const index = await response.json();
    state.questions = Array.isArray(index.graphs) ? index.graphs : [];
    // Newest first: the question just asked is the one most likely wanted.
    state.questions.sort((left, right) =>
      String(right.extracted_at ?? "").localeCompare(String(left.extracted_at ?? "")));
    const chosen = select.value;
    select.replaceChildren(
      ...state.questions.map((graph) =>
        h("option", { value: graph.slug },
          `${graph.question}  (${graph.node_count} items)`)),
    );
    if (state.questions.some((graph) => graph.slug === chosen)) select.value = chosen;
    return state.questions.length > 0;
  } catch (error) {
    throw error;
  }
}

/**
 * Resolve free text to a graph node via the same hybrid search used to
 * answer questions. Only meaningful on the main tab, and only when the view
 * is "query" (the default) rather than one of the older manual filters.
 */
async function resolveSeed(query) {
  const response = await fetch(`/api/v1/graph/seed?${new URLSearchParams({ q: query })}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || "Nothing matched that question.");
  }
  return response.json();
}

/**
 * Which URL to draw next. Three shapes:
 *   - emergent: unchanged, one question's own extraction
 *   - main tab, view=query: resolve free text to a seed first (async, so this
 *     returns a promise the caller awaits), then a one-hop slice from it
 *   - main tab, older manual filters (chain/incidents/type): unchanged
 *     behaviour, kept for anyone relying on picking a source id or a kind by
 *     hand instead of asking a question
 *   - person/causal tabs: edgeTypes only, no seed — the edge type itself is
 *     what selects the slice
 */
async function request() {
  if ($("#source").value === "emergent") {
    const slug = $("#question").value;
    return slug ? `/api/v1/graph/emergent/graphs/${encodeURIComponent(slug)}` : null;
  }

  if (state.layer === "person" || state.layer === "causal") {
    const parameters = new URLSearchParams({
      edgeTypes: LAYER_EDGE_TYPES[state.layer].join(","),
      includeActors: "true",
      limit: "100",
    });
    return `/api/v1/graph?${parameters}`;
  }

  const view = $("#view").value;
  const parameters = new URLSearchParams();
  if ($("#include-actors").checked) parameters.set("includeActors", "true");

  if (view === "chain") {
    parameters.set("seed", $("#seed").value.trim());
    parameters.set("depth", $("#depth").value);
  } else if (view === "incidents") {
    parameters.set("incidentsOnly", "true");
    parameters.set("limit", "60");
  } else if (view === "type") {
    parameters.set("sourceType", $("#source-type").value);
    parameters.set("category", "artifact");
    parameters.set("limit", "50");
  } else {
    const query = $("#query").value.trim();
    if (query) {
      const seed = await resolveSeed(query);
      state.mainOriginalSeed = seed.sourceId;
      parameters.set("seed", seed.sourceId);
      parameters.set("depth", "1");
    } else {
      // Nothing asked yet — the first thing on screen should still be
      // something, not an error demanding a question before it will draw
      // anything. Incidents are the one view guaranteed to be non-empty.
      // A fixed sentinel key stands in for "no seed" so the main tab's
      // cache and Restore original do not need a separate code path for it.
      state.mainOriginalSeed = MAIN_NO_SEED_KEY;
      parameters.set("incidentsOnly", "true");
      parameters.set("limit", "60");
    }
  }
  return `/api/v1/graph?${parameters}`;
}

/** One fetch, unwrapped and error-checked — the piece recenterOn and draw
 * both need, so a 404 or a 503 reads the same message either way. */
async function fetchSlice(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `The graph could not be loaded (${response.status}).`);
  }
  return response.json();
}

function reportCounts() {
  const { nodes, edges } = state.slice;
  const cap = state.layer === "main" ? MAIN_LAYER_CAP : MAX_DRAWN;
  const hidden = Math.max(nodes.length - cap, 0);
  $("#status-line").textContent = [
    `${nodes.length} items, ${edges.length} relationships`,
    state.slice.truncated ? "trimmed to fit" : null,
    hidden
      ? `${hidden} of the least connected not drawn — click a node to expand from it, or see the table`
      : null,
  ].filter(Boolean).join(" · ");
}

/** What produced this drawing. Only the emergent graph is a stored snapshot. */
function showProvenance() {
  const line = $("#provenance");
  if (state.source !== "emergent") {
    line.hidden = true;
    return;
  }
  const meta = state.slice?.meta ?? {};
  line.textContent = [
    meta.question
      ? `Read out of the writing while answering “${meta.question}”.`
      : "Read out of the writing by a model.",
    meta.semantic_only === false
      ? "Includes the extractor's own scaffolding."
      : "Scaffolding removed, so every line here was found in the prose.",
    meta.extracted_at ? `Extracted ${meta.extracted_at}.` : null,
    "One question, one graph: nothing here came from any other question.",
  ].filter(Boolean).join(" ");
  line.hidden = false;
}

/**
 * Follow extraction while the emergent graph is on screen.
 *
 * Extraction is queued when a question is answered elsewhere and takes minutes,
 * so the drawing here goes stale without warning. Polling lets the page say an
 * extraction is under way, and reload itself once the export has been rewritten.
 */
async function pollExtraction() {
  if (state.source !== "emergent") return;
  try {
    const response = await fetch("/api/v1/graph/emergent/status");
    if (!response.ok) return;
    const status = await response.json();
    const previous = state.extraction;
    state.extraction = status;

    const note = $("#extraction");
    if (status.running) {
      note.textContent = `Reading the writing about “${status.running}”… this takes a few minutes.`;
      note.hidden = false;
    } else if (status.lastError) {
      note.textContent = `The last extraction did not finish: ${status.lastError}`;
      note.hidden = false;
    } else {
      note.hidden = true;
    }

    // A finished run means the export on disk has changed underneath us.
    if (previous && previous.lastFinishedAt !== status.lastFinishedAt && !status.running) {
      await draw();
    }
  } catch {
    // A failed poll is not worth reporting; the next one may succeed.
  }
}

async function draw() {
  const button = $("#draw");
  button.disabled = true;
  $("#error").hidden = true;
  $("#status-line").textContent = "Loading…";
  state.source = $("#source").value;

  try {
    if (state.source === "emergent") {
      const any = await loadQuestions();
      if (!any) throw new Error("No question has a graph yet.");
    }
    const url = await request();
    if (!url) throw new Error("Choose a question first.");

    state.slice = await fetchSlice(url);
    if (state.source === "recorded" && state.layer === "main" && state.mainOriginalSeed) {
      state.cache.main.set(state.mainOriginalSeed, state.slice);
    }
    if (state.source === "recorded" && (state.layer === "person" || state.layer === "causal")) {
      state.cache[state.layer] = state.slice;
    }
    drawPicture();
    drawTable();
    showProvenance();
    reportCounts();
    $("#restore").disabled = state.source !== "recorded";

    $("#details").replaceChildren(
      h("p", { class: "empty" }, "Choose an item to see what it is."),
    );
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    $("#status-line").textContent = "Nothing drawn.";
  } finally {
    button.disabled = false;
  }
}

/** Redraw whichever tab is open from its own cached first slice. Main
 * returns to the question most recently asked; person/causal return to
 * their one fixed slice. A no-op, not an error, if nothing has been drawn
 * yet to restore. */
function restoreOriginal() {
  if (state.source !== "recorded") return;
  const cached = state.layer === "main"
    ? state.cache.main.get(state.mainOriginalSeed)
    : state.cache[state.layer];
  if (!cached) return;
  state.slice = cached;
  drawPicture();
  drawTable();
  reportCounts();
}

/** Switch which layer tab is open. Person/causal load once and reuse their
 * cache on every later visit; main is left alone if it already has
 * something drawn, so leaving and returning to it does not lose the place
 * a click had reached. */
function switchLayer(layer) {
  if (state.layer === layer) return;
  state.layer = layer;
  for (const button of document.querySelectorAll(".layer-tab")) {
    button.classList.toggle("on", button.dataset.layer === layer);
    button.setAttribute("aria-pressed", String(button.dataset.layer === layer));
  }
  syncFields();

  const cached = layer === "main" ? state.cache.main.get(state.mainOriginalSeed) : state.cache[layer];
  if (cached) {
    state.slice = cached;
    drawPicture();
    drawTable();
    reportCounts();
    $("#restore").disabled = false;
  } else if (layer !== "main") {
    draw();
  }
}

function syncFields() {
  const emergent = $("#source").value === "emergent";
  const view = $("#view").value;
  const onLayerTabs = state.layer === "person" || state.layer === "causal";
  // Each emergent graph is one question's own extraction; none of the
  // slicing or layering applies to it, and which question is the only
  // choice that does.
  $("#question-field").hidden = !emergent;
  $("#layer-tabs").hidden = emergent;
  $("#query-field").hidden = emergent || onLayerTabs || view !== "query";
  $("#view-field").hidden = emergent || onLayerTabs;
  $("#actors-field").hidden = emergent || onLayerTabs;
  $("#seed-field").hidden = emergent || onLayerTabs || view !== "chain";
  $("#depth-field").hidden = emergent || onLayerTabs || view !== "chain";
  $("#type-field").hidden = emergent || onLayerTabs || view !== "type";
  $("#restore").hidden = emergent;
  $("#legend-recorded").hidden = emergent;
  $("#legend-emergent").hidden = !emergent;
}

function showTab(which) {
  const picture = which === "picture";
  $("#picture").hidden = !picture;
  $("#table-view").hidden = picture;
  $("#tab-picture").classList.toggle("on", picture);
  $("#tab-table").classList.toggle("on", !picture);
  $("#tab-picture").setAttribute("aria-pressed", String(picture));
  $("#tab-table").setAttribute("aria-pressed", String(!picture));
}

$("#source").addEventListener("change", () => {
  syncFields();
  if ($("#source").value !== "emergent") $("#extraction").hidden = true;
});
$("#question").addEventListener("change", () => draw());
$("#view").addEventListener("change", syncFields);
$("#controls").addEventListener("submit", (event) => {
  event.preventDefault();
  draw();
});
$("#tab-picture").addEventListener("click", () => showTab("picture"));
$("#tab-table").addEventListener("click", () => showTab("table"));
$("#restore").addEventListener("click", restoreOriginal);
for (const button of document.querySelectorAll(".layer-tab")) {
  button.addEventListener("click", () => switchLayer(button.dataset.layer));
}

syncFields();
draw();
// Slow on purpose: extraction takes minutes, so asking more often only adds
// requests without learning anything sooner.
setInterval(pollExtraction, 10_000);
pollExtraction();
