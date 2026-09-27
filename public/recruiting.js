"use strict";

// Every string that came from a profile or a model is untrusted, so the page
// builds nodes and sets textContent; it never assigns innerHTML.

const SVG = "http://www.w3.org/2000/svg";
const $ = (selector) => document.querySelector(selector);

const BANDS = {
  100: { inner: 40, outer: 150, size: 26 },
  75: { inner: 190, outer: 290, size: 17 },
  50: { inner: 335, outer: 440, size: 9 },
};

let state = null;
let selectedId = null;
let detailSignature = "";
let draftCriteria = null;
/** Unsaved draft edits by candidate and draft, kept across drawer rebuilds. */
const typedDrafts = new Map();
/** People whose message is being saved and sent right now. */
const sendingFor = new Set();
/** Text typed into a drawer's other boxes (a pass reason, a pasted reply), kept across rebuilds until used. */
const typedFields = new Map();
/** People with a drawer action (outreach, keep, pass, reply, hired) on its way; its buttons stay disabled. */
const actingFor = new Set();

function keptInput(key, element) {
  if (typedFields.has(key)) element.value = typedFields.get(key);
  element.addEventListener("input", () => typedFields.set(key, element.value));
  return element;
}

/**
 * Whether the founder has typed something not yet saved or used: a draft edit, a pass reason, a
 * pasted reply, or unsaved criteria. The chat page asks before folding this panel away.
 */
window.hasUnsavedText = () => {
  if (!state?.role) return false;
  // Criteria edits matter only while there is still a review to confirm.
  if (draftDirty && !state.role.confirmed) return true;
  const byId = new Map(state.candidates.map((candidate) => [candidate.id, candidate]));
  const differs = (typed, draft, candidate) =>
    (typed.subject !== undefined && typed.subject !== draft.subject) ||
    (typed.body !== undefined && typed.body !== draft.body) ||
    (typed.email !== undefined && typed.email.trim() !== "" && typed.email !== (candidate.contact?.email ?? ""));
  for (const [key, typed] of typedDrafts) {
    const [role, id, ...rest] = key.split(":");
    if (role !== roleId) continue;
    const candidate = byId.get(id);
    // The draft this was typed into is gone (sent, replaced, closed): nothing left to lose.
    if (!candidate?.draft || candidate.draft.createdAt !== rest.join(":")) {
      typedDrafts.delete(key);
      continue;
    }
    if (differs(typed ?? {}, candidate.draft, candidate)) return true;
  }
  for (const [key, value] of typedFields) {
    const [role, id, box] = key.split(":");
    if (role !== roleId || typeof value !== "string" || value.trim() === "") continue;
    const candidate = byId.get(id);
    // Only a box that can still be shown: the reason while they are open, the reply while in a conversation.
    const shown =
      candidate &&
      (box === "reason"
        ? candidate.stage !== "closed"
        : ["contacted", "replied", "scheduling"].includes(candidate.stage));
    if (!shown) {
      typedFields.delete(key);
      continue;
    }
    return true;
  }
  return false;
};

/** Runs one drawer action per person at a time, then redraws that person's drawer. */
async function act(candidateId, work) {
  const key = `${roleId}:${candidateId}`;
  if (actingFor.has(key)) return undefined;
  actingFor.add(key);
  try {
    return await work();
  } finally {
    actingFor.delete(key);
    if (state && selectedId === candidateId) {
      detailSignature = "";
      renderDetail();
    }
  }
}
let lastRoundCount = 0;
let pollTimer = null;
const nodes = new Map();

// Inside the chat page the panel is framed: the chat is the composer, and the
// candidate named in the link opens once.
const params = new URLSearchParams(location.search);
const embedded = params.get("embed") === "1" && window.top !== window;
let pendingCandidate = embedded ? params.get("candidate") : null;
let roleId = params.get("role");
let roles = [];
/** Bumped on every role switch: an answer that arrives for an earlier view is dropped. */
let view = 0;
/** The founder has edited the draft criteria, so polling must not overwrite them. */
let draftDirty = false;
/** A background error the founder dismissed; it is not shown again. */
let dismissedError = null;
/** Set while the composer's request is in flight. */
let saying = false;

/** Every role-scoped call goes under the open role. */
function api(path) {
  return `/api/recruiting/roles/${encodeURIComponent(roleId)}${path}`;
}

function rememberRole() {
  const next = new URLSearchParams(location.search);
  if (roleId) next.set("role", roleId);
  else next.delete("role");
  history.replaceState(null, "", `${location.pathname}${next.size ? `?${next}` : ""}`);
}

/** Opens another role, or the intake when id is null. */
function switchRole(id) {
  roleId = id;
  view += 1;
  selectedId = null;
  closeDrawer();
  disarmDelete();
  draftCriteria = null;
  draftDirty = false;
  dismissedError = null;
  lastRoundCount = 0;
  for (const node of nodes.values()) node.remove();
  nodes.clear();
  rememberRole();
  showError("");
  refresh();
}

function closeDrawer() {
  const drawer = $("#drawer");
  drawer.hidden = true;
  drawer.replaceChildren();
  detailSignature = "";
}

function disarmDelete() {
  const button = $("#reset");
  button.dataset.armed = "";
  button.textContent = "Delete this role";
}

