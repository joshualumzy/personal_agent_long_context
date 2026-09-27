/**
 * The recorded graph, drawn from Postgres, on two pages that share this
 * script (the page's <body data-mode> says which):
 *   - company (/graph): the company overviews — Departments, Who knows what,
 *     Incidents, Documents, Customers & vendors, Timeline — each from
 *     /api/v1/graph/view/:name, a fixed subgraph that needs no question;
 *   - answer (/graph/answer?q=…&sources=…): one chat answer's graph, from
 *     /api/v1/graph/query with the question in the middle and the things its
 *     cited evidence belongs to around it. The chat opens it in a dialog from
 *     the small preview above an answer's evidence.
 * Either way the picture grows by clicking: /api/v1/graph/expand adds a few
 * neighbours of each kind around the clicked item and folds the rest into a
 * "+N more" item, which pages in the next few when clicked. Nothing already on
 * screen moves when something is added.
 *
 * The category chips filter what is shown and what an expansion asks for.
 * Every relationship drawn is also a row in the table, which is where they can
 * be read precisely and without the picture.
 */

const SVG = "http://www.w3.org/2000/svg";
const $ = (selector) => document.querySelector(selector);
const MODE = document.body.dataset.mode === "answer" ? "answer" : "company";

/** What a reader filters by: the categories graph-neighbourhood.ts uses. */
const CATEGORIES = [
  ["people", "People"],
  ["departments", "Departments"],
  ["domains", "Knowledge domains"],
  ["work", "Tickets & work"],
  ["events", "Events"],
  ["documents", "Documents"],
  ["partners", "Customers & vendors"],
];

/**
 * How each overview is laid out. Structure views are columns, one per kind of
 * thing, so the relationship the view is about runs left to right; the
 * timeline puts time on the x axis. The question graph is radial: the question
 * in the middle, what it points at around it.
 */
const VIEWS = {
  query: { layout: "radial" },
  // `hub` is the column whose nodes the others are grouped beside; a `free`
  // column is joined to many hub nodes at once (a domain many people know),
  // so it is spread down the side in the order of what it connects to rather
  // than tied to one of them.
  org: { layout: "columns", columns: ["people", "departments", "domains"], hub: "departments" },
  expertise: {
    layout: "columns", columns: ["departments", "people", "domains"],
    hub: "departments", free: ["domains"],
  },
  incidents: {
    layout: "columns", columns: ["people", "events", "work", "documents", "domains"],
    hub: "events", free: ["people", "domains"],
  },
  documents: {
    layout: "columns", columns: ["events", "documents", "people", "domains"],
    hub: "documents", free: ["people", "domains"],
  },
  customers: { layout: "columns", columns: ["contacts", "partners", "work", "events", "documents"], hub: "partners" },
  timeline: { layout: "timeline" },
};

/** Neighbours per category an expansion adds before folding the rest. */
const EXPAND_BUDGET = 5;
/** Past this many items the picture stops being readable; say so instead. */
const MAX_DRAWN = 300;
const COLUMN_GAP = 250;
const ROW_GAP = 26;

const state = {
  view: MODE === "answer" ? "query" : "org",
  query: "",
  /** On the answer page: the answer's own question and the evidence it cited,
   * which "Back to start" returns to after re-centring on something else. */
  origin: "",
  sources: [],
  slice: null,
  /** The slice the current view first drew, for Back to start. */
  start: null,
  centreId: null,
  positions: new Map(),
  expanded: new Set(),
  hidden: new Set(),
  selected: null,
  evidenceCache: new Map(),
  /** The time scale the timeline was first drawn at, kept so expanding a day
   * places its events on the same axis. */
  timeScale: null,
  viewBox: { x: -420, y: -320, width: 840, height: 640 },
  /** Bumped on every load, so a slow response to an older request is dropped
   * instead of drawing over a newer one. */
  generation: 0,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

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

/** A node's natural key, never the `type:` prefixed id a person would not cite. */
function naturalKey(node) {
  return node.refKey ?? node.id;
}

function nameOf(node) {
  return node.label || naturalKey(node);
}

function shortLabel(node, length = 24) {
  const label = nameOf(node);
  return label.length > length ? `${label.slice(0, length - 1)}…` : label;
}

/** The same categories the server budgets by (src/graph-neighbourhood.ts). */
function categoryOf(node) {
  switch (node.type) {
    case "person": return node.subtype === "external_contact" ? "partners" : "people";
    case "organization": return node.subtype === "department" ? "departments" : "partners";
    case "item": return node.subtype === "domain" ? "domains" : "work";
    case "event": return "events";
    case "document": return "documents";
    case "cluster": return node.props?.category ?? null;
    default: return null;
  }
}

function describeKind(node) {
  const incident = node.isIncident ? ", part of an incident" : "";
  switch (node.type) {
    case "query": return "Your question";
    case "cluster":
      return node.props?.day ? "Everything else that happened that day" : "More of one kind, not drawn yet";
    case "person": return node.subtype === "external_contact" ? "Customer or vendor contact" : "Person";
    case "organization":
      if (node.subtype === "department") return "Department";
      if (node.subtype === "customer") return "Customer";
      if (node.subtype === "vendor") return "Vendor";
      return "Organization";
    case "item":
      if (node.subtype === "domain") return "Knowledge domain";
      return `Work item${node.subtype ? ` (${node.subtype.replace(/_/g, " ")})` : ""}${incident}`;
    case "event": return `Event${node.subtype ? ` (${node.subtype.replace(/_/g, " ")})` : ""}${incident}`;
    case "document": return `Document${incident}`;
    default: return "Item";
  }
}

/** A day summary expands to its events like any node; a "+N more" cluster
 * pages. The question itself is where the picture starts, not something to
 * expand. */
function isPager(node) {
  return node.type === "cluster" && typeof node.props?.parent === "string";
}

function expandable(node) {
  return node.type !== "query" && !state.expanded.has(node.id);
}

function visibleNodes() {
  return state.slice.nodes.filter((node) => {
    const category = categoryOf(node);
    return category === null || !state.hidden.has(category);
  });
}

function enabledCategories() {
  return CATEGORIES.map(([key]) => key).filter((key) => !state.hidden.has(key));
}

async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `The graph could not be loaded (${response.status}).`);
  }
  return response.json();
}

