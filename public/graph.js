/**
 * The recorded graph, drawn from Postgres, on two pages that share this
 * script (the page's <body data-mode> says which):
 *   - company (/graph): the company overviews — Departments, Who knows what,
 *     Incidents, Documents, Customers & vendors, Timeline — each from
 *     /api/v1/graph/view/:name, a fixed subgraph that needs no question, plus
 *     Where today touched, from /api/v1/graph/today: the signed-in
 *     employee's own day, drawn around what it cited, with those nodes
 *     highlighted (see state.touched);
 *   - answer (/graph/answer?q=…&sources=…): one chat answer's graph, from
 *     /api/v1/graph/query with the question in the middle and the things its
 *     cited evidence belongs to around it. The chat opens it in a dialog from
 *     the small preview above an answer's evidence.
 * Two overviews are table-shaped data and are drawn as HTML, not a picture:
 * Who knows what is a domain × department matrix, and Incidents is one row per
 * incident, indented under the incident that caused it. Choosing an incident
 * draws its own neighbourhood on the canvas.
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
  // The centre is a "Today" question node like a query graph's, its seeds
  // are what the signed-in employee's day cited, and those seeds are what
  // the picture highlights (see state.touched).
  today: { layout: "radial" },
  // `hub` is the column whose nodes the others are grouped beside; a `free`
  // column is joined to many hub nodes at once (a domain many people know),
  // so it is spread down the side in the order of what it connects to rather
  // than tied to one of them.
  // `about` is the line under the tabs: what the overview answers.
  org: {
    layout: "columns", columns: ["people", "departments", "domains"], hub: "departments",
    about: "Who is in each department, who leads it, and which knowledge domains it holds.",
  },
  // 42 people know 10 domains through 335 edges: as lines that is a grey mass,
  // as a matrix the density is the reading.
  expertise: {
    layout: "matrix",
    about: "How much of each department knows each domain, and who owns it now and before.",
  },
  // Every incident has the same parts (who raised it, who took it, the fix,
  // the write-up), so it is a row, and caused_by nests the rows.
  incidents: {
    layout: "lanes",
    about: "Every incident and what it led to: who raised it, who took it, the fix and the write-up.",
  },
  // The one overview that is a web rather than a table: documents cite each
  // other and share authors and domains, so it is laid out by forces. `fold`
  // drops "Page created" events, each joined only to the page it made: the
  // page already carries its date, and they were a third of the lines.
  documents: {
    layout: "force", fold: ["confluence_created"],
    about: "Pages and design discussions: where each came from, who wrote it, and what it covers.",
  },
  customers: {
    layout: "columns", columns: ["contacts", "partners", "work", "events", "documents"], hub: "partners",
    about: "Each customer and vendor, who we talk to there, and the tickets, invoices and work with them.",
  },
  timeline: {
    layout: "timeline",
    about: "What happened when: incidents, sprints and customer tickets, and everything else by day.",
  },
};

/** Neighbours per category an expansion adds before folding the rest. */
const EXPAND_BUDGET = 5;
/** Past this many items the picture stops being readable; say so instead. */
const MAX_DRAWN = 300;
const COLUMN_GAP = 250;
/** Force layout: how long a line wants to be, and how hard items push apart. */
const LINK_LENGTH = 60;
const CHARGE = 150;
/** How hard the force layout pulls everything toward the middle, so the
 * loose pieces (a page with one author) stay near the rest. */
const GRAVITY = 0.07;
/** With a focus, the rings its neighbours, their neighbours and the rest are
 * pulled to: how far a thing sits from the middle says how far it is from
 * the focus. */
const RINGS = [0, 150, 290, 440];
/** Of an even share of the circle, the least gap kept between two of the
 * focus's neighbours (see spreadFirstRing): enough that no two lines from the
 * focus make a sliver, not so much that the ring looks ruled. */
const SPREAD = 0.7;
/** Drawing units per screen pixel past which captions drop below about 12px
 * (they are capped at 16 units): a column view bigger than that opens at this
 * zoom instead of shrunk to fit, and is read by dragging. */
const READABLE = 1.3;
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
  /** In the Incidents view, the incident whose neighbourhood is drawn instead
   * of the rows; null while the rows show. */
  incident: null,
  positions: new Map(),
  expanded: new Set(),
  hidden: new Set(),
  /** Node ids the "Where today touched" view highlights. Empty on every
   * other view, and never grown by expanding: only what today itself cited
   * is touched, not what an expansion reaches from it. */
  touched: new Set(),
  selected: null,
  evidenceCache: new Map(),
  /** The time scale the timeline was first drawn at, kept so expanding a day
   * places its events on the same axis. */
  timeScale: null,
  viewBox: { x: -420, y: -320, width: 840, height: 640 },
  /** Whether the frame shows only part of the picture, at a readable zoom. */
  zoomedIn: false,
  /** The running force simulation, if any, and the item being dragged in it. */
  simulation: null,
  /** The float of a settled force picture (an animation frame), or null,
   * and when it began. */
  floating: null,
  floatSince: 0,
  pinned: null,
  /** Items dragged and let go in the force layout stay where they were put;
   * the rest settle around them. Cleared with each fresh picture. */
  fixed: new Map(),
  /** Set when a drag of an item ends, so the click that follows is ignored. */
  dragged: false,
  /** Force layout: the item in the middle, lit with what it is joined to, and
   * the items focused on before it, for the trail. */
  focus: null,
  trail: [],
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
    // Through the CSSOM: the page's CSP (style-src 'self') refuses a style
    // attribute written as markup.
    else if (key === "style") element.style.cssText = value;
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

/** Whether today's evidence touched this node (see state.touched). The
 * question at the centre is never marked, even on the "Today" question. */