function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (value === true) element.setAttribute(key, "");
    else element.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function svg(tag, attributes = {}) {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function hash(text, seed = 0) {
  let value = 2166136261 ^ seed;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0) / 4294967295;
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

// ------------------------------------------------------------------ network

function showError(message, fromServer = false) {
  const banner = $("#error");
  banner.replaceChildren();
  banner.hidden = !message;
  if (!message) return;
  banner.append(message);
  if (fromServer) {
    // A background error stays until dismissed; dismissing tells the server too.
    banner.append(
      h("button", {
        type: "button",
        class: "link dismiss",
        onclick: async () => {
          dismissedError = message;
          showError("");
          if (roleId) await fetch(api("/dismiss-error"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
        },
      }, "Dismiss"),
    );
  }
}

/** Opens a new role from words or an uploaded file. */
async function createRole(body, button) {
  if (button) button.disabled = true;
  showError("");
  const asked = view;
  try {
    const response = await fetch("/api/recruiting/roles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      showError(data.message ?? "Something went wrong.");
      return undefined;
    }
    // The founder opened another role (or a fresh intake) meanwhile: the new role is listed,
    // not forced on screen, and a fresh intake they are filling in stays open.
    if (asked !== view) {
      refresh();
      return undefined;
    }
    startingNew = false;
    roleId = data.roleId;
    // Anything still in flight was asked about the intake, not this role.
    view += 1;
    rememberRole();
    render(data.state);
    refresh();
    return data.result;
  } catch {
    showError("The server did not answer. Is it running?");
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

/**
 * Posts an action and paints the answer. Undefined on failure, or when the founder moved to
 * another role meanwhile; `onStale(ok)` then says whether the action itself worked.
 */
async function call(path, body, button, options = {}) {
  if (button) button.disabled = true;
  showError("");
  const asked = view;
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await response.json();
    // The founder moved to another role meanwhile: this answer is not about what is on screen.
    if (asked !== view) {
      options.onStale?.(response.ok);
      return undefined;
    }
    if (!response.ok) {
      showError(data.message ?? "Something went wrong.");
      return undefined;
    }
    if (data.state) {
      actionsRendered += 1;
      render(data.state);
    }
    return data.result;
  } catch {
    showError("The server did not answer. Is it running?");
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

// Counts action answers painted; a refresh asked for before one of them is older than the screen.
let actionsRendered = 0;

async function refresh() {
  try {
    const listedFor = view;
    const paintedBefore = actionsRendered;
    const listed = await fetch("/api/recruiting/roles");
    if (listed.ok) roles = (await listed.json()).roles;
    if (listedFor !== view) return;
    // Without a role in the link, open the newest one. Panels saved before roles existed name none.
    if (!roleId && roles.length && !startingNew) {
      roleId = roles[0].id;
      rememberRole();
    }
    renderRoles();
    if (!roleId) {
      render(null);
      return;
    }
    const asked = view;
    const response = await fetch(api("/state"));
    if (asked !== view) return;
    if (response.status === 404) {
      if (embedded) showGone();
      else switchRole(null);
      return;
    }
    if (response.ok) {
      const next = await response.json();
      if (asked === view && paintedBefore === actionsRendered) render(next);
    }
  } catch {
    // The next poll tries again.
  }
}

let startingNew = false;

/** In the chat, a panel whose role was deleted says so instead of showing a stale board. */
function showGone() {
  state = null;
  closeDrawer();
  $("#intake").hidden = true;
  $("#review").hidden = true;
  $("#board").hidden = true;
  $("#top-actions").hidden = true;
  $("#role-title").textContent = "This role is no longer here";
  $("#status-line").textContent = "Open the full page to see your roles.";
  showError("This role does not exist any more. It was deleted, or the link is wrong.");
}

function renderRoles() {
  const select = $("#role-select");
  select.replaceChildren(
    ...roles.map((role) =>
      h(
        "option",
        { value: role.id, selected: role.id === roleId ? true : undefined },
        role.confirmed ? `${role.title} (${role.strong} strong)` : `${role.title} (draft)`,
      ),
    ),
  );
  if (!roleId) select.prepend(h("option", { value: "", selected: true }, "New role"));
  $("#roles").hidden = embedded || roles.length === 0;
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = state && (state.busy || state.memoryPending > 0);
  pollTimer = setTimeout(async () => {
    await refresh();
    schedulePoll();
  }, busy ? 1200 : 5000);
}

// ------------------------------------------------------------------- render

function render(next) {
  state = next;
  if (!state || !state.role?.confirmed) {
    // The drawer belongs to the board; it must not outlive it.
    selectedId = null;
    closeDrawer();
  }
  if (!state) {
    $("#intake").hidden = false;
    $("#review").hidden = true;
    $("#board").hidden = true;
    $("#top-actions").hidden = true;
    $("#role-title").textContent = "Who do you need?";
    $("#status-line").textContent = "Step 1 of 2: describe the role.";
    return;
  }
  const role = state.role;
  $("#intake").hidden = Boolean(role);
  $("#review").hidden = !role || role.confirmed;
  $("#board").hidden = !role?.confirmed;
  $("#top-actions").hidden = !role;
  $("#role-title").textContent = role ? role.title : "Who do you need?";

  if (state.lastError && state.lastError !== dismissedError && !$("#error").textContent) {
    showError(state.lastError, true);
  }

  if (role && !role.confirmed) {
    // Keep what the founder is typing: polling refreshes the draft only while it is untouched.
    const editing = draftDirty || $("#review").contains(document.activeElement);
    if (!editing) {
      draftCriteria = null;
      renderReview();
    } else if (!draftCriteria) {
      renderReview();
    }
  }
  if (role?.confirmed) {
    if (pendingCandidate) {
      const named = state.candidates.find((candidate) => candidate.id === pendingCandidate);
      if (named) {
        selectedId = named.id;
        // Shown for a draft, the panel opens where the send button is.
        if (named.draft) activeTab = "outreach";
      }
      pendingCandidate = null;
    }
    $("#say").dispatchEvent(new Event("input"));
    renderStatus();
    renderOrbit();
    renderProposals();
    renderCriteria();
    renderDetail();
  } else {
    $("#status-line").textContent = role ? "Step 2 of 2: check the criteria." : "Step 1 of 2: describe the role.";
  }
  renderTop();
}

function inPool() {
  return state.candidates.filter((candidate) => candidate.stage !== "closed" && candidate.tier !== "out" && candidate.tier !== "pending");
}

function renderStatus() {
  const pool = inPool();
  const strong = pool.filter((candidate) => candidate.tier === 100).length;
  const talking = state.candidates.filter((candidate) => ["contacted", "replied", "scheduling"].includes(candidate.stage)).length;
  const line = $("#status-line");
  line.replaceChildren();
  if (state.busy) line.append(h("span", { class: "busy-dot", "aria-hidden": "true" }));
  const parts = [`${pool.length} people in view`, `${strong} strong ${strong === 1 ? "match" : "matches"}`];
  if (talking) parts.push(`talking to ${talking}`);
  line.append(parts.join(", ") + (state.busy ? ". Thinking…" : "."));
}

/** Gmail's compose page, prefilled. Spaces stay %20: some mail apps show "+" literally. */
function gmailCompose(to, subject, body) {
  const query = [["view", "cm"], ["fs", "1"], ["to", to], ["su", subject], ["body", body]]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `https://mail.google.com/mail/?${query}`;
}

function renderTop() {
  const day = state.clockOffsetDays;
  $("#clock").textContent = day ? `${day} days later` : "Today";
  const gmail = $("#gmail");
  const status = state.integrations?.gmail;
  gmail.hidden = status === null || status === undefined;
  gmail.textContent = status ? "Gmail connected" : "Connect Gmail";
  gmail.classList.toggle("on", Boolean(status));
  if (status) gmail.removeAttribute("href");
  else gmail.setAttribute("href", "/api/recruiting/gmail/connect");
  $("#sample-note").hidden = state.integrations?.source !== "sample";
}

// ------------------------------------------------------------------ review

function renderReview() {
  if (!draftCriteria) draftCriteria = state.criteria.map(({ id, text, kind }) => ({ id, text, kind }));
  const list = $("#draft-criteria");
  list.replaceChildren(
    ...draftCriteria.map((criterion, index) =>
      h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            class: `kind-toggle ${criterion.kind}`,
            title: "Must or nice to have",
            onclick: () => {
              criterion.kind = criterion.kind === "must" ? "nice" : "must";
              draftDirty = true;
              renderReview();
            },
          },
          criterion.kind === "must" ? "MUST" : "NICE",
        ),
        h("input", {
          type: "text",
          value: criterion.text,
          "aria-label": `Criterion ${index + 1}`,
          oninput: (event) => {
            criterion.text = event.target.value;
            draftDirty = true;
          },
        }),
        h(
          "button",
          {
            type: "button",
            class: "remove",
            "aria-label": "Remove",
            onclick: () => {
              draftCriteria.splice(index, 1);
              draftDirty = true;
              renderReview();
            },
          },
          "×",
        ),
      ),
    ),
  );
}

function showRefused(refused) {
  const box = $("#refused");
  box.hidden = !refused?.length;
  box.replaceChildren(
    ...(refused ?? []).map((entry) =>
      h("p", {}, `Left out "${entry.text}": hiring criteria may not select on ${entry.characteristic}.`),
    ),
  );
}

// ------------------------------------------------------------------- orbit

function drawRings(root) {
  const defs = svg("defs");
  const glow = svg("radialGradient", { id: "core-glow" });
  glow.append(
    svg("stop", { offset: "0%", "stop-color": "#1f6d5f", "stop-opacity": "0.06" }),
    svg("stop", { offset: "100%", "stop-color": "#1f6d5f", "stop-opacity": "0.02" }),
  );
  const star = svg("filter", { id: "star-glow", x: "-80%", y: "-80%", width: "260%", height: "260%" });
  star.append(
    svg("feGaussianBlur", { stdDeviation: "6", result: "blur" }),
    Object.assign(svg("feMerge"), {}),
  );
  const merge = star.querySelector("feMerge");
  merge.append(svg("feMergeNode", { in: "blur" }), svg("feMergeNode", { in: "SourceGraphic" }));
  defs.append(glow, star);

  const rings = svg("g", { class: "rings" });
  for (const [tier, band] of Object.entries(BANDS)) {
    rings.append(svg("circle", { class: `ring r${tier}`, r: band.outer + 10 }));
  }
  rings.append(svg("circle", { class: "ripple", r: BANDS[50].outer + 30, id: "ripple" }));
  root.append(defs, rings, svg("g", { id: "nodes" }));
}

function layout(pool) {
  const positions = new Map();
  for (const tier of [100, 75, 50]) {
    const members = pool
      .filter((candidate) => candidate.tier === tier)
      .sort((left, right) => hash(left.id) - hash(right.id));
    const band = BANDS[tier];
    const offset = hash(String(tier), 7) * Math.PI * 2;
    members.forEach((candidate, index) => {
      const angle = offset + (index / Math.max(members.length, 1)) * Math.PI * 2;
      const lanes = tier === 100 && members.length <= 3 ? [0.55] : [0.3, 0.72];
      const lane = lanes[index % lanes.length];
      const radius =
        tier === 100 && members.length === 1 ? 0 : band.inner + (band.outer - band.inner) * lane;
      positions.set(candidate.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, size: band.size });
    });
  }
  return positions;
}

function renderOrbit() {
  const root = $("#orbit");
  if (!root.querySelector(".rings")) drawRings(root);
  const layer = $("#nodes");
  const pool = inPool();
  const crowdedCentre = pool.filter((candidate) => candidate.tier === 100).length > 4;
  const positions = layout(pool);
  $("#board").classList.toggle("focused", Boolean(selectedId));

  if (state.rounds.length > lastRoundCount && lastRoundCount > 0) {
    const ripple = $("#ripple");
    ripple.classList.remove("go");
    void ripple.getBoundingClientRect();
    ripple.classList.add("go");
  }
  lastRoundCount = state.rounds.length;

  for (const [id, node] of nodes) {
    if (!positions.has(id)) {
      node.classList.add("entering");
      setTimeout(() => node.remove(), 600);
      nodes.delete(id);
    }
  }

  for (const candidate of pool) {
    const position = positions.get(candidate.id);
    let node = nodes.get(candidate.id);
    if (!node) {
      node = svg("g", { class: "node entering", tabindex: 0, role: "button" });
      node.append(
        svg("circle", { class: "select-ring" }),
        svg("circle", { class: "halo" }),
        svg("circle", { class: "stage-ring" }),
        svg("circle", { class: "dot" }),
        svg("text", { class: "initials" }),
        svg("text", { class: "name" }),
        svg("title", {}),
      );
      node.addEventListener("click", () => select(candidate.id));
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select(candidate.id);
        }
      });
      // Enter from just outside the rings so a new search visibly arrives.
      const angle = Math.atan2(position.y, position.x) || hash(candidate.id) * Math.PI * 2;
      node.style.transform = `translate(${Math.cos(angle) * 520}px, ${Math.sin(angle) * 520}px)`;
      layer.append(node);
      nodes.set(candidate.id, node);
      requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove("entering")));
    }
    const { size } = position;
    node.setAttribute("class", [
      "node",
      `t${candidate.tier}`,
      candidate.stage,
      candidate.kept ? "kept" : "",
      crowdedCentre ? "" : "labelled",
      candidate.settled ? "" : "provisional",
      candidate.id === selectedId ? "selected" : "",
      node.classList.contains("entering") ? "entering" : "",
    ].filter(Boolean).join(" "));
    node.querySelector(".dot").setAttribute("r", size);
    node.querySelector(".halo").setAttribute("r", size + 6);
    node.querySelector(".stage-ring").setAttribute("r", size + 11);
    node.querySelector(".select-ring").setAttribute("r", size + 17);
    const label = node.querySelector(".initials");
    label.textContent = size >= 17 ? initials(candidate.profile.name) : "";
    label.style.fontSize = size >= 26 ? "16px" : "11px";
    const name = node.querySelector(".name");
    name.textContent = candidate.profile.name;
    name.setAttribute("y", size + 24);
    node.querySelector("title").textContent = `${candidate.profile.name}, ${candidate.profile.headline}`;
    node.setAttribute("aria-label", `${candidate.profile.name}, ${candidate.tier}% match`);
    requestAnimationFrame(() => {
      node.style.transform = `translate(${position.x}px, ${position.y}px)`;
    });
  }
}

