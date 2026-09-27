// Not "use strict": app.js, which shares this global scope on the assistant
// page, is not strict either, and a browser test harness that loads scripts
// with eval() (rather than a real <script> tag) only shares top-level
// bindings across scripts when neither is strict.
//
// The plate: what sits on the left of every page in Kaki's one entry (the
// assistant and meetings) - the Kaki mark, the day picker, what needs the
// signed-in employee and what waits on others, their tickets and plan for
// the chosen day, and links out. Both pages load this script and share one
// implementation; a page that wants more (the assistant's own chat home)
// reads what this script found rather than asking again.
//
// A page that has no source-evidence dialog, or no open conversation to
// interrupt, or no login dialog of its own, still works: those bits are
// optional hooks a page can register, and default to doing nothing more
// than is safe on its own.

/** Set by a page with a source-evidence dialog (the assistant); without one, a
 * cited ticket in the plate's list is shown but not clickable. */
let plateSourceHandler = null;
function setPlateSourceHandler(fn) {
  plateSourceHandler = fn;
}

/** Set by a page with its own sign-in flow; the default just sends the
 * visitor to sign in and back. */
let plateAuthRequiredHandler = () => {
  location.assign(`/?next=${encodeURIComponent(location.pathname + location.search)}`);
};
function setPlateAuthRequiredHandler(fn) {
  plateAuthRequiredHandler = fn;
}

/** Set by a page with an open conversation that a change of day would make
 * stale (the assistant); the meetings page has no conversation to interrupt. */
let plateDayChangeHandler = () => {};
function setPlateDayChangeHandler(fn) {
  plateDayChangeHandler = fn;
}

// Line icons in the same stroke style everywhere in Kaki. Emoji are never used as icons.
const LINE_ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  external: '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>',
  graph: '<circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="7" r="2.5"/><circle cx="11" cy="18" r="2.5"/><path d="M7.5 6.3l9 .5"/><path d="M6.2 8.3l3.6 7.4"/><path d="M17.6 9.1l-5.3 6.8"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5a3 3 0 0 1 0 6M18 20a5 5 0 0 0-3-4.6"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  hand: '<path d="M8 11V5a1.5 1.5 0 0 1 3 0v5M11 10V4a1.5 1.5 0 0 1 3 0v6M14 10V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a5 5 0 0 1-4.3-2.5L3.5 13a1.5 1.5 0 0 1 2.6-1.5L8 14"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76V6h6v4.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 15.24V17H5v-1.76a2 2 0 0 1 1.11-1.79l1.78-.9A2 2 0 0 0 9 10.76Z"/><path d="M8 3h8"/>',
};

