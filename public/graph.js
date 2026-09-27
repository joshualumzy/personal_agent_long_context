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
  domain: ["knows_about", "owns_domain"],
};

// The layers that are a filter over edge types, as opposed to the main tab
// (query-centred) and the timeline (every event, laid out by when).
const EDGE_TYPE_LAYERS = new Set(Object.keys(LAYER_EDGE_TYPES));

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
  cache: { main: new Map(), person: null, causal: null, domain: null, timeline: null },
  // The main tab's own starting slice — what "Restore original" returns to —
  // kept separate from state.cache.main because that map grows as the user
  // clicks around; this is specifically the first one drawn.
  mainOriginalSeed: null,
  evidenceCache: new Map(),
  // What the current picture is about: the concentric layout puts this at the
  // centre and everything else at its own hop distance from it. Null lets the
  // layout pick the best-connected node, which is what the layer tabs want.
  centreId: null,
  // Where each node was last drawn, so a redraw can keep them in place
  // instead of relaying out the whole picture.
  positions: new Map(),
  // Which nodes have already been expanded, so clicking one twice does not
  // refetch a neighbourhood already merged in.
  expanded: new Set(),
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
  // The recorded graph's own five kinds, named exactly as the backend names
  // them so there is one vocabulary rather than three.
  if (node.type === "person") return "person";
  if (node.type === "organization") return "organization";
  if (node.type === "item") return "item";
  if (node.type === "event") return "event";
  if (node.type === "document") return "document";
  return "entity";
}

function describeKind(node) {
  const incident = node.isIncident ? ", part of an incident" : "";
  switch (nodeKind(node)) {
    case "person": return "Person";
    case "organization": return "Organization";
    case "item": return `Item${incident}`;
    case "event": return `Event${incident}`;
    case "document": return `Document${incident}`;
    case "entity": return "Something named in the writing";
    case "kind": return "A kind of thing";
    default: return "Item";
  }
}

// The outermost ring's radius. The viewBox is 840x640, so this leaves room for
// a node's caption without clipping.
const LAYOUT_RADIUS = 260;

/** The best-connected node, used as the centre when the caller has no
 * particular one in mind (the layer tabs, which have no seed). */
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

/**
 * A timeline: x is when the thing happened, y is a lane per department. Both
 * coordinates carry meaning, which a force simulation cannot do and a
 * concentric layout does not try to — "what happened around the same time" is
 * a question about time, so time has to be an axis.
 *
 * Nodes with no timestamp (12 of 2,352 event nodes) go in a lane of their own
 * at the bottom rather than being dropped or silently placed at the epoch.
 */
function timelineLayout(nodes) {
  const positions = new Map();
  if (nodes.length === 0) return positions;

  const timeOf = (node) => {
    const raw = node.props?.occurred_at;
    const parsed = raw ? Date.parse(String(raw)) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };

  const times = nodes.map(timeOf).filter((value) => value !== null);
  const earliest = times.length > 0 ? Math.min(...times) : 0;
  const latest = times.length > 0 ? Math.max(...times) : 1;
  const span = latest - earliest || 1;

  // One lane per department, ordered by name so the lanes do not reshuffle
  // between draws. Undated nodes get the last lane.
  const departments = [...new Set(nodes.map((node) => node.department).filter(Boolean))].sort();
  const UNDATED_LANE = "—";
  const lanes = [...departments, UNDATED_LANE];
  const laneOf = (node) =>
    timeOf(node) === null ? UNDATED_LANE : (node.department ?? departments[0] ?? UNDATED_LANE);

  const laneHeight = lanes.length > 1 ? 480 / (lanes.length - 1) : 0;
  // Several events can share a timestamp, which would stack them on one point;
  // nudge each successive one down a little within its lane.
  const seenAt = new Map();

  for (const node of nodes) {
    const time = timeOf(node);
    const x = time === null ? 380 : -380 + ((time - earliest) / span) * 760;
    const laneIndex = lanes.indexOf(laneOf(node));
    const key = `${laneIndex}:${Math.round(x)}`;
    const stacked = seenAt.get(key) ?? 0;
    seenAt.set(key, stacked + 1);
    const y = -240 + laneIndex * laneHeight + (stacked % 4) * 9;
    positions.set(node.id, { x, y });
  }
  return positions;
}