// --------------------------------------------------------------- proposals

// Proposals with a decision on its way; a refresh meanwhile must not offer them again.
const deciding = new Set();

function renderProposals() {
  $("#proposals").replaceChildren(
    ...state.proposals.map((proposal) => {
      const isCriterion = proposal.type === "criterion";
      const busy = deciding.has(proposal.id) ? true : undefined;
      const decide = (accept) => async (event) => {
        if (deciding.has(proposal.id)) return;
        deciding.add(proposal.id);
        try {
          await call(api(`/proposals/${proposal.id}`), { accept }, event.currentTarget);
        } finally {
          deciding.delete(proposal.id);
          if (state) renderProposals();
        }
      };
      return h(
        "article",
        { class: "proposal" },
        h("h3", {}, isCriterion ? "I noticed a pattern in your passes" : `Hiring has stalled. ${proposal.stepName}?`),
        h("p", {}, proposal.rationale),
        isCriterion
          ? h("p", { class: "change" }, `Add as ${proposal.kind === "must" ? "a must" : "a nice-to-have"}: ${proposal.text}`)
          : h("p", { class: "change" }, `Next search: ${proposal.query}`),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", class: "primary", disabled: busy, onclick: decide(true) }, isCriterion ? "Add criterion" : "Widen the search"),
          h("button", { type: "button", class: "quiet", disabled: busy, onclick: decide(false) }, "Not now"),
        ),
      );
    }),
  );
}