function showError(message) {
  const banner = $("#error");
  banner.textContent = message;
  banner.hidden = !message;
}

// ---------------------------------------------------------------------------
// Layouts. Each places only nodes without a position, so nothing already on
// screen moves when an expansion adds to the picture.
// ---------------------------------------------------------------------------

/** The question in the middle, its seeds evenly around it. */
function radialLayout(nodes, centreId) {
  const others = nodes.filter((node) => node.id !== centreId);
  if (centreId) state.positions.set(centreId, { x: 0, y: 0 });
  others.forEach((node, index) => {
    if (state.positions.has(node.id)) return;
    const angle = -Math.PI / 2 + (index / Math.max(others.length, 1)) * Math.PI * 2;
    state.positions.set(node.id, { x: Math.cos(angle) * 190, y: Math.sin(angle) * 190 });
  });
}

/** Which column a node belongs in. A customer's or vendor's contact gets its
 * own, so the people writing in do not mix with the organizations. */
function columnOf(node) {
  if (node.type === "person" && node.subtype === "external_contact") return "contacts";
  return categoryOf(node) ?? "other";
}

/**
 * One column per kind, in the order the view names, then any others — but a
 * column of forty people drawn as one line is too tall to read at any zoom.
 * So one column is the hub (departments in the org view, organizations in
 * customers, incidents in incidents: the column whose nodes carry the most
 * edges each), each hub node gets a block, and every other column lays out
 * the nodes joined to that hub in a small grid beside it. People end up under
 * their department, a customer's deals and its "+N more" beside the
 * customer. Nodes joined to no hub go at the bottom of their column.
 */
