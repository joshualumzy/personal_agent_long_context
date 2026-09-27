/**
 * The emergent graph: what a language model read out of the writing while
 * answering one question, exported by orgforge_kb/cognee_memory.py.
 *
 * It used to share /graph with the recorded graph behind a source switch, but
 * the two have nothing in common beyond being drawn: different node ids,
 * different kinds (Entity / EntityType), no expansion, no layers. It has its
 * own page now, and /graph is the recorded graph alone.
 *
 * One question, one graph: each extraction is drawn on its own, since merging
 * them would leave a relationship impossible to attribute to the question that
 * found it.
 */

const SVG = "http://www.w3.org/2000/svg";
const $ = (selector) => document.querySelector(selector);

// A concentric layout stops being readable well before this many nodes.
const MAX_DRAWN = 120;
const LAYOUT_RADIUS = 260;

const state = {
  slice: null,
  selected: null,
  extraction: null,
  questions: [],
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

function nameOf(node) {
  return node.label || node.id;
}

function shortLabel(node) {
  const label = nameOf(node);
  return label.length > 22 ? `${label.slice(0, 21)}…` : label;
}

/** cognee labels every extracted thing an Entity, and the categories it groups
 * them under EntityType. */
function nodeKind(node) {
  return node.type === "EntityType" ? "kind" : "entity";
}

function describeKind(node) {
  return nodeKind(node) === "kind" ? "A kind of thing" : "Something named in the writing";
}

/** The best-connected node, used as the centre when the caller has no
 * particular one in mind. */
function highestDegree(nodes, edges) {
  if (nodes.length === 0) return null;
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (degree.has(edge.source)) degree.set(edge.source, degree.get(edge.source) + 1);
    if (degree.has(edge.target)) degree.set(edge.target, degree.get(edge.target) + 1);
  }
  return [...degree.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0];
}

/** How many hops each node sits from the centre, by breadth-first search over
 * the undirected graph. This is the number the layout turns into a radius. */
function ringsFrom(nodes, edges, centreId) {
  const present = new Set(nodes.map((node) => node.id));
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!present.has(edge.source) || !present.has(edge.target)) continue;
    adjacency.get(edge.source).push(edge.target);
    adjacency.get(edge.target).push(edge.source);
  }

  const ring = new Map();
  if (centreId && present.has(centreId)) {
    ring.set(centreId, 0);
    let frontier = [centreId];
    let depth = 0;
    while (frontier.length > 0) {
      depth += 1;
      const next = [];
      for (const id of frontier) {
        for (const neighbour of adjacency.get(id) ?? []) {
          if (ring.has(neighbour)) continue;
          ring.set(neighbour, depth);
          next.push(neighbour);
        }
      }
      frontier = next;
    }
  }

  // Anything the centre cannot reach goes one ring past the furthest thing it
  // can, so disconnected nodes are visibly outside the structure rather than
  // mixed into it.
  const reached = [...ring.values()];
  const outer = (reached.length > 0 ? Math.max(...reached) : 0) + 1;
  for (const node of nodes) {
    if (!ring.has(node.id)) ring.set(node.id, outer);
  }
  return ring;
}

/**
 * A concentric layout: the centre is what the view is about, and a node's
 * distance from it is how many hops away it is. Unlike the force simulation
 * this replaced, both coordinates mean something, it is O(n) rather than 320
 * iterations of O(n²), and it is stable — adding nodes does not move the ones
 * already on screen, which is what makes click-to-expand additive.
 *
 * `options.pinned` carries positions already assigned on a previous draw;
 * those nodes keep exactly where they were and only new ones get placed.
 */
function layout(nodes, edges, options = {}) {
  const positions = new Map();
  if (nodes.length === 0) return positions;

  const pinned = options.pinned ?? new Map();
  const present = new Set(nodes.map((node) => node.id));
  const centreId = options.centreId && present.has(options.centreId)
    ? options.centreId
    : highestDegree(nodes, edges);
  const ring = ringsFrom(nodes, edges, centreId);

  const byRing = new Map();
  for (const node of nodes) {
    const index = ring.get(node.id) ?? 0;
    if (!byRing.has(index)) byRing.set(index, []);
    byRing.get(index).push(node);
  }
  // Within a ring, group by kind so one kind occupies a contiguous arc instead
  // of being scattered around it, then by id so the order never shuffles
  // between draws of the same slice.
  for (const list of byRing.values()) {
    list.sort((left, right) =>
      nodeKind(left).localeCompare(nodeKind(right)) || left.id.localeCompare(right.id));
  }

  const maxRing = Math.max(...byRing.keys());
  const gap = maxRing > 0 ? LAYOUT_RADIUS / maxRing : 0;

  for (const [index, list] of byRing) {
    // Each ring starts at its own angle, so consecutive rings do not line up
    // radially and make the picture look like spokes.
    const offset = seedNumber(`ring-${index}`) * Math.PI * 2;
    const radius = gap * index;
    list.forEach((node, position) => {
      const already = pinned.get(node.id);
      if (already) {
        positions.set(node.id, { x: already.x, y: already.y });
        return;
      }
      if (index === 0) {
        positions.set(node.id, { x: 0, y: 0 });
        return;
      }
      const angle = offset + (position / list.length) * Math.PI * 2;
      positions.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    });
  }
  return positions;
}