function renderCriteria() {
  $("#criteria").replaceChildren(
    ...state.criteria.map((criterion) =>
      h(
        "li",
        { class: `chip ${criterion.kind} ${criterion.origin}`, title: criterion.kind === "must" ? "Must have" : "Nice to have" },
        criterion.text,
        criterion.origin === "inferred" ? h("span", { class: "origin" }, "learned") : null,
        criterion.origin === "relaxed" ? h("span", { class: "origin" }, "relaxed") : null,
      ),
    ),
  );
}

// ------------------------------------------------------------------ drawer

let activeTab = "fit";

function select(id) {
  if (!state?.role?.confirmed) {
    selectedId = null;
    closeDrawer();
    return;
  }
  const next = selectedId === id ? null : id;
  if (next !== selectedId) activeTab = "fit";
  selectedId = next;
  detailSignature = "";
  renderOrbit();
  renderDetail();
}

function signature(candidate) {
  return JSON.stringify([
    activeTab,
    candidate.id,
    candidate.stage,
    candidate.tier,
    candidate.kept,
    candidate.contact,
    candidate.draft?.createdAt,
    // A draft saved elsewhere (another tab or panel) must show here before it can be sent from here.
    candidate.draft?.subject,
    candidate.draft?.body,
    candidate.draft?.warnings,
    candidate.messages.length,
    candidate.verdicts,
    // "Why they fit" names each criterion and its kind.
    state.criteria.map((criterion) => [criterion.id, criterion.text, criterion.kind]),
  ]);
}

