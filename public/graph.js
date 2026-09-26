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
 */

const SVG = "http://www.w3.org/2000/svg";
const $ = (selector) => document.querySelector(selector);

// A force layout stops being readable well before this many nodes; the server
// caps the slice too, and this is the view agreeing with it.
const MAX_DRAWN = 120;

const state = { slice: null, selected: null, source: "recorded", extraction: null };

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
  if (node.type === "actor") return "actor";
  if (node.type === "document") return node.category === "artifact" ? "artifact" : "event";
  return "entity";
}

function describeKind(node) {
  switch (nodeKind(node)) {
    case "actor": return "Person";
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
  if (kind === "actor") {
    return svg("polygon", { points: "0,-7 7,0 0,7 -7,0", class: "shape n-actor" });
  }
  if (kind === "event") {
    return svg("rect", { x: -6, y: -6, width: 12, height: 12, class: "shape n-event" });
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
  const drawn = mostConnected(nodes, edges, MAX_DRAWN);
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
    group.addEventListener("click", () => select(node.id));
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select(node.id);
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

function showError(message) {
  const banner = $("#error");
  banner.textContent = message;
  banner.hidden = false;
}

function request() {
  if ($("#source").value === "emergent") return "/api/v1/graph/emergent";

  const view = $("#view").value;
  const parameters = new URLSearchParams();
  if ($("#include-actors").checked) parameters.set("includeActors", "true");

  if (view === "chain") {
    parameters.set("seed", $("#seed").value.trim());
    parameters.set("depth", $("#depth").value);
  } else if (view === "incidents") {
    parameters.set("incidentsOnly", "true");
    parameters.set("limit", "60");
  } else {
    parameters.set("sourceType", $("#source-type").value);
    parameters.set("category", "artifact");
    parameters.set("limit", "50");
  }
  return `/api/v1/graph?${parameters}`;
}

/** What produced this drawing. Only the emergent graph is a stored snapshot. */
function showProvenance() {
  const line = $("#provenance");
  if (state.source !== "emergent") {
    line.hidden = true;
    return;
  }
  const meta = state.slice?.meta ?? {};
  const questions = Array.isArray(meta.questions) ? meta.questions : [];
  line.textContent = [
    questions.length
      ? `Read out of the writing while answering: ${questions.map((q) => `“${q}”`).join("; ")}.`
      : "Read out of the writing by a model.",
    meta.semantic_only === false
      ? "Includes the extractor's own scaffolding."
      : "Scaffolding removed, so every line here was found in the prose.",
    state.extraction?.enabled
      ? "It grows as questions are asked."
      : "This is the last export, not a live reading.",
  ].join(" ");
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
    const response = await fetch(request());
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || `The graph could not be loaded (${response.status}).`);
    }
    state.slice = await response.json();
    drawPicture();
    drawTable();
    showProvenance();

    const { nodes, edges } = state.slice;
    const hidden = Math.max(nodes.length - MAX_DRAWN, 0);
    $("#status-line").textContent = [
      `${nodes.length} items, ${edges.length} relationships`,
      state.slice.truncated ? "trimmed to fit" : null,
      hidden ? `${hidden} of the least connected not drawn — see the table` : null,
    ].filter(Boolean).join(" · ");

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

function syncFields() {
  const emergent = $("#source").value === "emergent";
  const view = $("#view").value;
  // The emergent graph is one stored export; none of the slicing applies to it.
  $("#view-field").hidden = emergent;
  $("#actors-field").hidden = emergent;
  $("#seed-field").hidden = emergent || view !== "chain";
  $("#depth-field").hidden = emergent || view !== "chain";
  $("#type-field").hidden = emergent || view !== "type";
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
$("#view").addEventListener("change", syncFields);
$("#controls").addEventListener("submit", (event) => {
  event.preventDefault();
  draw();
});
$("#tab-picture").addEventListener("click", () => showTab("picture"));
$("#tab-table").addEventListener("click", () => showTab("table"));

syncFields();
draw();
// Slow on purpose: extraction takes minutes, so asking more often only adds
// requests without learning anything sooner.
setInterval(pollExtraction, 10_000);
pollExtraction();