function shapeFor(node) {
  return nodeKind(node) === "kind"
    ? svg("rect", { x: -6, y: -6, width: 12, height: 12, class: "shape n-kind" })
    : svg("circle", { r: 7, class: "shape n-entity" });
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
  const drawn = mostConnected(nodes, edges, MAX_DRAWN);
  const visible = new Set(drawn.map((node) => node.id));
  const positions = layout(drawn, edges);

  const edgeLayer = svg("g");
  for (const edge of edges) {
    if (!visible.has(edge.source) || !visible.has(edge.target)) continue;
    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    edgeLayer.append(svg("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `edge ${edge.type}` }));
  }

  const nodeLayer = svg("g");
  for (const node of drawn) {
    const point = positions.get(node.id);
    const group = svg("g", {
      class: "node",
      transform: `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`,
      tabindex: "0",
      role: "button",
      "aria-label": `${nameOf(node)}. ${describeKind(node)}.`,
      "data-id": node.id,
    });
    group.append(
      svg("circle", { r: 12, class: "ring" }),
      shapeFor(node),
      Object.assign(svg("text", { y: 19, class: "caption" }), { textContent: shortLabel(node) }),
    );
    group.addEventListener("click", () => select(node.id));
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select(node.id);
      }
    });
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
      h("td", {}, from ? nameOf(from) : edge.source),
      h("td", { class: "kind" }, from ? describeKind(from) : "—"),
      h("td", { class: "kind" }, edge.type.replace(/_/g, " ")),
      h("td", {}, to ? nameOf(to) : edge.target),
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

  $("#details").replaceChildren(
    h("p", { class: "name" }, nameOf(node)),
    h("dl", {}, h("dt", {}, "Kind"), h("dd", {}, describeKind(node))),
    neighbours.length
      ? h("ul", { class: "neighbours" },
          h("li", { class: "kind" }, `Connected to ${neighbours.length}:`),
          // The relationship is named on every row: in this graph that name is
          // the finding — "blocked by", "mitigated by", "has risk".
          ...neighbours.slice(0, 14).map(({ node: other, direction, type }) =>
            h("li", {},
              h("span", { class: "kind" },
                `${direction === "to" ? "→ " : "← "}${type.replace(/_/g, " ")} `),
              h("button", { type: "button", onclick: () => focusNode(other.id) }, nameOf(other)),
            )),
        )
      : h("p", { class: "hint-line" }, "Nothing else in this view connects to it."),
  );
}

function focusNode(id) {
  const group = document.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
  if (group) group.focus();
  else select(id);
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
  const hidden = Math.max(nodes.length - MAX_DRAWN, 0);
  $("#status-line").textContent = [
    `${nodes.length} items, ${edges.length} relationships`,
    hidden ? `${hidden} of the least connected not drawn — see the table` : null,
  ].filter(Boolean).join(" · ");
}

/** What produced this drawing. Only the emergent graph is a stored snapshot. */
function showProvenance() {
  const line = $("#provenance");
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
  $("#error").hidden = true;
  $("#status-line").textContent = "Loading…";
  try {
    const any = await loadQuestions();
    if (!any) throw new Error("No question has a graph yet.");
    const slug = $("#question").value;
    if (!slug) throw new Error("Choose a question first.");
    state.slice = await fetchSlice(`/api/v1/graph/emergent/graphs/${encodeURIComponent(slug)}`);
    drawPicture();
    drawTable();
    showProvenance();
    reportCounts();
    $("#details").replaceChildren(h("p", { class: "empty" }, "Choose an item to see what it is."));
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    $("#status-line").textContent = "Nothing drawn.";
  }
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

$("#question").addEventListener("change", () => draw());
$("#tab-picture").addEventListener("click", () => showTab("picture"));
$("#tab-table").addEventListener("click", () => showTab("table"));

draw();
// Slow on purpose: extraction takes minutes, so asking more often only adds
// requests without learning anything sooner.
setInterval(pollExtraction, 10_000);
pollExtraction();