function isTouched(node) {
  return node.type !== "query" && node.type !== "cluster" && state.touched.has(node.id);
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

/** How the current picture is laid out: a chosen incident is drawn around
 * itself, whatever its view does otherwise. */
function layoutOf() {
  return state.incident ? "radial" : VIEWS[state.view].layout;
}

/** Steps from the focus to each drawn item along drawn lines (unreached
 * items are left out). Empty without a focus. */
function stepsFromFocus() {
  const steps = new Map();
  if (!state.focus) return steps;
  const shown = new Set(visibleNodes().map((node) => node.id));
  if (!shown.has(state.focus)) return steps;
  const next = new Map();
  for (const edge of state.slice.edges) {
    if (!shown.has(edge.source) || !shown.has(edge.target)) continue;
    if (!next.has(edge.source)) next.set(edge.source, []);
    if (!next.has(edge.target)) next.set(edge.target, []);
    next.get(edge.source).push(edge.target);
    next.get(edge.target).push(edge.source);
  }
  steps.set(state.focus, 0);
  let frontier = [state.focus];
  while (frontier.length) {
    const after = [];
    for (const id of frontier) {
      for (const other of next.get(id) ?? []) {
        if (steps.has(other)) continue;
        steps.set(other, steps.get(id) + 1);
        after.push(other);
      }
    }
    frontier = after;
  }
  return steps;
}

/** Where the force view opens: the most connected item, a domain first on a
 * tie, since a topic is the most natural thing to start a story from. */
function defaultFocus() {
  const shown = new Set(visibleNodes().map((node) => node.id));
  const degree = new Map();
  for (const edge of state.slice.edges) {
    if (!shown.has(edge.source) || !shown.has(edge.target)) continue;
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const [best] = visibleNodes()
    .filter((node) => degree.has(node.id))
    .sort((left, right) =>
      degree.get(right.id) - degree.get(left.id) ||
      Number(right.subtype === "domain") - Number(left.subtype === "domain") ||
      nameOf(left).localeCompare(nameOf(right)));
  return best?.id ?? null;
}

/** A slice without the kinds of node the current view folds away. */
function folded(slice) {
  const fold = VIEWS[state.view].fold;
  if (!fold) return slice;
  const dropped = new Set(slice.nodes.filter((node) => fold.includes(node.subtype)).map((node) => node.id));
  return {
    ...slice,
    nodes: slice.nodes.filter((node) => !dropped.has(node.id)),
    edges: slice.edges.filter((edge) => !dropped.has(edge.source) && !dropped.has(edge.target)),
  };
}

/** Whether the view is HTML (matrix or rows) rather than the canvas. */
function arranged() {
  const layout = layoutOf();
  return layout === "matrix" || layout === "lanes";
}

/**
 * Relationships drawn in their own way, with what the legend calls them. The
 * rest are thin grey lines. formerly_owned is not stored: it is an owns_domain
 * edge from the person the domain names as its former owner.
 */
const EDGE_STYLES = {
  member_of: "Member",
  leads: "Leads",
  belongs_to: "Domain of a department",
  owns_domain: "Owns now",
  formerly_owned: "Owned before",
  caused_by: "Caused by",
};

function edgeKind(edge, byId) {
  if (edge.type !== "owns_domain") return edge.type;
  const person = byId.get(edge.source);
  const domain = byId.get(edge.target);
  const name = person && naturalKey(person);
  return domain?.props?.former_owner === name && domain?.props?.primary_owner !== name
    ? "formerly_owned"
    : "owns_domain";
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

  // Rows per sub-column. A big view opens zoomed in and is read by dragging
  // (see READABLE), so height is cheap; side-by-side sub-columns are not,
  // since their captions run into each other. A group stays one column up to
  // this many.
  const wrap = 10;
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

/**
 * A starting spot for each unplaced node, on a sunflower spiral so no two
 * start on top of each other; the forces move them from there. Deterministic,
 * so the same data settles the same way.
 */
function spiralLayout(nodes) {
  const fresh = nodes.filter((node) => !state.positions.has(node.id));
  fresh.forEach((node, index) => {
    const radius = 22 * Math.sqrt(index + 0.5);
    const angle = index * Math.PI * (3 - Math.sqrt(5));
    state.positions.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  });
}

/**
 * Forces, in the manner of d3-force: every pair of items pushes apart, every
 * line pulls its ends toward LINK_LENGTH, and a weak pull keeps the whole near
 * the middle. The heat (`alpha`) cools each tick until nothing moves. The
 * first `warm` ticks run at once, so the picture opens nearly settled and is
 * seen easing into place; `warmed` runs after them (to frame the picture).
 * With no animation frames (or reduced motion) it settles at once. `done`
 * runs when it has settled.
 *
 * Once settled, the forces stop and the picture floats (see float). The
 * camera follows (with `follow`) only while things are still moving into
 * place, so it never fights someone panning.
 */
function simulate({ alpha = 1, warm = 0, warmed = null, done = null, follow = false } = {}) {
  stopSimulation();
  stopFloating();
  const nodes = visibleNodes().filter((node) => state.positions.has(node.id));
  const index = new Map(nodes.map((node, at) => [node.id, at]));
  const links = state.slice.edges.filter((edge) => index.has(edge.source) && index.has(edge.target));
  const degree = new Map();
  for (const edge of links) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const velocity = nodes.map(() => ({ x: 0, y: 0 }));
  const point = (node) => state.positions.get(node.id);
  // With a focus, each item is pulled to its ring (see RINGS), and the
  // middle is where the focus is, not where the whole picture's weight is.
  const steps = stepsFromFocus();
  const ring = (node) => RINGS[Math.min(steps.get(node.id) ?? RINGS.length - 1, RINGS.length - 1)];
  const decay = 1 - Math.pow(0.001, 1 / 220);
  // The focus's neighbours spread round it: two that sit closer than
  // SPREAD of an even share are pushed apart along the ring. Only a floor, not
  // even spacing: gaps above it are left as the lines made them, which reads
  // as natural rather than as a clock face.
  const firstRing = nodes.map((node, at) => ({ node, at })).filter(({ node }) => steps.get(node.id) === 1);
  const spreadFirstRing = () => {
    if (firstRing.length < 2) return;
    const centre = state.positions.get(state.focus);
    const floor = ((Math.PI * 2) / firstRing.length) * SPREAD;
    // A few passes of a constraint rather than a force: whatever the lines and
    // the other items pull, no two neighbours end a step closer than the floor.
    for (let pass = 0; pass < 3; pass += 1) {
      const around = firstRing
        .map((entry) => {
          const p = point(entry.node);
          return { ...entry, angle: Math.atan2(p.y - centre.y, p.x - centre.x), radius: Math.hypot(p.x - centre.x, p.y - centre.y) || 1 };
        })
        .sort((a, b) => a.angle - b.angle);
      let moved = false;
      around.forEach((entry, i) => {
        const next = around[(i + 1) % around.length];
        const gap = (i + 1 < around.length ? next.angle : next.angle + Math.PI * 2) - entry.angle;
        const short = floor - gap;
        if (short <= 0) return;
        moved = true;
        // Each turns half the shortfall, away from the other, at its own radius.
        entry.angle -= short / 2;
        next.angle += short / 2;
      });
      if (!moved) break;
      for (const entry of around) {
        if (state.pinned?.id === entry.node.id || state.fixed.get(entry.node.id)) continue;
        state.positions.set(entry.node.id, {
          x: centre.x + Math.cos(entry.angle) * entry.radius,
          y: centre.y + Math.sin(entry.angle) * entry.radius,
        });
      }
    }
  };

  const tick = () => {
    for (let i = 0; i < nodes.length; i += 1) {
      const a = point(nodes[i]);
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = point(nodes[j]);
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance2 = dx * dx + dy * dy;
        if (distance2 < 1) { dx = (i - j) * 0.5 || 0.5; dy = 0.5; distance2 = dx * dx + dy * dy; }
        const push = (CHARGE * alpha) / distance2;
        velocity[i].x -= dx * push; velocity[i].y -= dy * push;
        velocity[j].x += dx * push; velocity[j].y += dy * push;
      }
    }
    for (const edge of links) {
      const i = index.get(edge.source);
      const j = index.get(edge.target);
      const a = point(nodes[i]);
      const b = point(nodes[j]);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      // Softer for well-connected ends, so a hub is not yanked by every line;
      // softer still between two of the focus's neighbours, which would
      // otherwise pull each other into a sliver beside the focus.
      const siblings = steps.get(edge.source) === 1 && steps.get(edge.target) === 1;
      const strength = (siblings ? 0.2 : 1) / Math.min(degree.get(edge.source), degree.get(edge.target));
      const pull = ((distance - LINK_LENGTH) / distance) * alpha * strength * 0.5;
      velocity[i].x += dx * pull; velocity[i].y += dy * pull;
      velocity[j].x -= dx * pull; velocity[j].y -= dy * pull;
    }
    if (steps.size) spreadFirstRing();
    nodes.forEach((node, at) => {
      const p = point(node);
      if (steps.size) {
        // Rings are measured from where the focus is now, and the focus is
        // drawn to the middle; both stronger than the lines' pull, which
        // would drag the first ring in to LINK_LENGTH and crowd the focus.
        const centre = state.positions.get(state.focus);
        const dx = p.x - centre.x;
        const dy = p.y - centre.y;
        const radius = Math.hypot(dx, dy) || 1;
        if (node.id === state.focus) {
          velocity[at].x -= p.x * 0.35 * alpha;
          velocity[at].y -= p.y * 0.35 * alpha;
        } else {
          const toward = ((ring(node) - radius) / radius) * 0.35 * alpha;
          velocity[at].x += dx * toward;
          velocity[at].y += dy * toward;
        }
      } else {
        velocity[at].x -= p.x * GRAVITY * alpha;
        velocity[at].y -= p.y * GRAVITY * alpha;
      }
      const held = state.pinned?.id === node.id ? state.pinned : state.fixed.get(node.id);
      if (held) {
        velocity[at] = { x: 0, y: 0 };
        state.positions.set(node.id, { x: held.x, y: held.y });
        return;
      }
      velocity[at].x *= 0.6;
      velocity[at].y *= 0.6;
      state.positions.set(node.id, { x: p.x + velocity[at].x, y: p.y + velocity[at].y });
    });
    alpha *= 1 - decay;
  };
  for (let count = 0; count < warm && alpha > 0.005; count += 1) tick();
  moveDrawn();
  warmed?.();
  const animate = typeof requestAnimationFrame === "function" &&
    !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!animate) {
    while (alpha > 0.005) tick();
    moveDrawn();
    if (follow) frameFocus(1);
    done?.();
    return;
  }
  const frame = () => {
    tick();
    moveDrawn();
    if (follow && alpha > 0.03) frameFocus(0.12);
    // A dragged item keeps the picture warm until it is let go.
    if (state.pinned) alpha = Math.max(alpha, 0.1);
    if (alpha > 0.005) {
      state.simulation = requestAnimationFrame(frame);
      return;
    }
    state.simulation = null;
    done?.();
    if (layoutOf() === "force") startFloating();
  };
  state.simulation = requestAnimationFrame(frame);
}

/**
 * Move the frame toward the focus and its ring of neighbours, `ease` of the
 * way there (1 jumps): called every frame while the picture moves, it reads
 * as the camera following.
 */
function frameFocus(ease = 1) {
  const steps = stepsFromFocus();
  // The focus and two rings around it: enough to read a story, with the
  // rest of the web showing round the edges.
  const points = [...steps].filter(([, step]) => step <= 2)
    .map(([id]) => state.positions.get(id)).filter(Boolean);
  if (points.length === 0) return;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const canvas = $("#canvas");
  const aspect = (canvas.clientWidth || 4) / (canvas.clientHeight || 3);
  let width = Math.max(Math.max(...xs) - Math.min(...xs) + 220, 640);
  let height = Math.max(Math.max(...ys) - Math.min(...ys) + 120, width / aspect);
  width = Math.max(width, height * aspect);
  const target = {
    x: (Math.min(...xs) + Math.max(...xs)) / 2 - width / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2 - height / 2,
    width,
    height,
  };
  const box = state.viewBox;
  const mix = (from, to) => from + (to - from) * ease;
  setViewBox({
    x: mix(box.x, target.x), y: mix(box.y, target.y),
    width: mix(box.width, target.width), height: mix(box.height, target.height),
  });
}

/** Put `id` in the middle: it and what it is joined to light up, the rest
 * falls back, and the camera follows as the picture rearranges. */
function focusOn(id, { fromTrail = false } = {}) {
  if (!fromTrail) {
    const at = state.trail.indexOf(id);
    state.trail = at >= 0 ? state.trail.slice(0, at + 1) : [...state.trail, id];
  }
  state.focus = id;
  // A dropped item would hold the new focus off centre.
  state.fixed = new Map();
  redraw();
  select(id);
  simulate({ alpha: 0.8, follow: true, done: declutter });
  $("#restore").disabled = false;
}

/** The items focused on so far, oldest first; each takes you back there. */
function drawTrail() {
  const trail = $("#trail");
  if (!trail) return;
  const byId = new Map(state.slice.nodes.map((node) => [node.id, node]));
  const steps = state.trail.filter((id) => byId.has(id));
  trail.hidden = layoutOf() !== "force" || steps.length === 0;
  trail.replaceChildren(...steps.flatMap((id, at) => [
    at ? h("span", { class: "trail-step", "aria-hidden": "true" }, "→") : null,
    at === steps.length - 1
      ? h("span", { class: "trail-here", "aria-current": "true" }, shortLabel(byId.get(id), 28))
      : h("button", { type: "button", onclick: () => {
          state.trail = steps.slice(0, at + 1);
          focusOn(id, { fromTrail: true });
        } }, shortLabel(byId.get(id), 28)),
  ].filter(Boolean)));
}

/**
 * The settled force picture floats: every item sways on a slow sine, its
 * phase taken from where it is, so neighbours sway together and the lines
 * between them keep their shape while the whole web gently breathes. It is
 * drawn on top of the settled positions (see shownAt) and never changes
 * them, so clicking, dragging and framing see a still picture.
 */
function startFloating() {
  stopFloating();
  if (typeof requestAnimationFrame !== "function" ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const frame = () => {
    if (layoutOf() !== "force") {
      stopFloating();
      return;
    }
    moveDrawn();
    state.floating = requestAnimationFrame(frame);
  };
  state.floatSince = performance.now();
  state.floating = requestAnimationFrame(frame);
}

function stopFloating() {
  if (state.floating && typeof cancelAnimationFrame === "function") cancelAnimationFrame(state.floating);
  state.floating = null;
}

/** Where an item is drawn: its place, plus the float while floating. */
function shownAt(id) {
  const p = state.positions.get(id);
  if (!p || !state.floating) return p;
  const time = performance.now();
  const phase = p.x * 0.003 + p.y * 0.0022;
  // Eased in over a second and a half, so settling into the float is not a jump.
  const size = 7 * Math.min((time - state.floatSince) / 1500, 1);
  return {
    x: p.x + Math.sin(time * 0.0007 + phase) * size,
    y: p.y + Math.cos(time * 0.00055 + phase * 1.4) * size,
  };
}

function stopSimulation() {
  if (state.simulation && typeof cancelAnimationFrame === "function") cancelAnimationFrame(state.simulation);
  state.simulation = null;
}

/** Put what is drawn where state.positions says, without redrawing it. */
function moveDrawn() {
  const canvas = $("#canvas");
  for (const group of canvas.querySelectorAll(".node")) {
    const p = shownAt(group.dataset.id);
    if (p) group.setAttribute("transform", `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
  }
  for (const element of canvas.querySelectorAll("[data-source]")) {
    const a = shownAt(element.dataset.source);
    const b = shownAt(element.dataset.target);
    if (!a || !b) continue;
    if (element.tagName === "path") {
      element.setAttribute("d", curvePath(a, b, element.classList.contains("near")));
    } else if (element.tagName === "line") {
      element.setAttribute("x1", a.x); element.setAttribute("y1", a.y);
      element.setAttribute("x2", b.x); element.setAttribute("y2", b.y);
    } else if (element.tagName === "polygon") {
      element.setAttribute("points", arrowPoints(a, b, Number(element.dataset.gap ?? 11)));
    } else if (element.tagName === "circle") {
      const bead = beadPoint(a, b, Number(element.dataset.gap ?? 11));
      element.setAttribute("cx", bead.x); element.setAttribute("cy", bead.y);
    } else {
      const chosen = element.dataset.along ? Number(element.dataset.along) : null;
      const at = labelPoint(a, b, element.dataset.source, element.dataset.target, chosen);
      element.setAttribute("x", at.x); element.setAttribute("y", at.y);
    }
  }
}

/**
 * In the force layout the lit lines (the story round the focus) are straight
 * and the background ones are gentle arcs, every arc bowing away from the
 * focus: the background curves round the story instead of cutting through
 * it, and no two arcs bend at random against each other. The control point
 * of the curve from `a` to `b`:
 */
function bend(a, b) {
  const centre = (state.focus && state.positions.get(state.focus)) || { x: 0, y: 0 };
  const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const nx = -(b.y - a.y);
  const ny = b.x - a.x;
  // How far the line runs round the focus rather than toward it: +1 for a
  // line square across the way out, 0 for one pointing at the focus. The bow
  // follows it smoothly, so a line never flips from one side to the other.
  const ox = middle.x - centre.x;
  const oy = middle.y - centre.y;
  const across = (nx * ox + ny * oy) / ((Math.hypot(nx, ny) * Math.hypot(ox, oy)) || 1);
  return { x: middle.x + nx * 0.18 * across, y: middle.y + ny * 0.18 * across };
}

function curvePath(a, b, straight = false) {
  const c = straight ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : bend(a, b);
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${c.x.toFixed(1)},${c.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}

/** Where a line's name goes: its middle, or on a line from the focus, most
 * of the way out, so the names of several lines do not crowd the focus.
 * (Named lines are straight.) */
function labelPoint(a, b, source, target, chosen = null) {
  let along = chosen ?? (source === state.focus || target === state.focus ? 0.62 : 0.5);
  if (target === state.focus) along = 1 - along;
  return { x: a.x + (b.x - a.x) * along, y: a.y + (b.y - a.y) * along };
}

/**
 * Keep words from printing over each other. Captions and line names are
 * placed most important first — the focus, its neighbours, the names of the
 * story lines, then the outer rings — each where it goes by default if that
 * is clear of everything placed before it (words and shapes alike), else in
 * the first clear spot of a few: a caption above, right or left of its item,
 * a line's name further along its line. A word with no clear spot is hidden
 * until its item is hovered. Run once a picture has settled (and after
 * zooming), since what collides depends on the zoom.
 */
function declutter() {
  const canvas = $("#canvas");
  if (!["force", "radial"].includes(layoutOf())) return;
  // Measuring needs layout (jsdom has none).
  if (typeof SVGGraphicsElement === "undefined" || typeof SVGGraphicsElement.prototype.getBBox !== "function") return;
  const groups = [...canvas.querySelectorAll(".node")];
  const at = (id) => shownAt(id) ?? { x: 0, y: 0 };
  const boxOf = (element, origin) => {
    let box;
    try { box = element.getBBox(); } catch { return null; }
    if (!box.width) return null;
    const pad = 2;
    return { x: box.x + origin.x - pad, y: box.y + origin.y - pad, w: box.width + pad * 2, h: box.height + pad * 2 };
  };
  const placed = [];
  const clear = (box) => !placed.some((other) =>
    box.x < other.x + other.w && other.x < box.x + box.w && box.y < other.y + other.h && other.y < box.y + box.h);
  // Shapes first: a word may not sit on an item.
  for (const group of groups) {
    const box = boxOf(group.querySelector(".shape"), at(group.dataset.id));
    if (box) placed.push(box);
  }
  const visible = (element) => getComputedStyle(element).opacity !== "0" &&
    getComputedStyle(element.closest(".node") ?? element).opacity !== "0";
  const rank = (element) => {
    const group = element.closest(".node");
    if (!group) return 2.5;
    if (group.classList.contains("the-focus")) return 0;
    if (group.classList.contains("near")) return 1;
    if (group.classList.contains("mid")) return 3;
    return group.classList.contains("far") ? 4 : 2;
  };
  const words = [...canvas.querySelectorAll(".node .caption, .edge-label")];
  for (const word of words) {
    word.classList.remove("crowded");
    if (word.classList.contains("edge-label")) delete word.dataset.along;
  }
  words.sort((left, right) => rank(left) - rank(right));
  for (const word of words) {
    if (!word.textContent || !visible(word)) continue;
    if (word.classList.contains("edge-label")) {
      const a = at(word.dataset.source);
      const b = at(word.dataset.target);
      const base = word.dataset.source === state.focus || word.dataset.target === state.focus ? 0.62 : 0.5;
      const spot = [base, 0.4, 0.75, 0.3, 0.85].find((along) => {
        const point = labelPoint(a, b, word.dataset.source, word.dataset.target, along);
        word.setAttribute("x", point.x);
        word.setAttribute("y", point.y);
        const box = boxOf(word, { x: 0, y: 0 });
        if (!box || !clear(box)) return false;
        placed.push(box);
        word.dataset.along = String(along);
        return true;
      });
      if (spot === undefined) word.classList.add("crowded");
      continue;
    }
    const group = word.closest(".node");
    const origin = at(group.dataset.id);
    const reach = Math.abs(Number(word.dataset.below ?? word.getAttribute("y") ?? 20));
    word.dataset.below ??= word.getAttribute("y") ?? "20";
    const spots = [
      { x: 0, y: reach, anchor: "middle", baseline: "hanging" },
      { x: 0, y: -reach, anchor: "middle", baseline: "auto" },
      { x: reach, y: 0, anchor: "start", baseline: "middle" },
      { x: -reach, y: 0, anchor: "end", baseline: "middle" },
    ];
    const spot = spots.find((candidate) => {
      word.setAttribute("x", candidate.x);
      word.setAttribute("y", candidate.y);
      // Inline, since graph.css sets both and outranks attributes.
      word.style.setProperty("text-anchor", candidate.anchor);
      word.style.setProperty("dominant-baseline", candidate.baseline);
      const box = boxOf(word, origin);
      if (!box || !clear(box)) return false;
      placed.push(box);
      return true;
    });
    if (!spot) {
      const [first] = spots;
      word.setAttribute("x", first.x);
      word.setAttribute("y", first.y);
      word.style.setProperty("text-anchor", first.anchor);
      word.style.setProperty("dominant-baseline", first.baseline);
      word.classList.add("crowded");
    }
  }
}

/** The point `gap` short of `b`, on the line from `a`: where a line's bead sits. */
function beadPoint(a, b, gap) {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: b.x - ((b.x - a.x) / length) * gap, y: b.y - ((b.y - a.y) / length) * gap };
}

/** An arrowhead `gap` short of `b`, on the line from `a`. */
function arrowPoints(a, b, gap = 11) {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  const tip = { x: b.x - ux * gap, y: b.y - uy * gap };
  const back = { x: tip.x - ux * 8, y: tip.y - uy * 8 };
  return `${tip.x},${tip.y} ${back.x - uy * 4},${back.y + ux * 4} ${back.x + uy * 4},${back.y - ux * 4}`;
}

/** Place whatever has no position yet, the way the current view lays out. */
function placeNew(parentId) {
  if (arranged()) return;
  const nodes = state.slice.nodes;
  const layout = layoutOf();
  if (layout === "timeline") timelineLayout(nodes);
  else if (layout === "force" && !parentId) spiralLayout(nodes);
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

/** Shapes at `size` 1 fit the dense layouts (columns, timeline, the documents web);
 * a question's radial picture draws them half as large again, so each one reads at a glance. */
function shapeFor(node, size = 1) {
  if (node.id.startsWith("day:") && layoutOf() === "timeline") return timelineShape(node);
  const incident = node.isIncident ? " incident" : "";
  const touched = isTouched(node) ? " touched" : "";
  const k = (value) => +(value * size).toFixed(1);
  // Soft corners throughout, like the rest of the page: every point is rounded off.
  const rounded = (pairs, radius) => svg("path", { d: roundedPath(pairs.map(([x, y]) => [k(x), k(y)]), k(radius)) });
  const shaped = (element, kind) => {
    element.setAttribute("class", `shape ${kind}${incident}${touched}`);
    return element;
  };
  switch (node.type) {
    case "person":
      return shaped(rounded([[0, -7.5], [7.5, 0], [0, 7.5], [-7.5, 0]], 2.2), "n-person");
    case "organization":
      return shaped(rounded([[-4, -7], [4, -7], [7.5, 0], [4, 7], [-4, 7], [-7.5, 0]], 1.8), "n-organization");
    case "item":
      return svg("circle", { r: k(7), class: `shape n-item${incident}${touched}` });
    case "event":
      return svg("rect", { x: k(-6), y: k(-6), width: k(12), height: k(12), rx: k(3), class: `shape n-event${incident}${touched}` });
    case "document":
      // Equilateral, its centre on the item's centre: three points on a circle of radius 8.
      return shaped(rounded([[0, -8], [6.93, 4], [-6.93, 4]], 2.2), "n-document");
    case "query":
      return svg("circle", { r: 11, class: "shape n-query" });
    case "cluster":
      return svg("circle", { r: k(8), class: "shape n-cluster" });
    default:
      return svg("circle", { r: k(7), class: "shape n-item" });
  }
}

/**
 * A closed path through `points` with each corner rounded off by `radius`: the
 * line stops short of the corner and curves round it (a quadratic through the
 * corner itself), so a triangle or a diamond keeps its shape but loses its point.
 */
function roundedPath(points, radius) {
  const n = points.length;
  const toward = (from, to, distance) => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
    const d = Math.min(distance, length / 2);
    return [from[0] + ((to[0] - from[0]) / length) * d, from[1] + ((to[1] - from[1]) / length) * d];
  };
  const parts = [];
  for (let i = 0; i < n; i++) {
    const corner = points[i];
    const before = toward(corner, points[(i - 1 + n) % n], radius);
    const after = toward(corner, points[(i + 1) % n], radius);
    parts.push(`${i === 0 ? "M" : "L"}${before[0].toFixed(2)},${before[1].toFixed(2)}`,
      `Q${corner[0].toFixed(2)},${corner[1].toFixed(2)} ${after[0].toFixed(2)},${after[1].toFixed(2)}`);
  }
  return `${parts.join(" ")} Z`;
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
  const canvas = $("#canvas");
  canvas.setAttribute(
    "viewBox",
    `${box.x.toFixed(1)} ${box.y.toFixed(1)} ${box.width.toFixed(1)} ${box.height.toFixed(1)}`,
  );
  // Drawing units per screen pixel. graph.css sizes captions by it, so a
  // caption stays about 12px on screen however far the picture is zoomed out
  // (up to a cap, past which neighbouring captions would collide).
  const scale = Math.max(
    box.width / (canvas.clientWidth || box.width),
    box.height / (canvas.clientHeight || box.height),
  );
  canvas.style.setProperty("--px", scale.toFixed(3));
}

/** Whether everything drawn (or just `nodes`) is inside the current frame. */
function allInView(nodes = visibleNodes()) {
  const box = state.viewBox;
  return nodes.every((node) => {
    const point = state.positions.get(node.id);
    return !point || (point.x >= box.x && point.x <= box.x + box.width &&
      point.y >= box.y && point.y <= box.y + box.height);
  });
}

/**
 * Frame everything drawn, with room for captions. With `readable`, a picture
 * too big to read at that size is framed at the READABLE zoom instead: from
 * its top left, or centred on `around`. Fit (the button) always shows it all.
 */
function fit({ readable = false, around = null } = {}) {
  const points = visibleNodes().map((node) => state.positions.get(node.id)).filter(Boolean);
  if (points.length === 0) return;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  // Column views caption on either side of a node; the others below it.
  const left = Math.min(...xs) - (layoutOf() === "columns" ? 170 : 60);
  const right = Math.max(...xs) + (["radial", "force"].includes(layoutOf()) ? 60 : 170);
  const top = Math.min(...ys) - 40;
  const bottom = Math.max(...ys) + 40;
  const width = Math.max(right - left, 480);
  const height = Math.max(bottom - top, 360);
  const canvas = $("#canvas");
  const [screenWidth, screenHeight] = [canvas.clientWidth, canvas.clientHeight];
  state.zoomedIn = readable && screenWidth > 0 && screenHeight > 0 &&
    Math.max(width / screenWidth, height / screenHeight) > READABLE;
  if (state.slice) reportCounts();
  if (state.zoomedIn) {
    const frame = { width: screenWidth * READABLE, height: screenHeight * READABLE };
    const centre = around && state.positions.get(around);
    setViewBox(centre
      ? { ...frame, x: centre.x - frame.width / 2, y: centre.y - frame.height / 2 }
      : { ...frame, x: left, y: top });
    return;
  }
  setViewBox({
    x: (left + right) / 2 - width / 2,
    y: (top + bottom) / 2 - height / 2,
    width,
    height,
  });
}

function drawLaneLabels(layer) {
  if (layoutOf() !== "timeline" || !state.timeScale) return;
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
  // Nothing redrawn is lit, so nothing may stay faded behind it.
  canvas.classList.remove("focus");

  const nodes = visibleNodes();
  const shown = new Set(nodes.map((node) => node.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sideCaptions = layoutOf() === "columns";
  const timeline = layoutOf() === "timeline";
  // Timeline nodes in time order, so alternating captions alternate between
  // neighbours on the axis.
  const laneCount = new Map();
  if (timeline) nodes.sort((left, right) => (timeOf(left) ?? 0) - (timeOf(right) ?? 0));

  const lanes = svg("g");
  drawLaneLabels(lanes);

  const drawn = state.slice.edges.filter((edge) => shown.has(edge.source) && shown.has(edge.target) &&
    state.positions.has(edge.source) && state.positions.has(edge.target));
  // A small picture (one incident, one answer) says on each line what it
  // means; in a big one the words would bury the lines.
  const labelled = layoutOf() === "radial" && drawn.length <= 40;
  // In the force layout with a focus, the focus's own lines are named, and
  // everything is lit by how near it is to the focus.
  const steps = layoutOf() === "force" ? stepsFromFocus() : new Map();
  const nearness = (id) => {
    const step = steps.get(id);
    return step === undefined ? "far" : step <= 1 ? "near" : step === 2 ? "mid" : "far";
  };
  canvas.classList.toggle("focusing", steps.size > 0);
  const degree = new Map();
  for (const edge of drawn) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  // Force layout: an item's shape grows with its lines (and up to 1.6 with
  // the zoom, see graph.css); arrowheads and captions keep clear of it.
  const reach = (id) => 7 * (1 + Math.min(degree.get(id) ?? 0, 8) * 0.1) * 1.6;
  // A story line joins two lit items (the focus and its neighbours), so the
  // neighbours' own links (an incident that produced a write-up) are read as
  // clearly as their links to the focus. A relation the focus has three or
  // more lines of is named once, under the focus, not on every line.
  const story = (edge) => nearness(edge.source) === "near" && nearness(edge.target) === "near";
  const repeated = new Map();
  for (const edge of drawn) {
    if (!steps.size || (edge.source !== state.focus && edge.target !== state.focus)) continue;
    const kind = edgeKind(edge, byId);
    repeated.set(kind, (repeated.get(kind) ?? 0) + 1);
  }
  for (const [kind, count] of repeated) if (count < 3) repeated.delete(kind);
  const edgeLayer = svg("g");
  const labelLayer = svg("g");
  for (const edge of drawn) {
    const a = state.positions.get(edge.source);
    const b = state.positions.get(edge.target);
    const kind = edgeKind(edge, byId);
    const ends = { "data-source": edge.source, "data-target": edge.target };
    const touches = steps.size > 0 && (edge.source === state.focus || edge.target === state.focus);
    const lit = steps.size ? (story(edge) ? " near" : nearness(edge.source) === "far" || nearness(edge.target) === "far" ? " far" : " mid") : "";
    const edgeClass = `edge ${edge.type} ${kind}${lit}`;
    const line = layoutOf() === "force"
      ? svg("path", { d: curvePath(a, b, lit === " near"), class: edgeClass, ...ends })
      : svg("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: edgeClass, ...ends });
    line.append(Object.assign(svg("title"), {
      textContent: `${nameOf(byId.get(edge.source))} — ${kind.replace(/_/g, " ")} → ${nameOf(byId.get(edge.target))}`,
    }));
    edgeLayer.append(line);
    // One incident caused by another is the chain a reader follows: an
    // arrowhead just short of the earlier incident.
    if (edge.type === "caused_by") {
      edgeLayer.append(svg("polygon", { points: arrowPoints(a, b), class: "edge-arrow", ...ends }));
    } else if (lit === " near") {
      // A story line says which way it reads: a soft bead just short of the
      // page an incident produced, of the domain a page is about. Round, not a
      // point: the web floats, and a spike would read as sharp against it.
      const gap = (reach(edge.target) + 5).toFixed(1);
      const bead = beadPoint(a, b, Number(gap));
      edgeLayer.append(svg("circle", {
        cx: bead.x, cy: bead.y, r: 3.2, class: "edge-arrow story", "data-gap": gap, ...ends,
      }));
    }
    // "matches" only says the question found it, which its place already says.
    // A label whose spot falls on a node (a line passing through it) is left
    // out rather than printed over the node.
    const middle = labelPoint(a, b, edge.source, edge.target);
    // (Force layout items keep moving, so there it is not judged.)
    const onNode = layoutOf() !== "force" && nodes.some((other) => {
      const point = state.positions.get(other.id);
      return point && Math.hypot(point.x - middle.x, point.y - middle.y) < 24;
    });
    const named = labelled || (lit === " near" && !(touches && repeated.has(kind)));
    if (named && edge.type !== "matches" && !onNode) {
      labelLayer.append(Object.assign(
        svg("text", { x: middle.x, y: middle.y, class: "edge-label", ...ends }),
        { textContent: kind.replace(/_/g, " ") },
      ));
    }
  }
  const leads = new Set(drawn.filter((edge) => edge.type === "leads").map((edge) => edge.source));
  // In the force layout an item is as big as it is connected, and only the
  // well-connected ones (and people and domains) are captioned until hovered.
  const force = layoutOf() === "force";
  canvas.classList.toggle("force", force);
  const minor = (node) => force && node.type !== "person" && node.subtype !== "domain" &&
    (degree.get(node.id) ?? 0) < 4;
  // In columns, a caption goes on the side its lines do not: people left of
  // their department are captioned on the left, so their lines never cross
  // their own names.
  const pull = new Map();
  for (const edge of drawn) {
    const dx = state.positions.get(edge.target).x - state.positions.get(edge.source).x;
    pull.set(edge.source, (pull.get(edge.source) ?? 0) + dx);
    pull.set(edge.target, (pull.get(edge.target) ?? 0) - dx);
  }

  const nodeLayer = svg("g");
  for (const node of nodes) {
    const point = state.positions.get(node.id);
    if (!point) continue;
    // tabindex makes each node a stop, so the diagram is walkable without a
    // pointer; the label says what it is and whether it opens up.
    const group = svg("g", {
      class: `node kind-${node.type}${state.expanded.has(node.id) ? " expanded" : ""}${leads.has(node.id) ? " lead" : ""}${minor(node) ? " minor" : ""}${steps.size ? ` ${nearness(node.id)}` : ""}${node.id === state.focus && steps.size ? " the-focus" : ""}`,
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
      const left = (pull.get(node.id) ?? 0) > 0;
      caption = svg("text", { x: left ? -12 : 12, y: 3, class: `caption side${left ? " left" : ""}` });
      // 28 characters at the 16-unit cap fit the COLUMN_GAP to the next column.
      caption.textContent = shortLabel(node, 28) + (leads.has(node.id) ? " · lead" : "");
    } else if (node.type === "query") {
      // The question's pill carries its words.
      caption = null;
    } else if (state.incident && (node.type === "event" || node.type === "document" ||
      (node.type === "item" && node.subtype !== "domain"))) {
      // Around one incident, tickets, write-ups and fixes go by their keys, as
      // in the rows; the full title is in the details.
      caption = svg("text", { y: 20, class: `caption${node.id === state.incident ? " strong" : ""}` });
      caption.textContent = naturalKey(node);
    } else if (force) {
      // Hung below the shape, which grows with its lines (and a little with
      // the zoom, up to 1.6 in graph.css), so the caption never covers it.
      caption = svg("text", { y: (reach(node.id) + 3).toFixed(1), class: "caption hang" });
      caption.textContent = shortLabel(node, 24);
      if (node.id === state.focus && repeated.size) {
        // The relation named once instead of on each of its lines.
        caption.append(Object.assign(svg("tspan", { x: 0, dy: "1.25em", class: "caption-note" }), {
          textContent: [...repeated].map(([kind, count]) => `${count} × ${kind.replace(/_/g, " ")}`).join(" · "),
        }));
      }
    } else {
      caption = svg("text", { y: 27, class: "caption label" });
      caption.textContent = shortLabel(node, 26);
    }
    const radial = !timeline && !sideCaptions && !force;
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
    if (force) group.style.setProperty("--grow", (1 + Math.min(degree.get(node.id) ?? 0, 8) * 0.1).toFixed(2));
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      // The end of dragging an item is not a click on it.
      if (state.dragged) { state.dragged = false; return; }
      activate(node.id);
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate(node.id);
      }
    });
    group.addEventListener("focus", () => { select(node.id); highlight(node.id); });
    group.addEventListener("blur", () => highlight(null));
    group.addEventListener("mouseenter", () => highlight(node.id));
    group.addEventListener("mouseleave", () => highlight(null));
    nodeLayer.append(group);
  }
  canvas.append(lanes, edgeLayer, labelLayer, nodeLayer);
  drawEdgeLegend(drawn, byId);
  for (const group of canvas.querySelectorAll(".node")) {
    group.classList.toggle("selected", group.dataset.id === state.selected);
  }
}

/** Light one node and what it is joined to; fade the rest. null clears it. */
function highlight(id) {
  const canvas = $("#canvas");
  canvas.classList.toggle("focus", Boolean(id));
  const near = new Set(id ? [id] : []);
  for (const element of canvas.querySelectorAll("[data-source]")) {
    const on = Boolean(id) && (element.dataset.source === id || element.dataset.target === id);
    element.classList.toggle("on", on);
    if (on) near.add(element.dataset.source).add(element.dataset.target);
  }
  for (const group of canvas.querySelectorAll(".node")) {
    group.classList.toggle("on", near.has(group.dataset.id));
  }
}

/** A key for the kinds of line drawn in their own way, only those on screen. */
function drawEdgeLegend(edges, byId) {
  const kinds = new Set(edges.map((edge) => edgeKind(edge, byId)));
  $("#edge-legend").replaceChildren(...Object.entries(EDGE_STYLES)
    .filter(([kind]) => kinds.has(kind))
    .map(([kind, label]) => {
      const key = svg("svg", { class: "key line", viewBox: "0 0 28 8", "aria-hidden": "true" });
      key.append(svg("line", { x1: 1, y1: 4, x2: 27, y2: 4, class: `edge ${kind}` }));
      return h("li", {}, key, label);
    }));
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
    state.zoomedIn && !arranged() ? "zoomed in to read: drag to move, Fit shows it all" : null,
  ].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------
// Table-shaped views, drawn as HTML
// ---------------------------------------------------------------------------

/**
 * Who knows what as a matrix: a row per domain, a column per department, each
 * cell the share of the department's members joined to the domain by
 * knows_about. The owners come from the domain's own record; a former owner
 * who is in no department any more is marked, since that knowledge has left.
 * Domains go by name: the corpus's own gap flag is the hiring backtest's answer
 * key, which no runtime code reads (test/gap-boundary.test.ts).
 */
function drawMatrix(host) {
  const { nodes, edges } = state.slice;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byName = (list) => list.sort((left, right) => nameOf(left).localeCompare(nameOf(right)));
  const departments = byName(nodes.filter((node) => node.type === "organization" && node.subtype === "department"));
  const domains = byName(nodes.filter((node) => node.type === "item" && node.subtype === "domain"));
  if (departments.length === 0 || domains.length === 0) {
    host.replaceChildren(h("p", { class: "hint-line" }, "No departments or domains recorded."));
    return;
  }
  const members = new Map(departments.map((department) => [department.id, []]));
  const departmentOf = new Map();
  const knows = new Set();
  for (const edge of edges) {
    if (edge.type === "member_of" && members.has(edge.target) && byId.has(edge.source)) {
      members.get(edge.target).push(edge.source);
      departmentOf.set(naturalKey(byId.get(edge.source)), byId.get(edge.target));
    }
    if (edge.type === "knows_about") knows.add(`${edge.source}\u0000${edge.target}`);
  }
  const people = new Map(nodes.filter((node) => node.type === "person").map((node) => [naturalKey(node), node]));
  const departmentName = (department) => nameOf(department).replace(/_/g, " ");

  const owner = (name, former) => {
    if (!name) return h("td", { class: "owner" }, "—");
    const department = departmentOf.get(name);
    const person = people.get(name);
    const left = former && !department;
    return h("td", { class: `owner${left ? " left" : ""}` },
      person ? h("button", { type: "button", onclick: () => select(person.id) }, name) : name,
      h("span", { class: "owner-department" }, left ? "no longer here" : department ? departmentName(department) : ""));
  };

  const header = h("tr", {},
    h("th", { scope: "col" }, "Domain"),
    ...departments.map((department) => h("th", { scope: "col", class: "department" },
      departmentName(department), h("small", {}, `${members.get(department.id).length} people`))),
    h("th", { scope: "col" }, "Owner"),
    h("th", { scope: "col" }, "Owner before"));
  const rows = domains.map((domain) => h("tr", {},
    h("th", { scope: "row" },
      h("button", { type: "button", onclick: () => select(domain.id) }, nameOf(domain))),
    ...departments.map((department) => {
      const list = members.get(department.id);
      const who = list.filter((id) => knows.has(`${id}\u0000${domain.id}`));
      const share = list.length ? who.length / list.length : 0;
      return h("td", { class: "cell" }, h("button", {
        type: "button",
        style: `--share: ${Math.round(6 + share * 80)}%`,
        class: share > 0.55 ? "strong" : "",
        title: `${who.length} of ${list.length} people in ${departmentName(department)} know ${nameOf(domain)}`,
        onclick: () => showCell(domain, department, who, list.length),
      }, `${Math.round(share * 100)}`));
    }),
    owner(domain.props?.primary_owner, false),
    owner(domain.props?.former_owner, true)));

  host.replaceChildren(
    h("p", { class: "hint-line" },
      "Each cell is the share (%) of a department's people who know a domain. Click a cell for their names."),
    h("div", { class: "matrix-scroll" }, h("table", { class: "matrix" }, h("thead", {}, header), h("tbody", {}, ...rows))),
  );
}

/** The people behind one matrix cell, in the details rail. */
function showCell(domain, department, who, total) {
  const byId = new Map(state.slice.nodes.map((node) => [node.id, node]));
  $("#details").replaceChildren(
    h("p", { class: "name" }, `${nameOf(domain)} in ${nameOf(department).replace(/_/g, " ")}`),
    h("p", { class: "kind-line" }, `${who.length} of ${total} people know it`),
    who.length
      ? h("ul", { class: "neighbours" }, ...who.map((id) =>
          h("li", {}, h("button", { type: "button", onclick: () => select(id) }, nameOf(byId.get(id))))))
      : h("p", { class: "hint-line" }, "No one in this department."),
  );
}

/**
 * Incidents as rows: one per incident with its ticket folded in (they share a
 * key), who raised it, who it went to, the fix, the write-up and the domains.
 * An incident caused by another is indented under it, so a chain reads top to
 * bottom; a customer ticket caused by one sits in its chain too. Choosing a
 * row draws that incident's neighbourhood.
 */
function drawLanes(host) {
  const { nodes, edges } = state.slice;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const from = new Map();
  for (const edge of edges) {
    if (!from.has(edge.source)) from.set(edge.source, []);
    from.get(edge.source).push(edge);
  }
  const joined = (id, ...types) => [...new Set((from.get(id) ?? [])
    .filter((edge) => types.includes(edge.type)).map((edge) => edge.target))]
    .map((target) => byId.get(target)).filter(Boolean);

  const events = nodes.filter((node) => node.type === "event");
  const isEvent = new Set(events.map((node) => node.id));
  const parent = new Map();
  const children = new Map();
  for (const edge of edges) {
    if (edge.type !== "caused_by" || !isEvent.has(edge.source) || !isEvent.has(edge.target)) continue;
    if (parent.has(edge.source)) continue;
    parent.set(edge.source, edge.target);
    if (!children.has(edge.target)) children.set(edge.target, []);
    children.get(edge.target).push(byId.get(edge.source));
  }
  const byTime = (list) => list.sort((left, right) => (timeOf(left) ?? 0) - (timeOf(right) ?? 0));
  if (events.length === 0) {
    host.replaceChildren(h("p", { class: "hint-line" }, "No incidents recorded."));
    return;
  }

  const keys = (list, label = naturalKey) => list.length
    ? list.map((node) => h("span", { class: "key-chip" }, label(node)))
    : [h("span", { class: "none" }, "—")];
  const names = (list) => list.map(nameOf).join(", ") || "—";
  const date = (node) => {
    const time = timeOf(node);
    return time === null ? "" : new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  };
  const seen = new Set();
  const row = (node, depth) => {
    const tickets = joined(node.id, "tracked_in").filter((ticket) => naturalKey(ticket) !== naturalKey(node));
    const title = nameOf(node).replace(/^Incident [^:]+:\s*/, "");
    return h("button", {
      type: "button",
      class: `lane${depth ? " follow-on" : ""}`,
      style: `--depth: ${Math.min(depth, 4)}`,
      "aria-label": `${naturalKey(node)}: ${title}. Draw it and everything joined to it.`,
      onclick: () => openIncident(node.id),
    },
      h("span", { class: "when" }, date(node)),
      h("span", { class: "what" },
        h("b", {}, naturalKey(node)),
        node.subtype === "incident" ? null : h("span", { class: "kind-tag" }, describeKind(node).replace(/^Event \((.*)\)$/, "$1")),
        h("span", { class: "title", title }, title),
        tickets.length ? h("span", { class: "none" }, ` · tracked in ${tickets.map(naturalKey).join(", ")}`) : null),
      h("span", { class: "who" }, `${names(joined(node.id, "raised_by"))} → ${names(joined(node.id, "received_by"))}`),
      h("span", { class: "keys" }, ...keys(joined(node.id, "fixed_by"))),
      h("span", { class: "keys" }, ...keys(joined(node.id, "produced", "documented_by"))),
      h("span", { class: "keys domains" }, ...keys(joined(node.id, "about_domain"), nameOf)),
    );
  };
  const chain = (node, depth, into) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    into.push(row(node, depth));
    for (const child of byTime(children.get(node.id) ?? [])) chain(child, depth + 1, into);
  };
  const groups = byTime(events.filter((node) => !parent.has(node.id))).map((root) => {
    const rows = [];
    chain(root, 0, rows);
    const after = rows.length - 1;
    return h("div", { class: "lane-group" }, ...rows,
      after ? h("p", { class: "lane-note" }, `${after} more followed from ${naturalKey(root)}`) : null);
  });
  host.replaceChildren(
    h("p", { class: "hint-line" },
      `${events.length} incidents and tickets from ${groups.length} root causes. Choose one to draw it and everything joined to it.`),
    h("div", { class: "lanes-scroll" },
      h("div", { class: "lanes" },
        h("div", { class: "lane head", "aria-hidden": "true" },
          h("span", {}, "Opened"), h("span", {}, "Incident"), h("span", {}, "Raised by → went to"),
          h("span", {}, "Fixed by"), h("span", {}, "Write-up"), h("span", {}, "Domains")),
        ...groups)),
  );
}

/** One incident and what it is directly joined to, on the canvas with each
 * line named. Its ticket is left out as in the rows (same key, same thing),
 * and so are lines between the neighbours, which would cross the star.
 * Clicking grows it as anywhere else; Back to start returns to the rows. */
function openIncident(id) {
  const incident = state.start.nodes.find((node) => node.id === id);
  const sameTicket = `item:${naturalKey(incident)}`;
  const edges = state.start.edges.filter((edge) =>
    (edge.source === id || edge.target === id) && edge.source !== sameTicket && edge.target !== sameTicket);
  const near = new Set([id, ...edges.flatMap((edge) => [edge.source, edge.target])]);
  state.slice = { ...state.start, nodes: state.start.nodes.filter((node) => near.has(node.id)), edges };
  state.incident = id;
  state.centreId = id;
  state.positions = new Map();
  state.expanded = new Set();
  placeNew(null);
  redraw();
  fit();
  declutter();
  select(id);
  $("#restore").disabled = false;
}

function redraw() {
  const html = arranged();
  $("#canvas").toggleAttribute("hidden", html);
  for (const selector of ["#canvas-help", "#legend", "#edge-legend", "#show-menu"]) $(selector).hidden = html;
  $("#arranged").hidden = !html;
  $(".picture-actions").hidden = html;
  if (layoutOf() === "matrix") drawMatrix($("#arranged"));
  else if (layoutOf() === "lanes") drawLanes($("#arranged"));
  else drawPicture();
  // The line under the picture says what a click does here.
  const help = $("#canvas-help");
  help.dataset.usual ??= help.textContent;
  help.textContent = layoutOf() === "force"
    ? "Click an item to put it in the middle, with what it is joined to around it; the trail above takes you back. Drag an item to move it, the background to look around, and scroll to zoom. “Open it up”, on the right, adds what else it is joined to."
    : help.dataset.usual;
  drawTrail();
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
  const about = $("#view-about");
  if (about) about.textContent = VIEWS[state.view].about ?? "";
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
      : view === "today"
        ? "/api/v1/graph/today"
        : `/api/v1/graph/view/${encodeURIComponent(view)}`;
    const slice = folded(await fetchJSON(url));
    if (generation !== state.generation) return;
    stopSimulation();
    stopFloating();
    state.fixed = new Map();
    state.focus = null;
    state.trail = [];
    state.slice = slice;
    state.start = slice;
    state.centreId = slice.centre ?? null;
    state.incident = null;
    state.positions = new Map();
    state.expanded = new Set();
    state.timeScale = null;
    state.selected = null;
    // Only the "Today" route sends this; every other view touches nothing.
    state.touched = new Set(Array.isArray(slice.touched) ? slice.touched : []);
    placeNew(null);
    // Drawn before framing: the frame measures the canvas, hidden until then
    // if the last view was HTML.
    redraw();
    if (layoutOf() === "force") settle();
    else {
      fit({ readable: layoutOf() === "columns" });
      declutter();
    }
    // Re-centred on something else, Back to start returns to the answer.
    $("#restore").disabled = MODE !== "answer" || onOrigin();
    if (view === "today" && slice.nodes.length === 0) {
      // Nothing to draw is a real answer, not a loading state that forgot to
      // finish — say so plainly instead of leaving an empty canvas.
      $("#status-line").textContent = "Nothing from today yet.";
      $("#details").replaceChildren(h("p", { class: "empty" },
        "Nothing from today has touched the company graph yet. Run a meeting or ask Kaki something, and it will show up here."));
    } else {
      $("#details").replaceChildren(h("p", { class: "empty" },
        view === "query" ? "Pick an item to see what it is."
        : view === "expertise" ? "Click a cell for the people behind the number."
        : view === "incidents" ? "Choose an incident to draw it and everything joined to it."
        : "Click anything to open it up."));
    }
    // The documents web opens on a focus; say what it is.
    if (layoutOf() === "force" && state.focus) select(state.focus);
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
    const before = new Set(state.slice.nodes.map((candidate) => candidate.id));
    const kept = folded(addition);
    state.slice = merge(state.slice, {
      nodes: kept.nodes,
      edges: kept.edges,
    }, removed);
    // A page's own "+N more" comes back under the same id, and must stay
    // clickable for the page after it; anything else opens up once.
    if (pager) state.positions.delete(id);
    else state.expanded.add(id);
    if (pager && spot && !state.positions.has(parentId)) state.positions.set(parentId, spot);
    placeNew(state.positions.has(parentId) ? parentId : null);
    redraw();
    // If what was added is out of sight, go to it: in a column view, at a
    // readable zoom around what was opened, not shrunk back to everything.
    const added = visibleNodes().filter((candidate) => !before.has(candidate.id));
    if (layoutOf() === "force") {
      // The web makes room for what was added, the camera staying on the focus.
      simulate({ alpha: 0.4, follow: true, done: declutter });
    } else if (!allInView(added)) fit({ readable: layoutOf() === "columns", around: parentId });
    select(pager ? parentId : id);
    $("#restore").disabled = false;
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    reportCounts();
  }
}

/** Clicking an item: in the force layout it becomes the focus (Open it up,
 * in the details, still adds its neighbours); elsewhere it opens up. */
function activate(id) {
  const node = state.slice.nodes.find((candidate) => candidate.id === id);
  if (layoutOf() === "force" && node && !isPager(node)) {
    focusOn(id);
    return;
  }
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
  // From one incident's drawing, back to the rows.
  state.incident = null;
  state.centreId = state.start.centre ?? null;
  state.slice = state.start;
  state.fixed = new Map();
  state.positions = new Map();
  state.expanded = new Set();
  state.timeScale = null;
  placeNew(null);
  redraw();
  if (layoutOf() === "force") settle();
  else fit({ readable: layoutOf() === "columns" });
  $("#restore").disabled = true;
}

/** A fresh force picture: most of the way settled at once and framed, then
 * seen easing the rest of the way, framed again if it spread out of sight. */
function settle() {
  state.focus = defaultFocus();
  state.trail = state.focus ? [state.focus] : [];
  redraw();
  simulate({ warm: 150, warmed: () => { frameFocus(1); declutter(); }, follow: true, done: declutter });
  if (state.focus) select(state.focus);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** The Show menu: one checkbox per category. Its button says how much is
 * shown, so a filter left on is not forgotten once the menu closes. */
function buildCategoryChips() {
  const fieldset = $("#categories");
  const summarise = () => {
    $("#show-summary").textContent = state.hidden.size === 0
      ? "everything"
      : `${CATEGORIES.length - state.hidden.size} of ${CATEGORIES.length}`;
    $("#show-menu").classList.toggle("filtered", state.hidden.size > 0);
  };
  for (const [key, label] of CATEGORIES) {
    const input = h("input", { type: "checkbox", id: `category-${key}`, value: key, checked: true });
    input.addEventListener("change", () => {
      if (input.checked) state.hidden.delete(key);
      else state.hidden.add(key);
      summarise();
      if (state.slice) redraw();
    });
    fieldset.append(h("label", { class: "show-option", for: `category-${key}` }, input, label));
  }
  // Closes like any menu: a click elsewhere, or Esc.
  const menu = $("#show-menu");
  document.addEventListener("click", (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.open) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });
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

/** Drag to pan, wheel to zoom about the pointer. In the force layout, dragging
 * an item pulls it, and what it is joined to follows. */
function enablePanAndZoom() {
  const canvas = $("#canvas");
  let dragging = null;
  let held = null;
  const scale = () => state.viewBox.width / (canvas.clientWidth || state.viewBox.width);
  canvas.addEventListener("pointerdown", (event) => {
    state.dragged = false;
    const group = event.target.closest?.(".node");
    if (group) {
      const start = state.positions.get(group.dataset.id);
      if (layoutOf() === "force" && start) {
        held = { id: group.dataset.id, x: event.clientX, y: event.clientY, start: { ...start }, moved: false };
      }
      return;
    }
    dragging = { x: event.clientX, y: event.clientY, box: { ...state.viewBox } };
    canvas.classList.add("dragging");
  });
  window.addEventListener("pointermove", (event) => {
    if (held) {
      // A few pixels of wobble is still a click.
      if (!held.moved && Math.hypot(event.clientX - held.x, event.clientY - held.y) < 4) return;
      const factor = scale();
      state.pinned = {
        id: held.id,
        x: held.start.x + (event.clientX - held.x) * factor,
        y: held.start.y + (event.clientY - held.y) * factor,
      };
      if (!held.moved) {
        held.moved = true;
        if (!state.simulation) simulate({ alpha: 0.3 });
      }
      return;
    }
    if (!dragging) return;
    const factor = scale();
    setViewBox({
      ...dragging.box,
      x: dragging.box.x - (event.clientX - dragging.x) * factor,
      y: dragging.box.y - (event.clientY - dragging.y) * factor,
    });
  });
  window.addEventListener("pointerup", () => {
    if (held?.moved) {
      state.dragged = true;
      state.fixed.set(held.id, { x: state.pinned.x, y: state.pinned.y });
      state.pinned = null;
    }
    held = null;
    dragging = null;
    canvas.classList.remove("dragging");
  });
  let settledZoom = null;
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    // What collides depends on the zoom: sort the words out once it stops.
    clearTimeout(settledZoom);
    settledZoom = setTimeout(declutter, 200);
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
// Caption size follows the canvas's size on screen, so keep --px current.
window.addEventListener("resize", () => {
  setViewBox(state.viewBox);
  declutter();
});
for (const button of document.querySelectorAll(".view-tab")) {
  button.addEventListener("click", () => load(button.dataset.view));
}
$("#tab-picture").addEventListener("click", () => showTab("picture"));
$("#tab-table").addEventListener("click", () => showTab("table"));
$("#restore").addEventListener("click", restore);
$("#fit").addEventListener("click", () => {
  fit();
  declutter();
});

{
  const parameters = new URLSearchParams(location.search);
  const question = (parameters.get("q") ?? "").trim();
  // Inside the chat's dialog, which already shows the question.
  if (parameters.get("embed") === "1") document.body.classList.add("embedded");
  // The company page carries the shared plate (plate.js), filled as on the assistant and meetings.
  if (document.querySelector("#plate") && typeof loadPlateNeeds === "function") {
    loadPlateNeeds();
    initPlanner();
  }
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
    // /graph?view=… opens on that overview; otherwise on the documents, so
    // the page never opens empty.
    const view = parameters.get("view");
    load(view && view in VIEWS && view !== "query" ? view : "documents");
  }
}