const STAGE_LABEL = {
  discovered: "Found",
  scored: "Not contacted yet",
  drafted: "Draft ready",
  contacted: "Waiting for a reply",
  replied: "Replied",
  scheduling: "Setting a time",
  closed: "Closed",
};

function renderDetail() {
  const drawer = $("#drawer");
  const candidate = state.candidates.find((entry) => entry.id === selectedId);
  if (!candidate) {
    drawer.hidden = true;
    detailSignature = "";
    return;
  }
  const next = signature(candidate);
  // Keep the founder's unsent edits: only rebuild when something changed.
  if (next === detailSignature) return;
  detailSignature = next;
  drawer.hidden = false;

  const { profile } = candidate;
  const matched = candidate.tier === 100 || candidate.tier === 75 || candidate.tier === 50;
  const hasOutreach = Boolean(candidate.draft) || candidate.messages.length > 0;
  const busy = actingFor.has(`${roleId}:${candidate.id}`) ? true : undefined;
  const reasonKey = `${roleId}:${candidate.id}:reason`;
  const reasonInput = keptInput(reasonKey, h("input", { type: "text", placeholder: "Why? Optional, stays private" }));
  const decision = (value) => (event) => {
    const button = event.currentTarget;
    return act(candidate.id, async () => {
      // Done for a role no longer on screen still counts as done: the reason was used.
      // Forget the reason only if nothing was typed after it went out.
      const sent = reasonInput.value;
      const used = () => (typedFields.get(reasonKey) ?? "") === sent && typedFields.delete(reasonKey);
      const onStale = (ok) => ok && used();
      const done = await call(api(`/candidates/${candidate.id}/feedback`), { decision: value, reason: sent }, button, { onStale });
      if (done !== undefined) used();
    });
  };

  const tab = (key, label, dot = false) =>
    h(
      "button",
      {
        type: "button",
        class: "tab",
        role: "tab",
        "aria-selected": String(activeTab === key),
        onclick: () => {
          activeTab = key;
          detailSignature = "";
          renderDetail();
        },
      },
      label,
      dot ? h("span", { class: "dot", "aria-label": "has activity" }) : null,
    );

  const body = { fit: fitPanel, career: careerPanel, outreach: outreachPanel }[activeTab](candidate);

  // A rebuild while the founder types keeps their place: the same box gets focus and caret back.
  const focused = drawer.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused && ["INPUT", "TEXTAREA"].includes(focused.tagName)
    ? { tag: focused.tagName, label: focused.getAttribute("aria-label"), placeholder: focused.getAttribute("placeholder"), start: focused.selectionStart, end: focused.selectionEnd }
    : null;

  drawer.replaceChildren(
    h(
      "div",
      { class: "drawer-head" },
      h(
        "div",
        { class: "drawer-title" },
        h("div", {}, h("h3", {}, profile.name), h("p", { class: "meta" }, [profile.headline, profile.location].filter(Boolean).join(", "))),
        h("button", { type: "button", class: "close", "aria-label": "Close", onclick: () => select(candidate.id) }, "×"),
      ),
      h(
        "div",
        { class: "facts" },
        matched ? h("span", { class: `fact match${candidate.tier}` }, `${candidate.tier}% match`) : null,
        h("span", { class: "fact" }, candidate.stage === "closed" ? `Closed: ${candidate.closedReason}` : STAGE_LABEL[candidate.stage]),
        candidate.kept ? h("span", { class: "fact match100" }, "Kept") : null,
        candidate.origin === "referral" ? h("span", { class: "fact" }, "Added by you") : null,
        candidate.origin !== "referral" && candidate.poolRound > 1 ? h("span", { class: "fact" }, "Found in a later search") : null,
      ),
      candidate.stage === "closed"
        ? null
        : h(
            "div",
            { class: "decide" },
            reasonInput,
            h("button", { type: "button", class: "quiet", disabled: busy, onclick: decision("keep") }, "Keep"),
            h("button", { type: "button", class: "quiet warn", disabled: busy, onclick: decision("pass") }, "Pass"),
          ),
      h(
        "nav",
        { class: "tabs", role: "tablist" },
        tab("fit", "Why they fit"),
        tab("career", "Career"),
        tab("outreach", "Outreach", hasOutreach),
      ),
    ),
    h("div", { class: "drawer-body", role: "tabpanel" }, body),
  );
  if (focusKey) {
    const again = [...drawer.querySelectorAll(focusKey.tag.toLowerCase())].find(
      (element) => element.getAttribute("aria-label") === focusKey.label && element.getAttribute("placeholder") === focusKey.placeholder,
    );
    if (again) {
      again.focus();
      try {
        if (focusKey.start === null || focusKey.start === undefined) throw new Error("no caret");
        again.setSelectionRange(focusKey.start, focusKey.end);
      } catch {
        // Email inputs have no caret position: put it at the end, where typing continues.
        const value = again.value;
        again.value = "";
        again.value = value;
      }
    }
  }
}