function shapeFor(node) {
  const kind = nodeKind(node);
  // One shape per kind, so the picture still reads without colour. The
  // incident class only adds an outline — it never replaces the fill, which
  // would cost the node its kind.
  const incident = node.isIncident ? " incident" : "";
  if (kind === "person") {
    return svg("polygon", { points: "0,-7 7,0 0,7 -7,0", class: `shape n-person${incident}` });
  }
  if (kind === "organization") {
    return svg("polygon", {
      points: "-4,-7 4,-7 7,0 4,7 -4,7 -7,0",
      class: `shape n-organization${incident}`,
    });
  }
  if (kind === "item") {
    return svg("circle", { r: 7, class: `shape n-item${incident}` });
  }
  if (kind === "event") {
    return svg("rect", { x: -6, y: -6, width: 12, height: 12, class: `shape n-event${incident}` });
  }
  if (kind === "document") {
    return svg("polygon", { points: "0,-7 7,6 -7,6", class: `shape n-document${incident}` });
  }
  if (kind === "kind") {
    return svg("rect", { x: -6, y: -6, width: 12, height: 12, class: "shape n-kind" });
  }
  return svg("circle", { r: 7, class: "shape n-entity" });
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
  // The main tab's 20 is a budget for the *first* view being legible, not a
  // hard ceiling: once the reader has expanded something they have asked for a
  // bigger picture, and trimming back to 20 would throw away nodes they just
  // added. MAX_DRAWN is the real ceiling either way.
  const cap = state.layer !== "main" || state.expanded.size > 0
    ? MAX_DRAWN
    : MAIN_LAYER_CAP;
  const drawn = mostConnected(nodes, edges, cap);
  const visible = new Set(drawn.map((node) => node.id));
  // The timeline puts time on an axis; every other layer is about structure,
  // so distance from a centre is the more useful thing to encode.
  const positions = state.layer === "timeline"
    ? timelineLayout(drawn)
    : layout(drawn, edges, {
        centreId: state.centreId,
        // Nodes already on screen keep their place, so expanding one does not
        // rearrange everything the reader has already made sense of.
        pinned: state.positions,
      });
  // Remembered for the next draw's pinning, trimmed to what is actually on
  // screen so a node dropped from the slice does not keep a stale position.
  state.positions = new Map(
    [...positions].filter(([id]) => visible.has(id)).map(([id, point]) => [id, point]),
  );

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
    // Single click: select, and grow the picture outward from this node — the
    // neighbours are merged in, so nothing already on screen is lost. Double
    // click: open its details. expandFrom decides for itself which tabs it
    // applies to.
    group.addEventListener("click", () => {
      select(node.id);
      expandFrom(node.id);
    });
    group.addEventListener("dblclick", (event) => {
      event.preventDefault();
      openDetails(node.id);
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select(node.id);
        expandFrom(node.id);
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
 * Expand the clicked node in place: fetch its immediate neighbourhood and
 * merge it into what is already drawn, rather than replacing the picture.
 * The graph grows outward from wherever the reader started, and because the
 * concentric layout pins nodes it has already placed, nothing that was on
 * screen moves when new nodes arrive.
 *
 * Expanding the same node twice is a no-op: it is recorded in state.expanded
 * and its neighbours are already in the slice.
 */
async function expandFrom(id) {
  // Expanding is a recorded-graph, main-tab idea: the emergent graph is one
  // question's own fixed export with no seed to follow outward, and the
  // person/causal layers are defined by an edge type — pulling in a node's
  // full neighbourhood there would drag in edges the layer excludes and stop
  // it being that layer.
  if (state.source !== "recorded" || state.layer !== "main") return;
  if (state.expanded.has(id)) return;

  $("#status-line").textContent = "Loading…";
  try {
    const cached = state.cache.main.get(id);
    const slice = cached ?? await fetchSlice(`/api/v1/graph?${new URLSearchParams({
      seed: id,
      depth: "1",
      includeActors: $("#include-actors").checked ? "true" : "false",
    })}`);
    if (!cached) state.cache.main.set(id, slice);
    state.expanded.add(id);
    state.slice = mergeSlices(state.slice, slice);
    drawPicture();
    drawTable();
    reportCounts();
    $("#restore").disabled = false;
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

/** Union of two slices: nodes deduped by id, edges by the triple that makes
 * one unique. The existing slice wins on conflict, so a node already drawn
 * keeps the form the reader has been looking at. */
function mergeSlices(current, addition) {
  if (!current) return addition;
  const nodes = [...current.nodes];
  const seenNodes = new Set(nodes.map((node) => node.id));
  for (const node of addition.nodes) {
    if (seenNodes.has(node.id)) continue;
    seenNodes.add(node.id);
    nodes.push(node);
  }

  const edges = [...current.edges];
  const edgeKey = (edge) => `${edge.source}\u0000${edge.target}\u0000${edge.type}`;
  const seenEdges = new Set(edges.map(edgeKey));
  for (const edge of addition.edges) {
    const key = edgeKey(edge);
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push(edge);
  }

  return { nodes, edges, truncated: current.truncated || addition.truncated };
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

  if (EDGE_TYPE_LAYERS.has(state.layer)) {
    const parameters = new URLSearchParams({
      edgeTypes: LAYER_EDGE_TYPES[state.layer].join(","),
      limit: "120",
    });
    // includeActors pulls in the person/organization nodes an 'involves' edge
    // reaches from whatever the layer's own edge type already selected. None
    // of these layers wants that: the causal layer's edges never touch a
    // person, so asking for actors there would strand person nodes with no
    // edge of this layer's type to draw; the person and domain layers already
    // reach everyone their own edge type connects.
    return `/api/v1/graph?${parameters}`;
  }

  if (state.layer === "timeline") {
    // Every event, laid out by when it happened. nodeType=event is not
    // optional here: without it the slice comes back ordered by ref_key and
    // filled with organizations and domains, which have no timestamp at all —
    // the first version of this drew 120 nodes and no timeline.
    return `/api/v1/graph?${new URLSearchParams({ nodeType: "event", limit: "120" })}`;
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
      // Nothing asked yet, so open on the causal spine: the twelve incidents
      // and how they caused one another. subtype=incident asks for the event
      // nodes specifically — incidentsOnly matches anything *flagged* as
      // incident-related, which is the jira items, and gave a thin picture of
      // 5 tickets with no causal edges at all. Small enough to read, and every
      // node in it can be clicked open from here.
      state.mainOriginalSeed = MAIN_NO_SEED_KEY;
      parameters.set("subtype", "incident");
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
  // Same rule as drawPicture, so the count of what is not drawn matches what
  // actually was not drawn.
  const cap = state.layer !== "main" || state.expanded.size > 0
    ? MAX_DRAWN
    : MAIN_LAYER_CAP;
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
  // A fresh draw is a new picture, not a growth of the current one, so no
  // node keeps its old place, nothing counts as already expanded, and the
  // centre is recomputed below.
  state.positions = new Map();
  state.centreId = null;
  state.expanded = new Set();

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
      // The seed the question resolved to is what the picture is about, so it
      // is the centre. The sentinel used when no question was asked is not a
      // real node, so that case falls through to the best-connected node.
      if (state.mainOriginalSeed !== MAIN_NO_SEED_KEY) state.centreId = state.mainOriginalSeed;
    }
    if (state.source === "recorded" && state.layer !== "main") {
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

/** Redraw whichever tab is open from its own cached first slice, discarding
 * everything clicking around has grown onto it. Main returns to the question
 * most recently asked; person/causal return to their one fixed slice. This is
 * the only way back once the picture has been expanded, which is why the
 * remembered positions and the expanded set are cleared with it. A no-op, not
 * an error, if nothing has been drawn yet to restore. */
function restoreOriginal() {
  if (state.source !== "recorded") return;
  const cached = state.layer === "main"
    ? state.cache.main.get(state.mainOriginalSeed)
    : state.cache[state.layer];
  if (!cached) return;
  state.slice = cached;
  state.positions = new Map();
  state.expanded = new Set();
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

  // Each layer is its own picture: positions from the layer being left would
  // pin nodes to places that meant something in a different graph.
  state.positions = new Map();
  state.expanded = new Set();
  state.centreId = null;

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
  // Every layer other than main is a fixed view of one kind of relationship:
  // none of the query, seed or filter controls apply to it.
  const onLayerTabs = state.layer !== "main";
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