function columnsLayout(nodes, edges, columns, hubColumn, freeColumns = []) {
  const byColumn = new Map();
  for (const node of nodes) {
    const column = columnOf(node);
    if (!byColumn.has(column)) byColumn.set(column, []);
    byColumn.get(column).push(node);
  }
  const order = [
    ...columns.filter((column) => byColumn.has(column)),
    ...[...byColumn.keys()].filter((column) => !columns.includes(column)),
  ];
  const neighbours = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (neighbours.has(edge.source) && neighbours.has(edge.target)) {
      neighbours.get(edge.source).push(edge.target);
      neighbours.get(edge.target).push(edge.source);
    }
  }
  const columnOfId = new Map(nodes.map((node) => [node.id, columnOf(node)]));

  // The hub the view names, or else the column with the most edges per node.
  const hub = hubColumn && byColumn.has(hubColumn) ? hubColumn : [...order].sort((left, right) => {
    const density = (column) => {
      const list = byColumn.get(column);
      const degree = list.reduce((sum, node) => sum + neighbours.get(node.id).length, 0);
      return list.length > 1 ? degree / list.length : 0;
    };
    return density(right) - density(left);
  })[0];
  const hubNodes = [...byColumn.get(hub)].sort((left, right) => nameOf(left).localeCompare(nameOf(right)));
  const hubIndex = new Map(hubNodes.map((node, index) => [node.id, index]));

  // Each non-hub node belongs to the first hub node it is joined to. A node
  // two steps away (a person's domain, via the department) follows the hub of
  // whatever it is joined to that already has one.
  const home = new Map();
  for (const node of hubNodes) home.set(node.id, node.id);
  const free = new Set(freeColumns.filter((column) => column !== hub));
  for (let pass = 0; pass < 3; pass += 1) {
    for (const node of nodes) {
      if (home.has(node.id) || free.has(columnOfId.get(node.id))) continue;
      const owners = neighbours.get(node.id)
        .map((id) => home.get(id))
        .filter((id) => id !== undefined)
        .sort((left, right) => hubIndex.get(left) - hubIndex.get(right));
      if (owners.length) home.set(node.id, owners[0]);
    }
  }

  // Rows per sub-column: enough to keep the whole picture roughly as wide
  // as it is tall.
  const largest = Math.max(...order.filter((column) => column !== hub)
    .map((column) => byColumn.get(column).length), 1);
  const wrap = Math.min(Math.max(Math.ceil(largest / Math.max(hubNodes.length, 1) / 1.5), 3), 8);
  const SUB = 150;

  // Block height per hub node: the tallest of its groups.
  const groups = new Map();
  for (const node of nodes) {
    if (columnOfId.get(node.id) === hub || free.has(columnOfId.get(node.id))) continue;
    const key = `${home.get(node.id) ?? "none"}\u0000${columnOfId.get(node.id)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  for (const list of groups.values()) {
    list.sort((left, right) =>
      Number(left.type === "cluster") - Number(right.type === "cluster") ||
      nameOf(left).localeCompare(nameOf(right)));
  }
  const rowsOf = (owner) => Math.max(1, ...order.map((column) =>
    Math.min(groups.get(`${owner}\u0000${column}`)?.length ?? 0, wrap)));

  // Columns are as wide as their widest group's sub-columns.
  const subColumns = new Map(order.map((column) => [column, 1]));
  for (const [key, list] of groups) {
    const column = key.split("\u0000")[1];
    subColumns.set(column, Math.max(subColumns.get(column), Math.ceil(list.length / wrap)));
  }
  const hubAt = order.indexOf(hub);
  const columnX = new Map();
  let cursor = 0;
  order.forEach((column) => {
    columnX.set(column, cursor);
    cursor += (subColumns.get(column) - 1) * SUB + COLUMN_GAP;
  });
  const shift = columnX.get(hub);

  const place = (node, point) => {
    if (!state.positions.has(node.id)) state.positions.set(node.id, point);
  };
  let y = 0;
  const blockTop = new Map();
  for (const owner of [...hubNodes.map((node) => node.id), "none"]) {
    const rows = owner === "none"
      ? Math.max(0, ...order.map((column) => Math.min(groups.get(`none\u0000${column}`)?.length ?? 0, wrap)))
      : rowsOf(owner);
    if (rows === 0) continue;
    blockTop.set(owner, y);
    if (owner !== "none") {
      place(nodes.find((node) => node.id === owner), { x: 0, y: y + ((rows - 1) / 2) * ROW_GAP });
    }
    for (const column of order) {
      if (column === hub) continue;
      const list = groups.get(`${owner}\u0000${column}`) ?? [];
      // Sub-columns grow away from the hub, so the nearest is the first.
      const direction = order.indexOf(column) < hubAt ? -1 : 1;
      list.forEach((node, index) => {
        const sub = Math.floor(index / wrap);
        const baseX = columnX.get(column) - shift;
        place(node, {
          x: baseX + direction * sub * SUB,
          y: y + (index % wrap) * ROW_GAP,
        });
      });
    }
    y += rows * ROW_GAP + ROW_GAP;
  }

  // Free columns: in the order of the average height of what each node is
  // joined to, spread over the height the blocks took.
  const height = Math.max(y - ROW_GAP, ROW_GAP);
  for (const column of free) {
    const list = byColumn.get(column);
    if (!list) continue;
    const pull = (node) => {
      const ys = neighbours.get(node.id)
        .map((id) => state.positions.get(id)?.y)
        .filter((value) => value !== undefined);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : height;
    };
    const sorted = [...list].sort((left, right) => pull(left) - pull(right));
    const step = Math.max(ROW_GAP, height / Math.max(sorted.length - 1, 1));
    const top = sorted.length > 1 ? Math.max(0, (height - step * (sorted.length - 1)) / 2) : height / 2;
    sorted.forEach((node, index) => place(node, { x: columnX.get(column) - shift, y: top + index * step }));
  }
}

const TIMELINE_LANES = {
  incident: "Incidents",
  sprint_planned: "Sprints",
  zd_ticket: "Customer tickets",
  confluence_created: "Pages written",
  design_discussion: "Discussions",
  jira_ticket_created: "Tickets opened",
  ticket_progress: "Ticket progress",
  pr_review: "PR reviews",
  dept_plan_created: "Department plans",
};

function timeOf(node) {
  const raw = node.props?.occurred_at ?? node.props?.opened_at;
  const parsed = raw ? Date.parse(String(raw)) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function laneOf(node) {
  if (node.id.startsWith("day:")) return "Everything else, by day";
  return TIMELINE_LANES[node.subtype] ?? "Other events";
}

/**
 * x is when it happened, y a lane per kind of event: the milestones, then one
 * summary per day for everything else, then — once a day is opened — a lane
 * for each kind of event it held. Something with no time (a person reached
 * by expanding an incident) is placed around what it was reached from.
 */
function timelineLayout(nodes) {
  if (!state.timeScale) {
    const times = nodes.map(timeOf).filter((value) => value !== null);
    const earliest = times.length ? Math.min(...times) : 0;
    const latest = times.length ? Math.max(...times) : 1;
    state.timeScale = { earliest, span: latest - earliest || 1, lanes: [] };
  }
  const scale = state.timeScale;
  const stacked = new Map();
  for (const point of state.positions.values()) {
    const key = `${Math.round(point.x)}:${Math.round(point.y)}`;
    stacked.set(key, (stacked.get(key) ?? 0) + 1);
  }
  const lanePreference = [...Object.values(TIMELINE_LANES).slice(0, 3), "Everything else, by day"];
  for (const node of nodes) {
    if (state.positions.has(node.id)) continue;
    const time = timeOf(node);
    if (time === null) continue;
    const lane = laneOf(node);
    if (!scale.lanes.includes(lane)) {
      scale.lanes.push(lane);
      scale.lanes.sort((left, right) => {
        const a = lanePreference.indexOf(left);
        const b = lanePreference.indexOf(right);
        return (a < 0 ? 99 : a) - (b < 0 ? 99 : b);
      });
    }
  }
  for (const node of nodes) {
    if (state.positions.has(node.id)) continue;
    const time = timeOf(node);
    if (time === null) continue;
    const x = -520 + ((time - scale.earliest) / scale.span) * 1040;
    const baseY = -200 + scale.lanes.indexOf(laneOf(node)) * 70;
    const key = `${Math.round(x)}:${baseY}`;
    const count = stacked.get(key) ?? 0;
    stacked.set(key, count + 1);
    state.positions.set(node.id, { x, y: baseY + (count % 5) * 11 });
  }
}

/** New neighbours fanned out around what they were reached from, facing away
 * from the middle of the picture so the graph grows outward. */
function placeAround(parentId, nodes) {
  const parent = state.positions.get(parentId);
  const fresh = nodes.filter((node) => !state.positions.has(node.id));
  if (!parent || fresh.length === 0) return;
  const centre = (state.centreId && state.positions.get(state.centreId)) || { x: 0, y: 0 };
  const outward = parent.x === centre.x && parent.y === centre.y
    ? null
    : Math.atan2(parent.y - centre.y, parent.x - centre.x);
  const spread = outward === null ? Math.PI * 2 : Math.min(Math.PI * 1.3, 0.34 * fresh.length);
  const occupied = [...state.positions.values()];
  fresh.forEach((node, index) => {
    const fraction = fresh.length === 1 ? 0.5 : index / (fresh.length - (outward === null ? 0 : 1));
    const angle = (outward ?? 0) - (outward === null ? 0 : spread / 2) + fraction * spread;
    let radius = Math.max(120, fresh.length * 14) + (index % 2) * 45;
    let point = { x: parent.x + Math.cos(angle) * radius, y: parent.y + Math.sin(angle) * radius };
    for (let attempt = 0; attempt < 4 && occupied.some((other) =>
      Math.hypot(other.x - point.x, other.y - point.y) < 22); attempt += 1) {
      radius += 40;
      point = { x: parent.x + Math.cos(angle) * radius, y: parent.y + Math.sin(angle) * radius };
    }
    occupied.push(point);
    state.positions.set(node.id, point);
  });
}

/** Place whatever has no position yet, the way the current view lays out. */
function placeNew(parentId) {
  const nodes = state.slice.nodes;
  const layout = VIEWS[state.view].layout;
  if (layout === "timeline") timelineLayout(nodes);
  else if (layout === "columns" && !parentId) {
    const view = VIEWS[state.view];
    columnsLayout(nodes, state.slice.edges, view.columns, view.hub, view.free);
  }
  else if (layout === "radial" && !parentId) radialLayout(nodes, state.centreId);
  // An expansion's additions go around what was expanded, whatever the view:
  // appending them to a far column would put them out of sight of it.
  if (parentId) placeAround(parentId, nodes);
  // Anything still unplaced (reached from nothing on screen) goes to the side.
  let spare = 0;
  for (const node of nodes) {
    if (state.positions.has(node.id)) continue;
    state.positions.set(node.id, { x: 460, y: -200 + spare * ROW_GAP });
    spare += 1;
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** On the timeline, a day is a bar as tall as the day was busy — eighty
 * captions in one lane would be unreadable — and a milestone is captioned by
 * its key ("ENG-112", "Sprint 3") rather than its full title. */
function timelineShape(node) {
  const total = Number(node.props?.total ?? 1);
  const height = Math.max(4, Math.min(48, Math.sqrt(total) * 6));
  return svg("rect", { x: -3, y: -height, width: 6, height, class: "shape n-day" });
}

function timelineCaption(node) {
  if (node.subtype === "incident" || node.subtype === "zd_ticket") return naturalKey(node);
  if (node.subtype === "sprint_planned") return nameOf(node).split(":")[0];
  return shortLabel(node, 18);
}

/** Shapes at `size` 1 fit the dense layouts (columns, timeline); the radial
 * pictures draw them half as large again, so each one reads at a glance. */
function shapeFor(node, size = 1) {
  if (node.id.startsWith("day:") && VIEWS[state.view].layout === "timeline") return timelineShape(node);
  const incident = node.isIncident ? " incident" : "";
  const k = (value) => +(value * size).toFixed(1);
  const points = (pairs) => pairs.map(([x, y]) => `${k(x)},${k(y)}`).join(" ");
  switch (node.type) {
    case "person":
      return svg("polygon", { points: points([[0, -7], [7, 0], [0, 7], [-7, 0]]), class: `shape n-person${incident}` });
    case "organization":
      return svg("polygon", { points: points([[-4, -7], [4, -7], [7, 0], [4, 7], [-4, 7], [-7, 0]]), class: `shape n-organization${incident}` });
    case "item":
      return svg("circle", { r: k(7), class: `shape n-item${incident}` });
    case "event":
      return svg("rect", { x: k(-6), y: k(-6), width: k(12), height: k(12), class: `shape n-event${incident}` });
    case "document":
      return svg("polygon", { points: points([[0, -7], [7, 6], [-7, 6]]), class: `shape n-document${incident}` });
    case "query":
      return svg("circle", { r: 11, class: "shape n-query" });
    case "cluster":
      return svg("circle", { r: k(8), class: "shape n-cluster" });
    default:
      return svg("circle", { r: k(7), class: "shape n-item" });
  }
}

/** The question at the centre of a radial picture: an indigo pill with its
 * words inside, on two lines when it is long. */
function questionPill(node) {
  const words = shortLabel(node, 70).split(/\s+/);
  const lines = [""];
  for (const word of words) {
    const line = lines[lines.length - 1];
    if (line && `${line} ${word}`.length > 30 && lines.length < 2) lines.push(word);
    else lines[lines.length - 1] = line ? `${line} ${word}` : word;
  }
  const width = Math.max(...lines.map((line) => line.length)) * 6.6 + 34;
  const height = lines.length === 1 ? 30 : 44;
  const pill = svg("rect", {
    x: (-width / 2).toFixed(1), y: -height / 2, width: width.toFixed(1), height, rx: height / 2,
    class: "shape n-query",
  });
  const label = svg("text", { class: "pill-label" });
  lines.forEach((line, index) => {
    const tspan = svg("tspan", { x: 0, y: (index - (lines.length - 1) / 2) * 15 + 4 });
    tspan.textContent = line;
    label.append(tspan);
  });
  return [pill, label];
}

/** A second line under an item: what kind of thing it is, briefly. */
function shortKind(node) {
  const kind = describeKind(node)
    .replace(/^Work item \((.*?)\)/, "$1")
    .replace(/^Event \((.*?)\)/, "$1")
    .replace(/, part of an incident$/, ", incident");
  const text = kind.charAt(0).toLowerCase() + kind.slice(1);
  return text.length > 30 ? `${text.slice(0, 29)}…` : text;
}

function setViewBox(box) {
  state.viewBox = box;
  $("#canvas").setAttribute(
    "viewBox",
    `${box.x.toFixed(1)} ${box.y.toFixed(1)} ${box.width.toFixed(1)} ${box.height.toFixed(1)}`,
  );
}

/** Whether everything drawn is inside the current frame. */
function allInView() {
  const box = state.viewBox;
  return visibleNodes().every((node) => {
    const point = state.positions.get(node.id);
    return !point || (point.x >= box.x && point.x <= box.x + box.width &&
      point.y >= box.y && point.y <= box.y + box.height);
  });
}

/** Frame everything drawn, with room for captions. */
function fit() {
  const points = visibleNodes().map((node) => state.positions.get(node.id)).filter(Boolean);
  if (points.length === 0) return;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs) - 60;
  const right = Math.max(...xs) + (VIEWS[state.view].layout === "radial" ? 60 : 170);
  const top = Math.min(...ys) - 40;
  const bottom = Math.max(...ys) + 40;
  const width = Math.max(right - left, 480);
  const height = Math.max(bottom - top, 360);
  setViewBox({
    x: (left + right) / 2 - width / 2,
    y: (top + bottom) / 2 - height / 2,
    width,
    height,
  });
}

function drawLaneLabels(layer) {
  if (VIEWS[state.view].layout !== "timeline" || !state.timeScale) return;
  state.timeScale.lanes.forEach((lane, index) => {
    layer.append(Object.assign(
      svg("text", { x: -540, y: -212 + index * 70, class: "lane-label" }),
      { textContent: lane },
    ));
  });
}

function drawPicture() {
  const canvas = $("#canvas");
  canvas.replaceChildren(canvas.querySelector("title"));

  const nodes = visibleNodes();
  const shown = new Set(nodes.map((node) => node.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sideCaptions = VIEWS[state.view].layout === "columns";
  const timeline = VIEWS[state.view].layout === "timeline";
  // Timeline nodes in time order, so alternating captions alternate between
  // neighbours on the axis.
  const laneCount = new Map();
  if (timeline) nodes.sort((left, right) => (timeOf(left) ?? 0) - (timeOf(right) ?? 0));

  const lanes = svg("g");
  drawLaneLabels(lanes);

  const edgeLayer = svg("g");
  for (const edge of state.slice.edges) {
    if (!shown.has(edge.source) || !shown.has(edge.target)) continue;
    const a = state.positions.get(edge.source);
    const b = state.positions.get(edge.target);
    if (!a || !b) continue;
    const line = svg("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `edge ${edge.type}` });
    line.append(Object.assign(svg("title"), {
      textContent: `${nameOf(byId.get(edge.source))} — ${edge.type.replace(/_/g, " ")} → ${nameOf(byId.get(edge.target))}`,
    }));
    edgeLayer.append(line);
  }

  const nodeLayer = svg("g");
  for (const node of nodes) {
    const point = state.positions.get(node.id);
    if (!point) continue;
    // tabindex makes each node a stop, so the diagram is walkable without a
    // pointer; the label says what it is and whether it opens up.
    const group = svg("g", {
      class: `node kind-${node.type}${state.expanded.has(node.id) ? " expanded" : ""}`,
      transform: `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`,
      tabindex: "0",
      role: "button",
      "aria-label": `${nameOf(node)}. ${describeKind(node)}.${expandable(node) ? " Press Enter to open it up." : ""}`,
      "data-id": node.id,
    });
    let caption;
    if (timeline) {
      // Alternate above and below, so neighbours on the time axis do not
      // print over each other.
      const above = (laneCount.get(laneOf(node)) ?? 0) % 2 === 1;
      laneCount.set(laneOf(node), (laneCount.get(laneOf(node)) ?? 0) + 1);
      caption = svg("text", { y: above ? -11 : 19, class: "caption" });
      caption.textContent = node.id.startsWith("day:") ? "" : timelineCaption(node);
    } else if (sideCaptions && node.type !== "query") {
      caption = svg("text", { x: 12, y: 3, class: "caption side" });
      caption.textContent = shortLabel(node, 32);
    } else if (node.type === "query") {
      caption = null;
    } else {
      caption = svg("text", { y: 27, class: "caption label" });
      caption.textContent = shortLabel(node, 26);
    }
    const radial = !timeline && !sideCaptions;
    group.append(svg("title", {}));
    if (caption) group.append(caption);
    if (radial && node.type !== "query" && node.type !== "cluster") {
      const sub = svg("text", { y: 40, class: "sub" });
      sub.textContent = shortKind(node);
      group.append(sub);
    }
    group.querySelector("title").textContent = `${nameOf(node)} — ${describeKind(node)}`;
    if (node.type === "query" && !timeline) {
      group.prepend(...questionPill(node));
    } else {
      group.prepend(svg("circle", { r: radial ? 18 : 13, class: "ring" }), shapeFor(node, radial ? 1.55 : 1));
    }
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      activate(node.id);
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate(node.id);
      }
    });
    group.addEventListener("focus", () => select(node.id));
    nodeLayer.append(group);
  }
  canvas.append(lanes, edgeLayer, nodeLayer);
  for (const group of canvas.querySelectorAll(".node")) {
    group.classList.toggle("selected", group.dataset.id === state.selected);
  }
}

function drawTable() {
  const nodes = visibleNodes();
  const shown = new Set(nodes.map((node) => node.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = state.slice.edges.filter((edge) => shown.has(edge.source) && shown.has(edge.target));
  $("#edge-rows").replaceChildren(...edges.map((edge) => {
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    return h("tr", {},
      h("td", {}, nameOf(from)),
      h("td", { class: "kind" }, describeKind(from)),
      h("td", { class: "kind" }, edge.type.replace(/_/g, " ")),
      h("td", {}, nameOf(to)),
    );
  }));
  $("#table-summary").textContent = `${nodes.length} items, ${edges.length} relationships.`;
}

function reportCounts() {
  const nodes = visibleNodes();
  const folded = nodes
    .filter(isPager)
    .reduce((sum, node) => sum + Number(node.props?.hidden ?? 0), 0);
  const filtered = state.slice.nodes.length - nodes.length;
  const shown = new Set(nodes.map((node) => node.id));
  const edges = state.slice.edges.filter((edge) => shown.has(edge.source) && shown.has(edge.target));
  $("#status-line").textContent = [
    `${nodes.length} items, ${edges.length} relationships`,
    folded ? `${folded} more folded into “+N more” items` : null,
    filtered ? `${filtered} hidden by the filters` : null,
  ].filter(Boolean).join(" · ");
}

function redraw() {
  drawPicture();
  drawTable();
  reportCounts();
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

function select(id) {
  state.selected = id;
  const node = state.slice?.nodes.find((candidate) => candidate.id === id);
  if (!node) return;
  for (const group of document.querySelectorAll(".node")) {
    group.classList.toggle("selected", group.dataset.id === id);
  }

  const byId = new Map(state.slice.nodes.map((candidate) => [candidate.id, candidate]));
  const neighbours = [];
  for (const edge of state.slice.edges) {
    if (edge.source === id && byId.has(edge.target)) {
      neighbours.push({ node: byId.get(edge.target), direction: "to", type: edge.type });
    } else if (edge.target === id && byId.has(edge.source)) {
      neighbours.push({ node: byId.get(edge.source), direction: "from", type: edge.type });
    }
  }

  const connected = h("div", { class: "detail-pane" },
    neighbours.length
      ? h("ul", { class: "neighbours" },
          ...neighbours.slice(0, 30).map(({ node: other, direction, type }) =>
            h("li", {},
              h("span", { class: "kind" }, `${direction === "to" ? "→ " : "← "}${type.replace(/_/g, " ")} `),
              h("button", { type: "button", onclick: () => focusNode(other.id) }, nameOf(other)),
            )))
      : h("p", { class: "hint-line" }, "Nothing else on screen connects to it yet."));
  const attributes = h("div", { class: "detail-pane", hidden: true });
  const evidence = h("div", { class: "detail-pane", hidden: true });
  renderAttributes(attributes, node);

  const panes = [["Connected", connected], ["Attributes", attributes], ["Evidence", evidence]];
  const buttons = panes.map(([name, pane], index) => h("button", {
    type: "button",
    class: `detail-tab${index === 0 ? " on" : ""}`,
    onclick: async () => {
      buttons.forEach((button, other) => button.classList.toggle("on", other === index));
      panes.forEach(([, other]) => { other.hidden = other !== pane; });
      if (pane === evidence) await renderEvidence(evidence, node);
    },
  }, name));

  const actions = h("div", { class: "detail-actions" },
    expandable(node) && !isPager(node)
      ? h("button", { type: "button", class: "quiet", onclick: () => expand(node.id) }, "Open it up")
      : null,
    isPager(node)
      ? h("button", { type: "button", class: "quiet", onclick: () => expand(node.id) }, "Show the next few")
      : null,
    MODE === "answer" && node.type !== "query" && node.type !== "cluster"
      ? h("button", { type: "button", class: "quiet", onclick: () => ask(nameOf(node)) }, "Centre on this")
      : null,
  );

  $("#details").replaceChildren(
    h("p", { class: "name" }, nameOf(node)),
    h("p", { class: "kind-line" }, describeKind(node)),
    actions,
    h("div", { class: "detail-tabs" }, ...buttons),
    connected, attributes, evidence,
  );
}

function focusNode(id) {
  const group = document.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
  if (group) group.focus();
  else select(id);
}

/** node.props as delivered. Bookkeeping fields that repeat what the panel
 * already says are skipped, so what is left is what distinguishes the node —
 * an incident's root cause, a page's self-audit, a member's first day. */
function renderAttributes(container, node) {
  // facts is the raw corpus row, already read into the fields worth showing;
  // parent/offset are a cluster's paging bookkeeping.
  const skip = new Set(["source_type", "category", "is_incident", "facts", "parent", "offset"]);
  const entries = Object.entries(node.props ?? {}).filter(
    ([key, value]) => !skip.has(key) && value !== null && value !== undefined && value !== "",
  );
  const list = h("dl", {});
  if (node.type !== "query" && node.type !== "cluster") {
    list.append(h("dt", {}, "Identifier"), h("dd", {}, naturalKey(node)));
  }
  for (const [key, value] of entries) {
    list.append(
      h("dt", {}, key.replace(/_/g, " ")),
      h("dd", {}, typeof value === "object" ? JSON.stringify(value) : String(value)),
    );
  }
  container.replaceChildren(
    list,
    entries.length === 0 ? h("p", { class: "hint-line" }, "No other attributes recorded.") : null,
  );
}

/** The question's own evidence for the question; for anything else, the same
 * retrieval a question about its label would get — not provenance for one
 * edge, which the graph does not keep. */
async function renderEvidence(container, node) {
  if (node.type === "query") return renderEvidenceList(container, state.slice.evidence ?? []);
  const cached = state.evidenceCache.get(node.id);
  if (cached) return renderEvidenceList(container, cached);
  container.replaceChildren(h("p", { class: "hint-line" }, "Searching…"));
  try {
    const body = await fetchJSON(
      `/api/v1/graph/evidence?${new URLSearchParams({ label: nameOf(node), limit: "5" })}`,
    );
    const evidence = Array.isArray(body.evidence) ? body.evidence : [];
    state.evidenceCache.set(node.id, evidence);
    renderEvidenceList(container, evidence);
  } catch (error) {
    container.replaceChildren(h("p", { class: "hint-line" }, error instanceof Error ? error.message : String(error)));
  }
}

function renderEvidenceList(container, evidence) {
  if (evidence.length === 0) {
    container.replaceChildren(h("p", { class: "hint-line" }, "Nothing found."));
    return;
  }
  container.replaceChildren(h("ul", { class: "evidence-list" },
    ...evidence.map((item) => h("li", {},
      h("p", { class: "evidence-title" }, item.title || item.sourceId),
      h("p", { class: "evidence-excerpt" }, item.excerpt || ""),
    ))));
}

// ---------------------------------------------------------------------------
// Loading and growing
// ---------------------------------------------------------------------------

function markTabs() {
  for (const button of document.querySelectorAll(".view-tab")) {
    const on = button.dataset.view === state.view;
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", String(on));
  }
  const title = $("#question-title");
  if (title) title.textContent = state.query;
}

/** Whether the picture is the answer's own, built from what it cited. */
function onOrigin() {
  return MODE === "answer" && state.query === state.origin;
}

function remember() {
  const parameters = new URLSearchParams(location.search);
  if (MODE === "answer") {
    parameters.set("q", state.query);
    if (onOrigin() && state.sources.length) parameters.set("sources", state.sources.join(","));
    else parameters.delete("sources");
  } else {
    parameters.delete("q");
    parameters.set("view", state.view);
  }
  try {
    history.replaceState(null, "", `${location.pathname}?${parameters}`);
  } catch {
    // Not worth failing a draw over.
  }
}

/** Draw a fresh picture: the question's graph, or one overview. */
async function load(view) {
  const generation = ++state.generation;
  state.view = view;
  markTabs();
  remember();
  showError("");
  $("#status-line").textContent = "Loading…";
  try {
    const url = view === "query"
      ? `/api/v1/graph/query?${new URLSearchParams({
          q: state.query,
          // The answer's own graph is seeded from what it cited; re-centred on
          // something else, it is a fresh search.
          ...(onOrigin() && state.sources.length ? { sources: state.sources.join(",") } : {}),
          ...(state.hidden.size ? { categories: enabledCategories().join(",") } : {}),
        })}`
      : `/api/v1/graph/view/${encodeURIComponent(view)}`;
    const slice = await fetchJSON(url);
    if (generation !== state.generation) return;
    state.slice = slice;
    state.start = slice;
    state.centreId = slice.centre ?? null;
    state.positions = new Map();
    state.expanded = new Set();
    state.timeScale = null;
    state.selected = null;
    placeNew(null);
    fit();
    redraw();
    // Re-centred on something else, Back to start returns to the answer.
    $("#restore").disabled = MODE !== "answer" || onOrigin();
    $("#details").replaceChildren(h("p", { class: "empty" },
      view === "query"
        ? "The question is in the middle, and around it what its evidence belongs to. Click anything to open it up."
        : "Click anything to open it up."));
  } catch (error) {
    if (generation !== state.generation) return;
    showError(error instanceof Error ? error.message : String(error));
    $("#status-line").textContent = "Nothing drawn.";
  }
}

/** Re-centre the answer page on something else in it. */
function ask(query) {
  const text = query.trim();
  if (!text) return;
  state.query = text;
  load("query");
}

/** Union of two slices, dropping `removed` (a cluster being replaced by the
 * page it stood for). The existing slice wins on conflict. */
function merge(current, addition, removed = new Set()) {
  const nodes = current.nodes.filter((node) => !removed.has(node.id));
  const seen = new Set(nodes.map((node) => node.id));
  for (const node of addition.nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push(node);
  }
  const key = (edge) => `${edge.source}\u0000${edge.target}\u0000${edge.type}`;
  const edges = current.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target));
  const edgeKeys = new Set(edges.map(key));
  for (const edge of addition.edges) {
    if (edgeKeys.has(key(edge))) continue;
    edgeKeys.add(key(edge));
    edges.push(edge);
  }
  return { ...current, nodes, edges };
}

/** Grow the picture from one node: its neighbours, a few of each kind, placed
 * around it. For a "+N more" item, the next few it stood for replace it. */
async function expand(id) {
  const node = state.slice.nodes.find((candidate) => candidate.id === id);
  if (!node || !expandable(node)) return;
  if (state.slice.nodes.length >= MAX_DRAWN) {
    showError("The picture is as big as it can usefully get. Go back to the start, or ask about something narrower.");
    return;
  }
  const generation = state.generation;
  $("#status-line").textContent = "Loading…";
  try {
    const pager = isPager(node);
    const parameters = new URLSearchParams({ id, budget: String(EXPAND_BUDGET) });
    if (pager) parameters.set("offset", String(node.props.offset ?? 0));
    else if (state.hidden.size) parameters.set("categories", enabledCategories().join(","));
    const addition = await fetchJSON(`/api/v1/graph/expand?${parameters}`);
    if (generation !== state.generation) return;

    // A page replaces the cluster it stood for, and fans out from the node the
    // cluster belonged to — keeping the cluster's own spot for the first one.
    const parentId = pager ? node.props.parent : id;
    const removed = pager ? new Set([id]) : new Set();
    const spot = state.positions.get(id);
    state.slice = merge(state.slice, {
      nodes: addition.nodes,
      edges: addition.edges,
    }, removed);
    // A page's own "+N more" comes back under the same id, and must stay
    // clickable for the page after it; anything else opens up once.
    if (pager) state.positions.delete(id);
    else state.expanded.add(id);
    if (pager && spot && !state.positions.has(parentId)) state.positions.set(parentId, spot);
    placeNew(state.positions.has(parentId) ? parentId : null);
    redraw();
    if (!allInView()) fit();
    select(pager ? parentId : id);
    $("#restore").disabled = false;
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    reportCounts();
  }
}

function activate(id) {
  select(id);
  expand(id);
}

function restore() {
  if (MODE === "answer" && !onOrigin()) {
    state.query = state.origin;
    load("query");
    return;
  }
  if (!state.start) return;
  state.slice = state.start;
  state.positions = new Map();
  state.expanded = new Set();
  state.timeScale = null;
  placeNew(null);
  fit();
  redraw();
  $("#restore").disabled = true;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function buildCategoryChips() {
  const fieldset = $("#categories");
  for (const [key, label] of CATEGORIES) {
    const input = h("input", { type: "checkbox", id: `category-${key}`, value: key, checked: true });
    input.addEventListener("change", () => {
      if (input.checked) state.hidden.delete(key);
      else state.hidden.add(key);
      if (state.slice) redraw();
    });
    fieldset.append(h("label", { class: "chip", for: `category-${key}` }, input, label));
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

/** Drag to pan, wheel to zoom about the pointer. */
function enablePanAndZoom() {
  const canvas = $("#canvas");
  let dragging = null;
  const scale = () => state.viewBox.width / (canvas.clientWidth || state.viewBox.width);
  canvas.addEventListener("pointerdown", (event) => {
    if (event.target.closest?.(".node")) return;
    dragging = { x: event.clientX, y: event.clientY, box: { ...state.viewBox } };
    canvas.classList.add("dragging");
  });
  window.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const factor = scale();
    setViewBox({
      ...dragging.box,
      x: dragging.box.x - (event.clientX - dragging.x) * factor,
      y: dragging.box.y - (event.clientY - dragging.y) * factor,
    });
  });
  window.addEventListener("pointerup", () => {
    dragging = null;
    canvas.classList.remove("dragging");
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const box = state.viewBox;
    const zoom = event.deltaY > 0 ? 1.15 : 1 / 1.15;
    const rect = canvas.getBoundingClientRect();
    const px = rect.width ? (event.clientX - rect.left) / rect.width : 0.5;
    const py = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
    const width = Math.min(Math.max(box.width * zoom, 200), 8000);
    const height = box.height * (width / box.width);
    setViewBox({
      x: box.x + (box.width - width) * px,
      y: box.y + (box.height - height) * py,
      width,
      height,
    });
  }, { passive: false });
}

buildCategoryChips();
enablePanAndZoom();
for (const button of document.querySelectorAll(".view-tab")) {
  button.addEventListener("click", () => load(button.dataset.view));
}
$("#tab-picture").addEventListener("click", () => showTab("picture"));
$("#tab-table").addEventListener("click", () => showTab("table"));
$("#restore").addEventListener("click", restore);
$("#fit").addEventListener("click", fit);

{
  const parameters = new URLSearchParams(location.search);
  const question = (parameters.get("q") ?? "").trim();
  // Inside the chat's dialog, which already shows the question.
  if (parameters.get("embed") === "1") document.body.classList.add("embedded");
  if (MODE === "answer") {
    state.origin = question;
    state.query = question;
    state.sources = (parameters.get("sources") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    if (question) load("query");
    else {
      showError("No question to draw. This page opens from an answer in the chat.");
      $("#status-line").textContent = "Nothing drawn.";
    }
  } else if (question) {
    // Questions have their own page now; an old /graph?q=… link still works.
    location.replace(`/graph/answer?${new URLSearchParams({ q: question })}`);
  } else {
    // /graph?view=… opens on that overview; otherwise on the departments, so
    // the page never opens empty.
    const view = parameters.get("view");
    load(view && view in VIEWS && view !== "query" ? view : "org");
  }
}