function fitPanel(candidate) {
  const mark = { yes: "✓", no: "✗", unclear: "?" };
  return h(
    "ul",
    { class: "verdicts" },
    state.criteria.map((criterion, index) => {
      const verdict = candidate.verdicts[index];
      const closed = !verdict && candidate.stage === "closed";
      return h(
        "li",
        {},
        h("span", { class: `mark ${verdict?.satisfied ?? (closed ? "closed" : "unclear")}` }, verdict ? mark[verdict.satisfied] : closed ? "·" : "…"),
        h(
          "span",
          {},
          h("span", { class: "criterion" }, criterion.text, h("small", {}, criterion.kind === "must" ? "must" : "nice to have")),
          h("span", { class: "reason" }, verdict ? verdict.reasoning : closed ? "Added after this person was closed." : "Judging…"),
        ),
      );
    }),
  );
}

function aboutText(summary) {
  // Profile text arrives as Markdown; show its About section as plain prose.
  const about = summary.split(/\n## /).find((part) => part.startsWith("About"));
  const text = (about ? about.replace(/^About\s*/, "") : "").replace(/[#*_`>]/g, "").trim();
  return text.length > 700 ? `${text.slice(0, 700)}…` : text;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthYear(value) {
  const match = /^(\d{4})-(\d{2})/.exec(value ?? "");
  return match ? `${MONTHS[Number(match[2]) - 1] ?? ""} ${match[1]}`.trim() : value ?? "";
}

function span(from, to) {
  if (!from) return "";
  return `${monthYear(from)} to ${to ? monthYear(to) : "now"}`;
}

function careerPanel(candidate) {
  const { profile } = candidate;
  const about = aboutText(profile.summary);
  return h(
    "div",
    {},
    about ? h("p", { class: "about" }, about) : null,
    profile.workHistory.length ? h("h4", { class: "section-title" }, "Work") : null,
    profile.workHistory.length
      ? h(
          "ol",
          { class: "timeline" },
          profile.workHistory.map((entry) =>
            h(
              "li",
              { class: entry.from && !entry.to ? "current" : "" },
              h("span", { class: "role" }, entry.title || "Role not listed"),
              h("span", { class: "where" }, [entry.company, span(entry.from, entry.to)].filter(Boolean).join(", ")),
            ),
          ),
        )
      : null,
    profile.educationHistory.length ? h("h4", { class: "section-title" }, "Education") : null,
    profile.educationHistory.length
      ? h(
          "ol",
          { class: "timeline" },
          profile.educationHistory.map((entry) =>
            h("li", {}, h("span", { class: "role" }, entry.degree || "Degree not listed"), h("span", { class: "where" }, [entry.institution, span(entry.from, entry.to)].filter(Boolean).join(", "))),
          ),
        )
      : null,
    /^https:\/\//.test(profile.profileUrl)
      ? h("a", { class: "external", href: profile.profileUrl, target: "_blank", rel: "noopener noreferrer" }, "Open their public profile")
      : null,
  );
}

function outreachPanel(candidate) {
  const parts = [];
  const acting = actingFor.has(`${roleId}:${candidate.id}`) ? true : undefined;
  if (candidate.stage === "closed") {
    parts.push(h("p", { class: "empty-note" }, `Closed: ${candidate.closedReason}.`));
  }

  if (candidate.messages.length) {
    parts.push(
      h(
        "div",
        { class: "thread" },
        candidate.messages.map((message) =>
          h(
            "div",
            { class: `bubble ${message.direction}` },
            h("small", {}, `${message.direction === "outbound" ? "You" : candidate.profile.name}, ${message.channel}, ${message.at.slice(0, 10)}`),
            message.text,
          ),
        ),
      ),
    );
  }

  if (candidate.draft) {
    const draft = candidate.draft;
    // What the founder typed survives a rebuild of the drawer until it is saved.
    // Keyed by role too: the same person can be a candidate for two roles.
    const typedKey = `${roleId}:${candidate.id}:${draft.createdAt}`;
    const sendKey = `${roleId}:${candidate.id}`;
    const sendRole = roleId;
    const typed = typedDrafts.get(typedKey) ?? {};
    const email = h("input", { type: "email", value: typed.email ?? candidate.contact?.email ?? "", placeholder: "Email address", "aria-label": "To" });
    const subject = h("input", { type: "text", value: typed.subject ?? draft.subject, "aria-label": "Subject", placeholder: "Subject (emails only)" });
    const body = h("textarea", { "aria-label": "Message" }, typed.body ?? draft.body);
    for (const [field, input] of [["email", email], ["subject", subject], ["body", body]]) {
      input.addEventListener("input", () => {
        typedDrafts.set(typedKey, { ...typedDrafts.get(typedKey), [field]: input.value });
      });
    }
    // call() answers undefined on failure (and shows why); a send only follows a save that worked.
    const save = async () => {
      const sent = { subject: subject.value, body: body.value, email: email.value };
      const saved =
        (await call(api(`/candidates/${candidate.id}/draft`), {
          subject: sent.subject,
          body: sent.body,
          ...(sent.email && sent.email !== candidate.contact?.email ? { email: sent.email } : {}),
        })) !== undefined;
      // Forget the typed text only if nothing was typed after it went out.
      const now = typedDrafts.get(typedKey);
      const unchanged = !now || ["subject", "body", "email"].every((field) => now[field] === undefined || now[field] === sent[field]);
      if (saved && unchanged) typedDrafts.delete(typedKey);
      return saved;
    };
    // Both send buttons stay locked from the save until the send answers: one press, one send.
    // The lock is per person, not per drawer build, so a rebuild meanwhile keeps it.
    const sendAfterSave = (manual) => async (event) => {
      const button = event.currentTarget;
      if (sendingFor.has(sendKey)) return;
      sendingFor.add(sendKey);
      button.disabled = true;
      try {
        if (!(await save())) return;
        await call(api(`/candidates/${candidate.id}/send`), manual ? { manual: true } : {}, button);
      } finally {
        sendingFor.delete(sendKey);
        button.disabled = false;
        // Unlock this person's drawer; another person's open drawer keeps what is typed in it.
        if (state && selectedId === candidate.id && roleId === sendRole) {
          detailSignature = "";
          renderDetail();
        }
      }
    };
    const locked = sendingFor.has(sendKey) ? true : undefined;
    const source = {
      hunter: "Found by Hunter",
      prospeo: "Found by Prospeo",
      founder: "Entered by you",
    }[candidate.contact?.provider];
    // Opens the message ready to send in the founder's own Gmail; their Send there is what sends
    // it, and this records it. The link is filled in at click time, so it carries the last edits.
    const blocked = () => sendingFor.has(sendKey) || draft.warnings.length > 0 || !email.value.trim();
    const gmailButton = h(
      "a",
      {
        class: "button primary",
        href: "#",
        target: "_blank",
        rel: "noopener",
        "aria-disabled": blocked() ? "true" : undefined,
        title: draft.warnings.length ? draft.warnings[0] : email.value.trim() ? "Opens in your Gmail, ready to send" : "Add an email address first",
        onclick: (event) => {
          const link = event.currentTarget;
          if (blocked()) {
            event.preventDefault();
            if (!email.value.trim()) email.focus();
            return;
          }
          // An email needs a subject; a draft written as a LinkedIn message has none.
          if (!subject.value.trim()) {
            event.preventDefault();
            showError("Add a subject line before sending this as an email.");
            subject.focus();
            return;
          }
          link.href = gmailCompose(email.value.trim(), subject.value, body.value);
          sendingFor.add(sendKey);
          link.setAttribute("aria-disabled", "true");
          void (async () => {
            try {
              if (await save()) await call(api(`/candidates/${candidate.id}/send`), {});
            } finally {
              sendingFor.delete(sendKey);
              if (state && selectedId === candidate.id && roleId === sendRole) {
                detailSignature = "";
                renderDetail();
              }
            }
          })();
        },
      },
      "Open in Gmail to send",
    );
    // Typing an address makes it possible right away.
    email.addEventListener("input", () => {
      gmailButton.setAttribute("aria-disabled", blocked() ? "true" : "false");
    });
    const status = candidate.contact
      ? h(
          "p",
          { class: "email-status" },
          candidate.contact.provider === "founder" || candidate.contact.status === "verified"
            ? `${source}${candidate.contact.provider === "founder" ? "" : " and verified"}.`
            : `${source}, not verified.`,
        )
      : h("p", { class: "email-status missing" }, "No email found. Type one in if you know it, or send the message on LinkedIn yourself.");
    parts.push(
      h(
        "div",
        { class: "draft-box" },
        h("h4", { class: "section-title" }, { intro: "First message", follow_up: "Follow-up", scheduling: "Setting a time" }[draft.kind]),
        email,
        status,
        subject,
        body,
        draft.warnings.map((warning) => h("p", { class: "banner note" }, warning)),
        h(
          "div",
          { class: "row sticky-actions" },
          gmailButton,
          h("button", { type: "button", class: "quiet", disabled: locked, onclick: sendAfterSave(true) }, "I sent it myself"),
          h("button", { type: "button", class: "quiet", onclick: save }, "Save edits"),
        ),
      ),
    );
  } else if (["discovered", "scored"].includes(candidate.stage)) {
    parts.push(
      h("p", { class: "empty-note" }, "Nothing sent yet. I will look up an email with Hunter and Prospeo and write a first message for you to check. I never guess an address."),
      h("button", { type: "button", class: "primary", disabled: acting, onclick: (event) => {
        const button = event.currentTarget;
        button.textContent = "Finding email and drafting…";
        return act(candidate.id, async () => {
          await call(api(`/candidates/${candidate.id}/outreach`), {}, button);
          button.textContent = "Find email and draft";
        });
      } }, acting ? "Finding email and drafting…" : "Find email and draft"),
    );
  }

  if (["contacted", "replied", "scheduling"].includes(candidate.stage)) {
    const replyKey = `${roleId}:${candidate.id}:reply`;
    const reply = keptInput(replyKey, h("textarea", { rows: 3, placeholder: "Paste or dictate their reply" }));
    parts.push(
      h(
        "div",
        { class: "draft-box" },
        h("h4", { class: "section-title" }, "Their reply"),
        reply,
        h(
          "div",
          { class: "row" },
          h("button", { type: "button", class: "quiet", disabled: acting, onclick: (event) => {
            const button = event.currentTarget;
            return act(candidate.id, async () => {
              // Forget the reply only if nothing was added to the box after it went out.
              const sent = reply.value;
              const used = () => (typedFields.get(replyKey) ?? "") === sent && typedFields.delete(replyKey);
              const onStale = (ok) => ok && used();
              const result = await call(api(`/candidates/${candidate.id}/reply`), { text: sent }, button, { onStale });
              if (result !== undefined) used();
              if (result) $("#agent-reply").textContent = result.message;
            });
          } }, "Add reply"),
          h("button", { type: "button", class: "quiet", disabled: acting, onclick: (event) => {
            const button = event.currentTarget;
            return act(candidate.id, () => call(api(`/candidates/${candidate.id}/close`), { reason: "hired" }, button));
          } }, "Mark as hired"),
        ),
      ),
    );
  }
  return h("div", {}, parts);
}

// ------------------------------------------------------------------ events

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.body.classList.toggle("embed", embedded);
  $("#role-select").addEventListener("change", (event) => {
    if (event.target.value) {
      startingNew = false;
      switchRole(event.target.value);
    }
  });
  $("#new-role").addEventListener("click", () => {
    startingNew = true;
    switchRole(null);
    $("#requirement").focus();
  });

  $("#intake-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("#requirement").value.trim();
    if (!text) return;
    draftCriteria = null;
    const result = await createRole({ text }, event.submitter);
    showRefused(result?.refused);
  });

  $("#jd-file").addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    draftCriteria = null;
    const result = await createRole({ filename: file.name, contentBase64: await readFile(file) });
    showRefused(result?.refused);
    event.target.value = "";
  });

  $("#add-criterion").addEventListener("click", () => {
    draftCriteria.push({ text: "", kind: "nice" });
    renderReview();
    $("#draft-criteria").lastElementChild?.querySelector("input")?.focus();
  });

  $("#confirm").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const revised = await call(api("/criteria/draft"), { criteria: draftCriteria }, button);
    if (revised === undefined) return;
    button.textContent = "Searching…";
    const confirmed = await call(api("/confirm"), {}, button);
    button.textContent = "Confirm and search";
    // A failed confirm leaves the draft as it was, so it can be edited and confirmed again.
    if (confirmed === undefined) return;
    draftCriteria = null;
    draftDirty = false;
    showRefused([]);
    schedulePoll();
  });

  const say = $("#say");
  const sendButton = $("#say-form .send");
  const fit = () => {
    say.style.height = "auto";
    // A hidden textarea measures 0; leave it to CSS until it is on screen.
    if (say.scrollHeight > 0) say.style.height = `${Math.min(say.scrollHeight, 180)}px`;
    sendButton.disabled = saying || !say.value.trim();
  };
  say.addEventListener("input", fit);
  fit();

  $("#say-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = say.value.trim();
    // One instruction at a time: Enter or a re-enabled button must not send it twice.
    if (!text || saying) return;
    saying = true;
    fit();
    $("#agent-reply").textContent = "…";
    // Pasted LinkedIn profile links add those people; anything else goes to the agent.
    // Sentence punctuation after a link ("…/in/alice-tan.", "(…/in/bob-lim)") is not part of it.
    // A slug holds letters (any script), digits, %, _ and -: punctuation right after a link
    // ("…/in/alice-tan，她很合适") is not part of it. "linkedin.com/in/x" without https:// counts
    // too (it is how LinkedIn's contact info shows it) and is sent as a full https link.
    // Marks (\p{M}) too: Thai and Devanagari names need them; NFC keeps "josé" whole.
    const links = [...text.normalize("NFC").matchAll(/(?<![\w.\/])(?:https?:\/\/)?((?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/in\/[\p{L}\p{M}\p{N}%_-]+\/?)/giu)]
      .map((match) => `https://${match[1]}`);
    let result;
    try {
      // Done for a role no longer on screen: the instruction must not linger in this one's box.
      const onStale = (ok) => {
        if (ok && say.value.trim() === text) say.value = "";
      };
      result = links.length
        ? await call(api("/candidates/import"), { urls: links }, undefined, { onStale })
        // The open drawer tells the agent who "this one" is.
        : await call(api("/say"), { text, ...(selectedId ? { candidateId: selectedId } : {}) }, undefined, { onStale });
    } finally {
      saying = false;
      fit();
    }
    if (result) {
      // Only the instruction that was sent is cleared; anything typed meanwhile stays.
      if (say.value.trim() === text) say.value = "";
      fit();
      $("#agent-reply").textContent = [
        result.message,
        ...(result.refused ?? []).map((entry) => `Left out "${entry.text}": criteria may not select on ${entry.characteristic}.`),
      ].join("\n");
    } else {
      $("#agent-reply").textContent = "";
    }
    schedulePoll();
  });

  say.addEventListener("keydown", (event) => {
    // Safari reports an input method's confirming Enter with keyCode 229 and isComposing false.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      $("#say-form").requestSubmit();
    }
  });

  for (const hint of document.querySelectorAll(".hint")) {
    hint.addEventListener("click", () => {
      say.value = hint.textContent;
      fit();
      say.focus();
    });
  }

  $("#find-more").addEventListener("click", async (event) => {
    const result = await call(api("/more"), {}, event.currentTarget);
    if (result) {
      const reply = $("#agent-reply");
      reply.textContent = result.added
        ? `Added ${result.added} ${result.added === 1 ? "person" : "people"}. Scoring them now.`
        : "No new people turned up. Try loosening a criterion.";
    }
  });

  $("#fast-forward").addEventListener("click", async (event) => {
    await call(api("/fast-forward"), { days: 7 }, event.currentTarget);
    schedulePoll();
  });

  $("#reset").addEventListener("click", async (event) => {
    if (event.currentTarget.dataset.armed !== "yes") {
      event.currentTarget.dataset.armed = "yes";
      event.currentTarget.textContent = "Click again to erase";
      return;
    }
    event.currentTarget.dataset.armed = "";
    event.currentTarget.textContent = "Delete this role";
    const asked = view;
    try {
      const response = await fetch(api(""), { method: "DELETE" });
      if (!response.ok) {
        showError("Could not delete the role.");
        return;
      }
    } catch {
      showError("The server did not answer, so the role was not deleted.");
      return;
    }
    // The founder picked another role while it was deleted: stay there.
    if (asked !== view) {
      refresh();
      return;
    }
    switchRole(null);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && selectedId) select(selectedId);
  });

  refresh().then(schedulePoll);
});