function lineIcon(name, size = 14) {
  return `<svg class="line-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LINE_ICONS[name] ?? ""}</svg>`;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  // Quotes too: the result also goes inside attribute values.
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// The chosen day, and the Today panel
// ---------------------------------------------------------------------------
//
// The company can be looked at from the end of any working day in the record.
// `viewDay` is that day, or null for the present. It lives in the address
// (?asOf=), so a reload or a shared link opens on the same day. A new chat
// takes the day on screen; a conversation keeps the day it was begun on, and
// opening one moves the picker to its day.

const asOfGroup = document.querySelector("#as-of");
const asOfInput = document.querySelector("#as-of-input");
const asOfCaption = document.querySelector("#as-of-caption");
const asOfPrev = document.querySelector("#as-of-prev");
const asOfNext = document.querySelector("#as-of-next");
const asOfNow = document.querySelector("#as-of-now");
const todayToggle = document.querySelector("#today-toggle");
const todayPanel = document.querySelector("#today-panel");
const todayDate = document.querySelector("#today-date");
const todoList = document.querySelector("#todo-list");
const planList = document.querySelector("#plan-list");
const companyGraphLink = document.querySelector("#company-graph-link");

/** The working days, oldest first; empty until loaded, or where there are none. */
let workingDays = [];
let viewDay = null;
/** Bumped on every change of day or person, so a slow answer for the old one is dropped. */
let plannerEpoch = 0;

/** The day on screen, for a page (the assistant's chat) that asks about it on that day. */
function currentViewDay() {
  return viewDay;
}

/** Another employee's list must not stay on screen under this one's name. */
function refreshTodayPanelForNewUser() {
  if (workingDays.length) {
    plannerEpoch += 1;
    loadTodayPanel();
    if (gapsAvailable) loadGaps();
  }
}

function requestedDayFromAddress() {
  const value = new URLSearchParams(location.search).get("asOf");
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function writeDayToAddress(day) {
  const params = new URLSearchParams(location.search);
  if (day) params.set("asOf", day);
  else params.delete("asOf");
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
}

/** The working day on or before `day`, as the server reads it; null outside the record. */
function workingDayFor(day) {
  if (!day || !workingDays.length || day < workingDays[0] || day > workingDays[workingDays.length - 1]) return null;
  let chosen = workingDays[0];
  for (const candidate of workingDays) {
    if (candidate > day) break;
    chosen = candidate;
  }
  return chosen;
}

function formatDay(day) {
  const date = new Date(`${day}T00:00:00Z`);
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

const ASK_TODAY = "Ask about a ticket, a person or a meeting";

/** Shows `day` (or the present) in the picker, the header and the panel, and reloads the panel. */
function showDay(day) {
  viewDay = day;
  plannerEpoch += 1;
  const shown = day ?? workingDays[workingDays.length - 1] ?? "";
  if (asOfInput) asOfInput.value = shown;
  if (asOfCaption) asOfCaption.textContent = day ? "As of" : "Today";
  const named = shown
    ? new Date(`${shown}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
    : "";
  const label = document.querySelector("#as-of-label");
  if (label && named) {
    // A past day has "As of" and "Now" beside it: the day alone, the weekday on hover.
    label.textContent = day ? named.replace(/^\S+\s/, "") : named;
    label.title = new Date(`${shown}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  }
  // A question asked on a past day is answered as of it, so the composer says so.
  const composer = document.querySelector("#message-input");
  if (composer) composer.placeholder = day && named ? `Ask as of ${named}` : ASK_TODAY;
  if (asOfGroup) asOfGroup.classList.toggle("past", Boolean(day));
  if (asOfNow) asOfNow.hidden = !day;
  const index = workingDays.indexOf(shown);
  if (asOfPrev) asOfPrev.disabled = index <= 0;
  if (asOfNext) asOfNext.disabled = index < 0 || index >= workingDays.length - 1;
  // The company graph is not yet read by date: while looking at a past day it is not offered.
  if (companyGraphLink) companyGraphLink.hidden = Boolean(day);
  document.body.classList.toggle("viewing-past", Boolean(day));
  writeDayToAddress(day);
  loadTodayPanel();
  if (gapsAvailable) loadGaps();
}

/**
 * The picker's own choice. A day inside the record snaps to its working day;
 * the last working day is the present. Moving the day away from an open
 * conversation is the assistant's own concern (see `setPlateDayChangeHandler`).
 */
function chooseDay(requested) {
  if (!workingDays.length) return;
  const snapped = workingDayFor(requested);
  if (requested && !snapped) {
    if (typeof showModelNotice === "function") {
      showModelNotice(`Pick a day from ${formatDay(workingDays[0])} to ${formatDay(workingDays[workingDays.length - 1])}.`);
    }
    showDay(viewDay);
    return;
  }
  const day = snapped && snapped !== workingDays[workingDays.length - 1] ? snapped : null;
  if (day === viewDay) {
    showDay(day);
    return;
  }
  plateDayChangeHandler();
  showDay(day);
}

asOfInput?.addEventListener("change", () => chooseDay(asOfInput.value || null));
asOfPrev?.addEventListener("click", () => {
  const index = workingDays.indexOf(asOfInput.value);
  if (index > 0) chooseDay(workingDays[index - 1]);
});
asOfNext?.addEventListener("click", () => {
  const index = workingDays.indexOf(asOfInput.value);
  if (index >= 0 && index < workingDays.length - 1) chooseDay(workingDays[index + 1]);
});
asOfNow?.addEventListener("click", () => chooseDay(null));

/** Opening a conversation shows the day it was asked on. */
function showConversationDay(day) {
  if (!workingDays.length) return;
  const known = day && workingDays.includes(day) ? day : null;
  if (known !== viewDay) showDay(known);
}

function setTodayPanelOpen(open, remember = true) {
  if (!todayPanel) return;
  todayPanel.hidden = !open;
  todayToggle?.setAttribute("aria-pressed", String(open));
  document.body.classList.toggle("today-open", open);
  if (remember) {
    try {
      localStorage.setItem("sme_today_panel", open ? "open" : "closed");
    } catch (_) {
      // not remembered this time
    }
  }
}

todayToggle?.addEventListener("click", () => setTodayPanelOpen(todayPanel.hidden));
document.querySelector("#today-close")?.addEventListener("click", () => setTodayPanelOpen(false));

const TODO_GROUPS = [
  { match: (item) => item.relation === "assignee" && item.status === "In Progress" },
  { state: "in review", match: (item) => item.relation === "assignee" && item.status === "In Review" },
  { folded: "not started", match: (item) => item.relation === "assignee" && item.status !== "In Progress" && item.status !== "In Review" },
  { folded: "raised by you", match: (item) => item.relation === "reporter" },
];

const ACTIVITY_LABELS = {
  deep_work: "Focus work",
  design_discussion: "Design discussion",
  async_question: "Question",
  "1on1": "1:1",
  mentoring: "Mentoring",
  code_review: "Code review",
  meeting: "Meeting",
};

function activityLabel(type) {
  if (!type) return "";
  return ACTIVITY_LABELS[type] ?? type.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase());
}

function hoursLabel(hours) {
  if (typeof hours !== "number") return "";
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

function renderTodo(items) {
  todoList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "today-empty";
    empty.textContent = "Nothing open on your list.";
    todoList.appendChild(empty);
    return;
  }
  // The work in hand is listed, one row each; what has not started and what
  // you raised for others wait behind one quiet line right under it. Each
  // opens below that line and closes again from the same button.
  const list = document.createElement("ul");
  const folded = [];
  for (const group of TODO_GROUPS) {
    const members = items.filter(group.match);
    if (!members.length) continue;
    const target = group.folded ? document.createElement("ul") : list;
    for (const item of members) {
      const row = document.createElement("li");
      const citable = Boolean(item.sources?.includes(item.itemKey) && plateSourceHandler);
      const open = document.createElement(citable ? "button" : "div");
      open.className = "todo-item";
      if (citable) {
        open.type = "button";
        open.title = `Open ${item.itemKey}`;
        open.addEventListener("click", () => plateSourceHandler(item.itemKey));
      }
      const key = document.createElement("span");
      key.className = "todo-key";
      key.textContent = item.itemKey;
      const title = document.createElement("span");
      title.className = "todo-title";
      title.textContent = item.title || item.itemKey;
      const facts = document.createElement("span");
      facts.className = "todo-facts";
      facts.textContent = [
        typeof item.points === "number" ? `${item.points} pt` : "",
        item.sprintNo ? `Sprint ${item.sprintNo}` : "",
        item.since ? `since ${formatDay(item.since)}` : "",
      ].filter(Boolean).join(" · ");
      open.append(key, title, facts);
      if (group.state) {
        const state = document.createElement("span");
        state.className = "todo-state";
        state.textContent = group.state;
        open.appendChild(state);
      }
      row.appendChild(open);
      row.hidden = Boolean(group.folded);
      target.appendChild(row);
    }
    if (group.folded) folded.push({ name: group.folded, count: members.length, list: target, open: false });
  }
  todoList.appendChild(list);
  if (!folded.length) return;
  const rest = document.createElement("p");
  rest.className = "todo-rest";
  const drawRest = () => {
    rest.replaceChildren();
    folded.forEach((fold, index) => {
      if (index > 0) rest.append(" · ");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = fold.open ? `hide ${fold.name}` : `${fold.count} ${fold.name}`;
      button.setAttribute("aria-expanded", String(fold.open));
      button.addEventListener("click", () => {
        fold.open = !fold.open;
        fold.list.querySelectorAll("li").forEach((row) => { row.hidden = !fold.open; });
        drawRest();
      });
      rest.appendChild(button);
    });
  };
  drawRest();
  todoList.appendChild(rest);
  for (const fold of folded) todoList.appendChild(fold.list);
}

function renderPlan(entries) {
  planList.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("li");
    empty.className = "today-empty";
    empty.textContent = "No plan recorded for this day.";
    planList.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("li");
    row.className = entry.deferred ? "plan-item deferred" : "plan-item";
    const title = document.createElement("span");
    title.className = "plan-title";
    title.textContent = entry.title;
    const facts = document.createElement("span");
    facts.className = "plan-facts";
    facts.textContent = [
      activityLabel(entry.activityType),
      hoursLabel(entry.estHours),
      entry.collaborators?.length ? `with ${entry.collaborators.join(", ")}` : "",
      entry.itemKey || "",
    ].filter(Boolean).join(" · ");
    row.append(title, facts);
    if (entry.deferred) {
      const note = document.createElement("span");
      note.className = "plan-deferred";
      note.textContent = entry.deferReason ? `Deferred: ${entry.deferReason}` : "Deferred";
      row.appendChild(note);
    }
    planList.appendChild(row);
  }
}

function showPanelMessage(text) {
  const note = document.createElement("p");
  note.className = "today-empty";
  note.textContent = text;
  todoList.replaceChildren(note);
  planList.replaceChildren();
}

/** Fetches the list and plan for the day on screen; anything older is discarded. */
async function loadTodayPanel() {
  if (!todayPanel || !workingDays.length) return;
  const epoch = plannerEpoch;
  const day = viewDay ?? workingDays[workingDays.length - 1];
  // The record ends before today, so its day is named even when it is the present.
  todayDate.textContent = `As of ${formatDay(day)}`;
  document.querySelector("#today-title").textContent = viewDay ? "That day" : "Today";
  todoList.setAttribute("aria-busy", "true");
  // The old day's lists must not linger under the new day's heading.
  showPanelMessage("Loading…");
  try {
    const query = `asOf=${encodeURIComponent(day)}`;
    const [todo, plan] = await Promise.all([
      fetch(`/api/v1/planner/todo?${query}`, { credentials: "same-origin" }),
      fetch(`/api/v1/planner/day?${query}`, { credentials: "same-origin" }),
    ]);
    if (epoch !== plannerEpoch) return;
    if (todo.status === 401 || plan.status === 401) {
      plateAuthRequiredHandler();
      return;
    }
    if (!todo.ok || !plan.ok) throw new Error("planner");
    const [todoBody, planBody] = await Promise.all([todo.json(), plan.json()]);
    if (epoch !== plannerEpoch) return;
    renderTodo(todoBody.items ?? []);
    renderPlan(planBody.entries ?? []);
  } catch (_) {
    if (epoch === plannerEpoch) showPanelMessage("Could not load your list for this day.");
  } finally {
    if (epoch === plannerEpoch) todoList.removeAttribute("aria-busy");
  }
}

// ---------------------------------------------------------------------------
// Knowledge gaps: company-wide hiring proposals on the plate
// ---------------------------------------------------------------------------
//
// These follow the selected day, but are deliberately separate from the
// employee's own plan. Opening a role drafts it in Hiring; it never searches
// for or contacts anyone from this plate.

const gapsPanel = document.querySelector("#gaps-panel");
const gapsCount = document.querySelector("#gaps-count");
const gapsNotice = document.querySelector("#gaps-notice");
const proposalList = document.querySelector("#proposal-list");
const healthDetails = document.querySelector("#health-details");
const healthRows = document.querySelector("#health-rows");
let gapsAvailable = false;
let gapsEpoch = 0;

const GAP_RULE_LABELS = {
  orphaned: "No owner",
  thin: "Few people on it",
  overloaded: "Owner stretched",
};

function gapsDay() {
  return viewDay ?? workingDays[workingDays.length - 1];
}

function showGapsNotice(message = "") {
  if (!gapsNotice) return;
  gapsNotice.hidden = !message;
  gapsNotice.textContent = message;
}

function proposalCard(proposal, canOpenRoles) {
  const card = document.createElement("article");
  card.className = `proposal-card ${proposal.status}`;
  card.dataset.proposalId = proposal.id;

  const head = document.createElement("div");
  head.className = "proposal-head";
  const title = document.createElement("h3");
  title.textContent = proposal.name ?? proposal.domain ?? "Untitled domain";
  const status = document.createElement("span");
  status.className = `proposal-status ${proposal.status}`;
  status.textContent = proposal.status === "role_opened"
    ? "Role opened"
    : proposal.status === "dismissed"
      ? "Dismissed"
      : `Open since ${formatDay(proposal.openedOn)}`;
  head.append(title, status);

  const rules = document.createElement("div");
  rules.className = "proposal-rules";
  for (const reason of proposal.reasons ?? []) {
    const chip = document.createElement("span");
    chip.className = `rule-chip ${reason.rule}`;
    chip.textContent = GAP_RULE_LABELS[reason.rule] ?? reason.rule;
    rules.appendChild(chip);
  }

  const reasons = document.createElement("ul");
  reasons.className = "proposal-reasons";
  for (const reason of proposal.reasons ?? []) {
    const item = document.createElement("li");
    item.textContent = reason.text;
    reasons.appendChild(item);
  }

  const role = document.createElement("p");
  role.className = "proposal-role";
  role.textContent = `Suggested role: ${proposal.suggestedTitle}`;
  card.append(head, rules, reasons, role);

  if (proposal.evidence?.length) {
    const evidence = document.createElement("div");
    evidence.className = "proposal-evidence";
    evidence.setAttribute("aria-label", "Evidence");
    for (const sourceId of proposal.evidence.slice(0, 6)) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "evidence-chip";
      chip.textContent = sourceId;
      chip.title = plateSourceHandler ? `Open ${sourceId}` : sourceId;
      chip.disabled = !plateSourceHandler;
      chip.addEventListener("click", () => plateSourceHandler?.(sourceId));
      evidence.appendChild(chip);
    }
    if (proposal.evidence.length > 6) {
      const more = document.createElement("span");
      more.className = "evidence-more";
      more.textContent = `+${proposal.evidence.length - 6}`;
      evidence.appendChild(more);
    }
    card.appendChild(evidence);
  }

  const actions = document.createElement("div");
  actions.className = "proposal-actions";
  if (proposal.status === "role_opened" && proposal.roleId) {
    const link = document.createElement("a");
    link.className = "proposal-link";
    link.href = `/recruiting?role=${encodeURIComponent(proposal.roleId)}`;
    link.textContent = "See the role in Hiring";
    actions.appendChild(link);
  } else if (proposal.status === "open") {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "proposal-open";
    open.textContent = "Open role";
    open.disabled = !canOpenRoles;
    open.title = canOpenRoles
      ? "Drafts the role in Hiring. Its criteria wait for someone to confirm them; nobody is searched or contacted yet."
      : "Hiring is not set up here.";
    open.addEventListener("click", () => actOnProposal(proposal, "open-role", open));
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "proposal-dismiss";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => actOnProposal(proposal, "dismiss", dismiss));
    actions.append(open, dismiss);
  }
  if (actions.children.length) card.appendChild(actions);
  return card;
}

async function actOnProposal(proposal, action, button) {
  const epoch = gapsEpoch;
  button.disabled = true;
  showGapsNotice();
  try {
    const response = await fetch(`/api/v1/gaps/proposals/${encodeURIComponent(proposal.id)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ asOf: gapsDay() }),
    });
    if (response.status === 401) {
      plateAuthRequiredHandler();
      return;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || "That did not work.");
    }
    if (epoch === gapsEpoch) await loadGaps();
  } catch (error) {
    button.disabled = false;
    showGapsNotice(error instanceof Error ? error.message : "That did not work.");
  }
}

function renderProposals(proposals, canOpenRoles) {
  if (!proposalList) return;
  proposalList.replaceChildren();
  const order = { open: 0, role_opened: 1, dismissed: 2 };
  const sorted = [...proposals].sort((a, b) =>
    (order[a.status] ?? 3) - (order[b.status] ?? 3) || String(a.openedOn).localeCompare(String(b.openedOn)),
  );
  const open = sorted.filter((proposal) => proposal.status === "open");
  if (gapsCount) {
    gapsCount.hidden = open.length === 0;
    gapsCount.textContent = String(open.length);
  }
  if (!sorted.length) {
    const empty = document.createElement("p");
    empty.className = "today-empty";
    empty.textContent = "No domain looks at risk on this day.";
    proposalList.appendChild(empty);
    return;
  }
  for (const proposal of sorted.filter((item) => item.status !== "dismissed")) {
    proposalList.appendChild(proposalCard(proposal, canOpenRoles));
  }
  const dismissed = sorted.filter((item) => item.status === "dismissed");
  if (dismissed.length) {
    const fold = document.createElement("details");
    fold.className = "proposal-dismissed";
    const summary = document.createElement("summary");
    summary.textContent = `Dismissed · ${dismissed.length}`;
    fold.appendChild(summary);
    for (const proposal of dismissed) fold.appendChild(proposalCard(proposal, canOpenRoles));
    proposalList.appendChild(fold);
  }
}

function renderHealth(domains) {
  if (!healthRows) return;
  healthRows.replaceChildren();
  for (const domain of domains) {
    const row = document.createElement("tr");
    if (!domain.ownerActive) row.className = "orphaned";
    const cells = [
      domain.name,
      domain.owner ? (domain.ownerActive ? domain.owner : `${domain.owner} (left)`) : "—",
      domain.owner ? String(domain.ownerLoad) : "—",
      String(domain.activeContributors30d?.length ?? 0),
      String(domain.incidents30d?.length ?? 0),
    ];
    cells.forEach((text, index) => {
      const cell = document.createElement(index === 0 ? "th" : "td");
      if (index === 0) cell.scope = "row";
      cell.textContent = text;
      row.appendChild(cell);
    });
    healthRows.appendChild(row);
  }
}

async function loadGaps() {
  if (!gapsAvailable || !proposalList) return;
  const epoch = ++gapsEpoch;
  const query = `asOf=${encodeURIComponent(gapsDay())}`;
  showGapsNotice();
  try {
    const [proposals, health] = await Promise.all([
      fetch(`/api/v1/gaps/proposals?${query}`, { credentials: "same-origin" }),
      fetch(`/api/v1/gaps/health?${query}`, { credentials: "same-origin" }),
    ]);
    if (epoch !== gapsEpoch) return;
    if (proposals.status === 401) {
      plateAuthRequiredHandler();
      return;
    }
    if (proposals.status === 503) {
      gapsAvailable = false;
      if (gapsPanel) gapsPanel.hidden = true;
      return;
    }
    if (!proposals.ok) throw new Error("Could not load the proposals for this day.");
    const body = await proposals.json();
    if (epoch !== gapsEpoch) return;
    renderProposals(body.proposals ?? [], Boolean(body.canOpenRoles));
    if (health.ok) {
      const healthBody = await health.json();
      if (epoch === gapsEpoch) renderHealth(healthBody.domains ?? []);
    } else if (healthDetails) {
      healthDetails.hidden = true;
    }
  } catch (error) {
    if (epoch !== gapsEpoch) return;
    proposalList.replaceChildren();
    showGapsNotice(error instanceof Error ? error.message : "Could not load the proposals for this day.");
  }
}

async function initGaps() {
  if (!gapsPanel || !workingDays.length) return;
  try {
    const response = await fetch(`/api/v1/gaps/proposals?asOf=${encodeURIComponent(gapsDay())}`, { credentials: "same-origin" });
    if (response.status === 401) {
      plateAuthRequiredHandler();
      return;
    }
    gapsAvailable = response.ok;
  } catch (_) {
    gapsAvailable = false;
  }
  gapsPanel.hidden = !gapsAvailable;
  if (gapsAvailable) await loadGaps();
}

/** After sign-in: the days to choose from, then the day in the address. */
async function initPlanner() {
  try {
    const response = await fetch("/api/v1/planner/days", { credentials: "same-origin" });
    if (!response.ok) return;
    const body = await response.json();
    workingDays = Array.isArray(body.days) ? body.days : [];
  } catch (_) {
    return;
  }
  if (!workingDays.length) return;
  if (asOfInput) {
    asOfInput.min = workingDays[0];
    asOfInput.max = workingDays[workingDays.length - 1];
  }
  if (asOfGroup) asOfGroup.hidden = false;
  if (todayToggle) todayToggle.hidden = false;
  const requested = requestedDayFromAddress();
  const snapped = workingDayFor(requested);
  const day = snapped && snapped !== workingDays[workingDays.length - 1] ? snapped : null;
  // On the plate, tickets and plan are always shown where there is a planner.
  setTodayPanelOpen(true, false);
  showDay(day);
  await initGaps();
}

// ---------------------------------------------------------------------------
// Home: what needs you, gathered from your meetings
// ---------------------------------------------------------------------------

/** The sample meeting that explains the product; listed, but its drafts are not work. */
const TOUR_MEETING_ID = "product-tour";
/** Numbers plate/home fetches; only the latest one's rows are drawn. */
let homeRequest = 0;

function isTourMeeting(meetingId) {
  return meetingId === TOUR_MEETING_ID;
}

/** Whether `asked` is still the most recent loadPlateNeeds call; a page that
 * writes more from what it found (the assistant's own home) checks this
 * before drawing something a newer call has since superseded. */
function isLatestHomeRequest(asked) {
  return asked === homeRequest;
}

const HOME_KINDS = {
  email_draft: ["Email", "mail"],
  ticket_draft: ["Ticket", "ticket"],
  calendar_draft: ["Calendar invite", "calendar"],
  message_draft: ["Message", "message"],
  doc_draft: ["Document", "doc"],
  sheet_draft: ["Sheet", "doc"],
  hiring_request: ["Hiring request", "people"],
  escalation: ["Someone else's call", "hand"],
  answer_question: ["Answered", "book"],
  flag_conflict: ["Heads up", "alert"],
};

/** A title without the kind the icon already shows ("Email: ", "Escalation:
 * Approval required: "). */
function taskTitle(title) {
  // A model sometimes writes the kind twice ("Escalation: Escalation: …"); take off every one.
  const KIND = /^(email|ticket|calendar|hiring|escalation|answer|message|doc|document|sheet|heads up|conflict|approval required)\s*:\s*/i;
  let plain = String(title || "").trim();
  while (KIND.test(plain)) plain = plain.replace(KIND, "");
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

/**
 * What waits on someone else, one row per person who decides: the same ask
 * comes up again in later meetings, and a list that repeats it reads as noise.
 * The most recent ask names the row; the rest are counted.
 */
function groupWaiting(waiting) {
  const groups = new Map();
  for (const item of waiting) {
    const who = item.action.payload?.requiredApprover || taskTitle(item.action.title);
    const group = groups.get(who) ?? [];
    group.push(item);
    groups.set(who, group);
  }
  const latest = (item) => String(item.action.createdAt || item.meeting.startedAt || "");
  return [...groups.values()]
    .map((items) => {
      const sorted = [...items].sort((a, b) => latest(b).localeCompare(latest(a)));
      return { ...sorted[0], asks: items.length, meetingCount: new Set(items.map((item) => item.meeting.meetingId)).size };
    })
    .sort((a, b) => latest(b).localeCompare(latest(a)));
}

function homeTask({ action, meeting, asks = 1, meetingCount = 1 }, part, oneMeeting = false) {
  const [kindLabel, icon] = HOME_KINDS[action.kind] ?? ["Action", "check"];
  const row = document.createElement("a");
  row.className = `task ${part}`;
  row.href = `/meetings/${encodeURIComponent(meeting.meetingId)}`;
  // One short line: what it is, a tag when something is missing or someone
  // else decides, and the meeting it came from. The words and who said them
  // are in the meeting.
  let tag = "";
  if (part === "needs" && Array.isArray(action.missing) && action.missing.length > 0) {
    tag = `<span class="task-tag need" title="${escapeHtml(action.missing[0])}">Needs input</span>`;
  }
  if (part === "waiting" && action.payload?.requiredApprover) {
    tag = `<span class="task-tag waiting" title="${escapeHtml(action.payload.reason ?? "")}">${escapeHtml(action.payload.requiredApprover)}</span>`;
  }
  if (asks > 1) {
    tag += `<span class="task-count" title="${asks} asks from ${meetingCount} ${meetingCount === 1 ? "meeting" : "meetings"}">×${asks}</span>`;
  }
  const go = part === "needs" ? '<span class="task-go">Review</span>' : lineIcon("chevron", 14);
  row.innerHTML = `
    <span class="task-icon ${part}" title="${escapeHtml(kindLabel)}">${lineIcon(icon, 14)}</span>
    <span class="task-title">${escapeHtml(taskTitle(action.title))}</span>${tag}
    <span class="task-from"${oneMeeting ? " hidden" : ""}>${escapeHtml(meeting.title)}</span>${go}`;
  return row;
}

/** "4 need you · 1 waiting": what needs you and what waits on others, in one line; empty when neither. */
function plateSummary(needs, waiting) {
  const parts = [];
  if (needs.length) parts.push(`${needs.length} ${needs.length === 1 ? "needs" : "need"} you`);
  if (waiting.length) parts.push(`${waiting.length} waiting`);
  return parts.join(" · ");
}

function fillHomeGroup(id, items, part, oneMeeting = false) {
  const group = document.querySelector(id);
  if (!group) return;
  group.hidden = items.length === 0;
  group.querySelector(".count").textContent = String(items.length);
  const list = group.querySelector(".tasks");
  list.replaceChildren(...items.map((item) => homeTask(item, part, oneMeeting)));
}

/**
 * Fetches the day's meetings and their actions, and fills the plate's "Needs
 * you" and "Waiting on others" groups. Returns what it found (`meetings`,
 * `needs`, `waiting`, `done`, and the request's own id in `asked`, so a
 * caller with more to show - the assistant's own home - can build on it
 * without asking again); null when the fetch itself found nothing, or a
 * newer call has since started.
 */
async function loadPlateNeeds() {
  const asked = ++homeRequest;
  let meetings = [];
  try {
    const response = await fetch("/api/v1/meetings", { credentials: "same-origin" });
    if (response.ok) meetings = await response.json();
  } catch (_) {
    // The plate shows nothing needing you; the rest of the page still works.
  }
  if (asked !== homeRequest || !Array.isArray(meetings)) return null;
  meetings = [...meetings].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

  const withWork = meetings.filter((meeting) => meeting.meetingId !== TOUR_MEETING_ID && meeting.actionCount !== 0).slice(0, 8);
  const states = await Promise.all(withWork.map((meeting) =>
    fetch(`/api/v1/meetings/${encodeURIComponent(meeting.meetingId)}`, { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)));
  if (asked !== homeRequest) return null;

  const needs = [];
  const waiting = [];
  const done = [];
  states.forEach((state, index) => {
    if (!state || !Array.isArray(state.actions)) return;
    const meeting = withWork[index];
    for (const action of state.actions) {
      const item = { action, meeting };
      if (action.tier === "approval" && action.status === "proposed") needs.push(item);
      else if (action.status === "escalated") waiting.push(item);
      else if (action.status === "executed") done.push(item);
    }
  });
  // Everything from one meeting: a headline that names it does not need the rows to repeat it.
  const oneMeeting = new Set([...needs, ...waiting, ...done].map((item) => item.meeting.meetingId)).size <= 1;
  fillHomeGroup("#home-needs", needs, "needs", oneMeeting);
  const waitingGroups = groupWaiting(waiting);
  fillHomeGroup("#home-waiting", waitingGroups, "waiting", oneMeeting);
  // Away from the home, which lists them in full, the plate sums them up in one line that leads there.
  const summary = document.querySelector("#plate-summary");
  if (summary) {
    summary.textContent = plateSummary(needs, waitingGroups);
    summary.hidden = summary.textContent === "";
  }
  return { asked, meetings, needs, waiting: waitingGroups, done, oneMeeting };
}
