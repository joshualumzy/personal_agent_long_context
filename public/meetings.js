"use strict";

// Every string that came from a transcript, a model, or a profile is
// untrusted, so this page only ever builds nodes and sets textContent
// (via the `h` helper below). It never assigns innerHTML.

const $ = (selector) => document.querySelector(selector);

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

const KIND_LABELS = {
  answer_question: "Answered question",
  flag_conflict: "Conflict flag",
  email_draft: "Email",
  hiring_request: "Hiring request",
  ticket_draft: "Ticket",
  calendar_draft: "Calendar invite",
  message_draft: "Chat message",
  doc_draft: "New document",
  sheet_draft: "New spreadsheet",
  blocked: "Blocked",
};

// Answers and conflicts are the only kinds done without you, and they are in the notes.
const TIERS = ["approval", "blocked"];

// Fields a human can change before approving. Only kinds that change the
// world (tier "approval") get edit controls; the rest render read-only.
// Fields a human can change before approving, and where each sits in the
// draft: "title" and "body" are bare text like a document, "row" is a
// labelled line like a mail header, "chip" is a small property below.
const EDITABLE_FIELDS = {
  email_draft: [
    { key: "to", label: "To", type: "text", layout: "row" },
    { key: "subject", label: "Subject", type: "text", layout: "row" },
    { key: "body", label: "Message", type: "textarea", layout: "body" },
  ],
  ticket_draft: [
    { key: "title", label: "Ticket title", type: "text", layout: "title" },
    { key: "description", label: "Add a description", type: "textarea", layout: "body" },
    { key: "assignee", label: "Assignee", type: "text", layout: "chip" },
    { key: "due", label: "Due", type: "text", layout: "chip" },
  ],
  calendar_draft: [
    { key: "title", label: "Event title", type: "text", layout: "title" },
    { key: "attendees", label: "Guests", type: "list", layout: "chip" },
    { key: "proposedStart", label: "Starts", type: "text", layout: "chip" },
    { key: "durationMinutes", label: "Minutes", type: "number", layout: "chip" },
  ],
  message_draft: [
    { key: "recipient", label: "To", type: "text", layout: "row" },
    { key: "address", label: "Phone or email", type: "text", layout: "row" },
    { key: "text", label: "Message", type: "textarea", layout: "body" },
  ],
  doc_draft: [
    { key: "title", label: "Document title", type: "text", layout: "title" },
    { key: "body", label: "Draft (Markdown)", type: "textarea", layout: "body" },
  ],
  sheet_draft: [
    { key: "title", label: "Spreadsheet title", type: "text", layout: "title" },
    { key: "rows", label: "Rows, one per line, cells separated by |", type: "table", layout: "body" },
  ],
  hiring_request: [{ key: "requirement", label: "Requirement", type: "textarea", layout: "body" }],
};

const READONLY_FIELDS = {
  // The quoted line above the fields already shows the question.
  answer_question: [["answer", "Answer"]],
  flag_conflict: [
    ["statement", "Statement"],
    ["priorDecision", "Prior decision"],
    ["explanation", "Why this conflicts"],
  ],
  blocked: [["reason", "Reason"]],
  message_draft: [
    ["recipient", "To"],
    ["text", "Message"],
  ],
  doc_draft: [
    ["title", "Title"],
    ["body", "Draft"],
  ],
  sheet_draft: [
    ["title", "Title"],
    ["rows", "Table"],
  ],
};

const state = {
  google: null, // { connected, calendar, connectUrl } once loaded; null when Google is not configured
  meetings: [],
  replays: [],
  current: null, // MeetingState, filled in once the "snapshot" SSE event arrives
  source: null, // EventSource
  selectedActionId: null,
  streams: {}, // answers being written, by the transcript line that asked
  thoughts: {}, // what the agent said between searches, kept folded on the finished answer
};

// actionId -> { values: payload-in-progress, dirty: boolean }. Cleared
// whenever a fresh copy of the action arrives from the server, so an edit
// always starts from what is actually on record.
const editDrafts = new Map();

// actionId -> handoff status line, kept outside the cards because a card is
// rebuilt whenever a fresh copy of its action arrives.
const handoffStatus = new Map();

// -------------------------------------------------------------- networking

function showError(message) {
  const banner = $("#error");
  banner.textContent = message;
  banner.hidden = !message;
}

async function getJSON(path) {
  const response = await fetch(path);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Something went wrong.");
  return data;
}

async function postJSON(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Something went wrong.");
  return data;
}

// ------------------------------------------------------------------ picker

async function loadMeetingList() {
  try {
    state.meetings = await getJSON("/api/v1/meetings");
  } catch (error) {
    showError(error.message);
    state.meetings = [];
  }
  renderMeetingList();
}

async function loadReplayList() {
  try {
    state.replays = await getJSON("/api/v1/meetings/replays");
  } catch {
    state.replays = [];
  }
  renderReplaySelect();
}

function renderMeetingList() {
  const list = $("#meeting-list");
  list.replaceChildren();
  if (state.meetings.length === 0) {
    list.append(h("li", { class: "empty-note" }, "No meetings yet."));
    return;
  }
  for (const meeting of state.meetings) {
    list.append(
      h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            class: state.current?.meetingId === meeting.meetingId ? "current" : "",
            "aria-current": state.current?.meetingId === meeting.meetingId ? "true" : undefined,
            onclick: () => openMeeting(meeting.meetingId),
          },
          meeting.status === "live" ? h("span", { class: "live-dot", title: "Live" }) : null,
          h("span", { class: "meeting-name" }, meeting.title),
        ),
      ),
    );
  }
}

function renderReplaySelect() {
  const select = $("#replay-select");
  const button = $("#replay-btn");
  select.replaceChildren();
  select.disabled = state.replays.length === 0;
  button.disabled = state.replays.length === 0;
  select.placeholder = state.replays.length ? "Choose a meeting" : "No replays found";
  for (const replay of state.replays) {
    select.append(h("sl-option", { value: replay.sourceId }, replay.title));
  }
  if (!state.replays.length) return;
  // A value set before the component and its options are ready is dropped, so set it once they are.
  const first = state.replays[0].sourceId;
  select.value = first;
  Promise.all([customElements.whenDefined("sl-select"), customElements.whenDefined("sl-option")])
    .then(() => select.updateComplete)
    .then(() => {
      if (!select.value) select.value = first;
    });
}

// ------------------------------------------------------------------ opening a meeting (SSE)

function closeStream() {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
}

function openMeeting(meetingId, { fromAddress = false } = {}) {
  document.body.classList.add("in-meeting");
  // The address names the meeting, so a refresh or a shared link comes back to it.
  const address = `/meetings/${encodeURIComponent(meetingId)}`;
  if (!fromAddress && location.pathname !== address) history.pushState({ meetingId }, "", address);
  stopRecording();
  closeStream();
  state.current = null;
  state.streams = {};
  state.thoughts = {};
  state.selectedActionId = null;
  editDrafts.clear();
  showError("");
  $("#board").hidden = false;
  $("#no-meeting").hidden = true;
  $("#tx-toggle").hidden = false;

  const source = new EventSource(`/api/v1/meetings/${encodeURIComponent(meetingId)}/events`);
  state.source = source;

  source.addEventListener("snapshot", (event) => {
    state.current = JSON.parse(event.data);
    renderMeetingList();
    renderBoard();
  });
  source.addEventListener("segments", (event) => {
    if (!state.current) return;
    const payload = JSON.parse(event.data);
    state.current.segments.push(...payload.segments);
    renderTranscript();
    renderDocMeta();
  });
  source.addEventListener("action", (event) => {
    if (!state.current) return;
    const payload = JSON.parse(event.data);
    upsertAction(payload.action);
    const index = payload.action.trigger?.segmentIndex;
    if (state.streams[index]?.steps.length) state.thoughts[index] = state.streams[index].steps;
    delete state.streams[index];
    renderActions();
    renderPending();
  });
  source.addEventListener("trace", (event) => {
    if (!state.current) return;
    const payload = JSON.parse(event.data);
    state.current.trace.push(payload.trace);
    renderTrace();
    renderPending();
  });
  source.addEventListener("meeting", (event) => {
    if (!state.current) return;
    const payload = JSON.parse(event.data);
    state.current.status = payload.status;
    renderMeetingHead();
    renderMeetingList();
  });
  // An answer being written arrives here piece by piece, before its card exists.
  source.addEventListener("answer_stream", (event) => {
    if (!state.current) return;
    const { segmentIndex, delta, status, reset } = JSON.parse(event.data);
    const stream = (state.streams[segmentIndex] ??= { text: "", status: "", steps: [] });
    // Text withdrawn mid-answer is the agent thinking aloud between searches;
    // it stays visible as a step instead of vanishing.
    if (reset) {
      if (stream.text.trim()) stream.steps.push(stream.text.trim());
      stream.text = "";
    }
    if (status) stream.status = status;
    if (delta) stream.text += delta;
    renderPending();
  });
  source.addEventListener("notes", (event) => {
    if (!state.current) return;
    const { decisions, assignments } = JSON.parse(event.data);
    state.current.decisions = decisions;
    state.current.assignments = assignments;
    renderNotes();
  });
  source.addEventListener("minutes", (event) => {
    if (!state.current) return;
    state.current.minutes = JSON.parse(event.data).minutes;
    renderMinutes();
  });
  source.addEventListener("busy", (event) => {
    const payload = JSON.parse(event.data);
    setBusy(payload.busy);
  });
  source.onerror = () => {
    // The browser retries EventSource connections on its own.
  };
}

function upsertAction(action) {
  const list = state.current.actions;
  const index = list.findIndex((candidate) => candidate.id === action.id);
  if (index === -1) list.push(action);
  else list[index] = action;
  editDrafts.delete(action.id);
}

function setBusy(busy) {
  state.busy = busy;
  $("#busy-indicator").hidden = !busy;
  renderPending();
}

// Looking something up takes 20 to 30 seconds. As soon as the agent has picked
// a line to act on, a placeholder quotes it, so the room can see it was heard.
function renderPending() {
  const box = $("#assistant-pending");
  const trace = state.current?.trace ?? [];
  let picked = null;
  for (const event of trace) {
    if (event.step === "extracted" && /Found [1-9]/.test(event.detail)) picked = event;
    else if (picked && (event.step === "drafted" || event.step === "executed" || event.step === "blocked")) picked = null;
  }
  const segments = state.current?.segments ?? [];
  const segment =
    picked &&
    (picked.segmentIndex === undefined
      ? segments.at(-1)
      : segments.find((candidate) => candidate.index === picked.segmentIndex));
  const stream = segment && state.streams[segment.index];
  box.hidden = !(state.busy && segment);
  refreshEmpty();
  if (box.hidden) return;
  box.replaceChildren(
    h(
      "div",
      { class: "pending-head" },
      h("span", { class: "busy-dot" }),
      h("span", {}, stream?.status || "Working on what was just said"),
    ),
    h("q", {}, segment.text),
  );
  for (const step of stream?.steps ?? []) box.append(h("p", { class: "thinking-step" }, step));
  // The answer so far, as the model writes it; the finished card replaces it.
  if (stream?.text) box.append(renderValue("answer", stream.text));
}

// ------------------------------------------------------------------ transcript

function renderBoard() {
  renderMeetingHead();
  renderTranscript();
  renderActions();
  renderNotes();
  renderMinutes();
  renderTrace();
  state.cardsShownFor = state.current?.meetingId;
}

function renderMeetingHead() {
  if (!state.current) return;
  $("#meeting-title-heading").textContent = state.current.title;
  $("#doc-title").textContent = state.current.title;
  $("#status-line").textContent = state.current.status === "live" ? "Live" : "Ended";
  renderDocMeta();
  for (const element of $("#live-form").elements) element.disabled = state.current.status !== "live";
  if (state.current.status !== "live" && recording.active) stopRecording();
  renderRecording();
}

// When it started and who has spoken so far, in the order they first spoke.
function renderDocMeta() {
  const current = state.current;
  const started = new Date(current.startedAt);
  const when = Number.isNaN(started.getTime())
    ? ""
    : started.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const speakers = [...new Set(current.segments.map((segment) => segment.speaker))];
  const parts = [when, speakers.length ? speakers.join(", ") : null, current.status === "live" ? "live" : "ended"];
  $("#doc-meta").textContent = parts.filter(Boolean).join(" · ");
}

function triggeredSegmentIndices() {
  const set = new Set();
  for (const action of state.current?.actions ?? []) set.add(action.trigger.segmentIndex);
  return set;
}

function renderTranscript() {
  if (!state.current) return;
  const list = $("#transcript");
  list.replaceChildren();
  const triggers = triggeredSegmentIndices();
  for (const segment of state.current.segments) {
    const speakerLine = h(
      "div",
      { class: "speaker" },
      segment.speaker,
      triggers.has(segment.index) ? h("span", { class: "trigger-marker", title: "Triggered an action" }) : null,
    );
    list.append(
      h(
        "li",
        { id: `segment-${segment.index}`, "data-index": segment.index },
        speakerLine,
        h("div", { class: "text" }, segment.text),
      ),
    );
  }
  list.scrollTop = list.scrollHeight;
}

function highlightSegment(index) {
  document.querySelectorAll(".transcript li.highlighted").forEach((el) => el.classList.remove("highlighted"));
  const el = document.getElementById(`segment-${index}`);
  if (el) {
    el.classList.add("highlighted");
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

// ------------------------------------------------------------------ approval queue

// Conflicts are what the assistant most needs you to see, so they lead,
// whatever their tier, then its answers. Handled and blocked items shrink to one line.
function renderActions() {
  if (!state.current) return;
  const actions = state.current.actions;
  // Answers are the assistant looking things up for the room, so they stay
  // open and newest first rather than folding into the handled list.
  // A call that belongs to someone above the employee has nothing for them to
  // press, so it is listed with the promises rather than a row in the tray.
  const leads = new Set(["flag_conflict", "answer_question", "escalation"]);
  const groups = {
    alerts: actions.filter((action) => action.kind === "flag_conflict"),
    answers: actions.filter((action) => action.kind === "answer_question").reverse(),
    ...Object.fromEntries(
      TIERS.map((tier) => [tier, actions.filter((action) => action.tier === tier && !leads.has(action.kind))]),
    ),
  };
  for (const [group, members] of Object.entries(groups)) {
    const container = $(`#cards-${group}`);
    container.replaceChildren(...members.map((action) => renderCard(action, group === "blocked")));
    container.closest(".tier-group").hidden = members.length === 0;
  }
  renderTray(groups);
  renderLedger();
  refreshEmpty();
  for (const action of actions) seenActions.add(action.id);
}

const seenActions = new Set();

// The agent often starts a title with its kind ("Email: ..."); the kind is
// already shown beside the title, so it is not repeated.
const TITLE_PREFIX = /^(email|ticket|calendar|invite|hiring|escalation|approval required|message|chat|doc|document|sheet|spreadsheet|answer|conflict)\s*:\s*/i;

function displayTitle(action) {
  // Prefixes can stack ("Escalation: Approval required: ..."), so peel them all.
  let title = action.title;
  while (TITLE_PREFIX.test(title)) title = title.replace(TITLE_PREFIX, "");
  return title || action.title;
}

// The tray says how many drafts wait on you; what the agent did on its own
// and what it was not allowed to do fold into counts at its foot.
function renderTray(groups) {
  const waiting = groups.approval.filter((action) => action.status === "proposed").length;
  $("#tray-title").textContent = waiting
    ? `${waiting} thing${waiting > 1 ? "s" : ""} need${waiting > 1 ? "" : "s"} you`
    : "Nothing needs you right now";
  $("#blocked-count").textContent = `Blocked · ${groups.blocked.length}`;
  $(".tray-foot").hidden = groups.blocked.length === 0 || $("#tray-toggle").getAttribute("aria-expanded") !== "true";
}

// The empty-room hint goes as soon as the assistant has anything to show.
function refreshEmpty() {
  const current = state.current;
  const shown =
    (current?.actions.length ?? 0) > 0 ||
    (current?.decisions?.length ?? 0) > 0 ||
    (current?.assignments?.length ?? 0) > 0 ||
    Boolean(current?.minutes) ||
    (current?.assignments?.length ?? 0) > 0 ||
    !$("#assistant-pending").hidden;
  $("#assistant-empty").hidden = shown;
}

// ------------------------------------------------------------------ notes and minutes

// What was decided. While the meeting runs this is the running log; once the
// minutes are written it is their final list, since a decision can be reversed
// later in the same meeting. Who took what on is in the promises above.
function renderNotes() {
  if (!state.current) return;
  const box = $("#notes");
  // Each decision leads to the line where it was settled, when that line is known.
  const item = (text, segmentIndex, speaker) =>
    Number.isInteger(segmentIndex)
      ? h(
          "li",
          {
            class: "jumps",
            tabindex: 0,
            onclick: () => highlightSegment(segmentIndex),
            onmouseenter: () => highlightSegment(segmentIndex),
          },
          text,
          speaker ? h("span", { class: "who" }, ` ${speaker}`) : null,
        )
      : h("li", {}, text);
  const minutes = state.current.minutes?.status === "ready" ? state.current.minutes : null;
  // Older minutes carry their decisions only as Markdown text.
  const fromMarkdown = minutesSection(minutes, ["Decisions", "决策"])
    ?.filter((line) => /^\s*[-*]\s+/.test(line))
    .map((line) => ({ text: line.replace(/^\s*[-*]\s+/, "") }));
  const final = minutes?.decisions ?? fromMarkdown;
  const items = final
    ? final.map((decision) => item(decision.text, decision.segmentIndex))
    : (state.current.decisions ?? []).map((decision) => item(decision.text, decision.segmentIndex, decision.speaker));
  box.replaceChildren(items.length ? h("ul", {}, items) : "");
  box.closest(".tier-group").hidden = items.length === 0;
  renderLedger();
  refreshEmpty();
}

// The bullet lines under one "## Heading" of the minutes, or null before they exist.
function minutesSection(minutes, headings) {
  if (minutes?.status !== "ready" || !minutes.markdown) return null;
  const lines = minutes.markdown.split("\n");
  const start = lines.findIndex((line) => headings.some((heading) => line.trim() === `## ${heading}`));
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    body.push(line);
  }
  return body;
}

// ------------------------------------------------------------------ promises

const PROMISE_KINDS = new Set([
  "email_draft", "ticket_draft", "calendar_draft", "message_draft", "doc_draft", "sheet_draft", "hiring_request", "escalation",
]);

/**
 * Every promise made in the meeting and where it stands: the drafts the
 * assistant wrote, the calls that belong to someone else, and the tasks people
 * took on that the assistant cannot do. This is what the meeting produced.
 */
function renderLedger() {
  if (!state.current) return;
  const actions = state.current.actions.filter((action) => PROMISE_KINDS.has(action.kind) && action.status !== "superseded");
  const covered = new Set(actions.map((action) => action.trigger.segmentIndex));
  // A task that is part of a listed draft ("I'll send the invite") is that promise, not another one.
  const keys = new Set(actions.map((action) => action.dedupeKey));
  const rows = [
    ...actions.map((action) => ({
      at: action.trigger.segmentIndex,
      who: action.trigger.speaker,
      what: displayTitle(action),
      status: promiseStatus(action),
      action,
    })),
    ...(state.current.assignments ?? [])
      .filter((entry) => !covered.has(entry.segmentIndex) && !(entry.partOf && keys.has(entry.partOf)))
      .map((entry) => ({
        at: entry.segmentIndex,
        who: entry.owner,
        what: entry.task,
        due: entry.due,
        status: { label: "Noted", tone: "noted" },
      })),
  ].sort((left, right) => left.at - right.at);

  $("#ledger-list").replaceChildren(
    ...rows.map((row) =>
      h(
        "li",
        {
          class: `promise tone-${row.status.tone}`,
          tabindex: 0,
          onclick: () => openPromise(row),
          // Pointing at a promise shows its line; clicking also opens its draft.
          onmouseenter: () => highlightSegment(row.at),
          onkeydown: (event) => {
            if (event.key === "Enter") openPromise(row);
          },
        },
        h("span", { class: "promise-who" }, row.who.replace(/\s*\(.*\)$/, "")),
        h("span", { class: "promise-what" }, row.what),
        row.due ? h("span", { class: "promise-due" }, row.due) : null,
        h("span", { class: "promise-status" }, row.status.label),
      ),
    ),
  );
  $("#ledger-list").closest(".tier-group").hidden = rows.length === 0;
}

function promiseStatus(action) {
  const missing = action.missing?.length ?? 0;
  switch (action.status) {
    case "proposed":
      return {
        label: `Draft ready for you${missing ? ` · ${missing} detail${missing > 1 ? "s" : ""} missing` : ""}`,
        tone: "waiting",
      };
    case "escalated":
      return { label: `Needs ${action.payload.requiredApprover || "someone else"}`, tone: "elsewhere" };
    case "executing":
      return { label: "Working on it", tone: "waiting" };
    case "executed":
      return { label: "Done", tone: "done" };
    case "rejected":
      return { label: "Dropped", tone: "noted" };
    case "failed":
      return { label: "Failed", tone: "failed" };
    default:
      return { label: action.status, tone: "noted" };
  }
}

// A promise shows the line it came from; a draft also opens in the tray.
function openPromise(row) {
  highlightSegment(row.at);
  if (!row.action || row.action.tier !== "approval") return;
  if ($("#tray-toggle").getAttribute("aria-expanded") !== "true") $("#tray-toggle").click();
  if (state.selectedActionId !== row.action.id) selectAction(row.action.id);
  document.querySelector(`#tray [data-action-id="${row.action.id}"]`)?.scrollIntoView({ block: "nearest" });
}

// Once written, the minutes lead the page as a sentence or two; the whole
// document is a copy or a download away in the top bar.
function renderMinutes() {
  const minutes = state.current?.minutes;
  const ready = minutes?.status === "ready";
  $("#minutes-copy").hidden = !ready;
  $("#minutes-download").hidden = !ready;
  const lead = $("#doc-lead");
  if (minutes && !ready) {
    lead.hidden = false;
    lead.classList.add("writing");
    lead.replaceChildren(
      minutes.status === "writing" ? h("span", { class: "busy-dot" }) : "",
      minutes.status === "writing" ? "Writing the minutes…" : "The minutes could not be written.",
    );
  } else {
    // A sentence or two: the promises below are the point of the page.
    const summary = (minutesSection(minutes, ["Summary", "摘要"]) ?? [])
      .filter((line) => line.trim())
      .join(" ")
      .split(/(?<=[.!?。！？])\s*/)
      .filter(Boolean)
      .slice(0, 2)
      .join(" ")
      .trim();
    lead.hidden = !summary;
    lead.classList.remove("writing");
    lead.textContent = summary;
  }
  refreshEmpty();
  if (state.current) renderNotes();
  if (!ready) return;
  const markdown = minutes.markdown ?? "";
  const copy = $("#minutes-copy");
  copy.onclick = async () => {
    await copyRich(markdown, "markdown");
    copy.title = "Copied";
  };
  const download = $("#minutes-download");
  download.download = `${state.current.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "minutes"}.md`;
  download.href = `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`;
}


function currentDraft(action) {
  if (!editDrafts.has(action.id)) {
    editDrafts.set(action.id, { values: { ...action.payload }, dirty: false });
  }
  return editDrafts.get(action.id);
}

function renderCard(action, compact = false) {
  // A card the page has not shown before is marked once, so the eye finds it.
  const fresh = state.cardsShownFor === state.current.meetingId && !seenActions.has(action.id);
  const card = h("div", {
    class: `card${action.kind === "flag_conflict" ? " conflict" : ""}${
      state.selectedActionId === action.id ? " selected" : ""
    }${compact ? " compact" : ""}${fresh ? " fresh" : ""}`,
    "data-tier": action.tier,
    "data-kind": action.kind,
    "data-status": action.status,
    "data-action-id": action.id,
  });

  card.addEventListener("click", (event) => {
    if (event.target.closest("button, input, textarea, select, details, a")) return;
    selectAction(action.id);
  });

  card.append(
    h(
      "div",
      { class: "card-head" },
      h("span", { class: "card-title", title: displayTitle(action) }, displayTitle(action)),
      h("span", { class: "kind-label" }, KIND_LABELS[action.kind] ?? action.kind),
    ),
    h(
      "button",
      {
        type: "button",
        class: "trigger-quote",
        onclick: () => {
          selectAction(action.id);
          highlightSegment(action.trigger.segmentIndex);
        },
      },
      `"${action.trigger.quote}" `,
      h("cite", {}, `— ${action.trigger.speaker}`),
    ),
  );

  const canEdit = EDITABLE_FIELDS[action.kind] && action.tier === "approval" && action.status === "proposed";
  card.append(canEdit ? renderEditableFields(action) : renderReadonlyFields(action));
  const deeper = action.kind === "answer_question" && action.payload.deeper && renderDeeper(action.payload.deeper);
  if (deeper) card.append(deeper);

  if (
    action.kind === "calendar_draft" &&
    action.status === "proposed" &&
    !action.payload.proposedStart &&
    action.payload.startOptions?.length > 1
  ) {
    card.append(renderStartOptions(action));
  }

  if (action.notes?.length && action.status === "proposed") {
    card.append(
      h(
        "div",
        { class: "checked-notes" },
        h("p", { class: "missing-head" }, "Checked for you:"),
        h("ul", {}, action.notes.map((note) => h("li", {}, note))),
      ),
    );
  }

  if (
    action.kind === "calendar_draft" &&
    action.status === "proposed" &&
    !action.notes?.length &&
    state.google &&
    !(state.google.connected && state.google.calendar)
  ) {
    card.append(
      h(
        "p",
        { class: "connect-hint" },
        "Availability not checked. ",
        h("a", { href: state.google.connectUrl }, "Allow calendar access"),
        " to check it on the next invite.",
      ),
    );
  }

  if (action.missing?.length && (action.status === "proposed" || action.status === "escalated")) {
    const [first, ...rest] = action.missing;
    card.append(
      h("p", { class: "missing-summary" }, `Still needed: ${first}${rest.length ? ` +${rest.length} more` : ""}`),
    );
    card.append(
      h(
        "div",
        { class: "missing" },
        h("p", { class: "missing-head" }, "Still needed from you (the agent looked and could not find it):"),
        h("ul", {}, action.missing.map((need) => h("li", {}, need))),
      ),
    );
  }


  if (action.kind === "hiring_request" && action.status === "proposed") {
    card.append(h("p", { class: "hiring-note" }, "Approving continues in the assistant, which opens the role and asks what it needs."));
  }

  const thoughts = action.kind === "answer_question" && state.thoughts[action.trigger.segmentIndex];
  if (thoughts) {
    card.append(
      h(
        "details",
        { class: "thinking" },
        h("summary", {}, `Thinking (${thoughts.length} step${thoughts.length > 1 ? "s" : ""})`),
        ...thoughts.map((step) => h("p", { class: "thinking-step" }, step)),
      ),
    );
  }
  if (action.evidence.length > 0) card.append(renderEvidence(action.evidence));

  if (action.status === "executed" && action.result) {
    card.append(
      h(
        "p",
        { class: "result-summary" },
        action.result.summary,
        action.result.simulated ? h("span", { class: "badge simulated" }, "simulated") : null,
      ),
    );
    if (action.result.handoffUrl) card.append(renderHandoff(action));
  }
  if (action.status === "rejected") {
    card.append(
      h(
        "p",
        { class: "result-summary" },
        h("span", { class: "badge rejected" }, "rejected"),
        action.error ? ` ${action.error}` : "",
      ),
    );
  }
  if (action.status === "failed" && action.error) {
    card.append(h("p", { class: "result-summary" }, `Failed: ${action.error}`));
  }

  if (action.version > 1 && action.status === "proposed") {
    card.append(h("p", { class: "version-note" }, `v${action.version} — review again`));
  }

  if (action.tier === "approval" && action.status === "proposed") card.append(renderApprovalButtons(action));

  return card;
}

/**
 * The approved action opens in the employee's own, signed-in tool; their
 * click there is what sends or saves it. A document draft goes to the
 * clipboard first, since no editor accepts body text in a link. Calendar
 * invites also offer an .ics file for any other calendar app.
 */
/**
 * Copies a draft as formatted HTML and as plain text together, so a paste
 * into Google Docs or Word gives real headings and lists, and a paste into
 * Sheets or Excel fills cells. Plain text alone left Markdown symbols in
 * Docs. The HTML is sanitised; the draft came from a model.
 */
async function copyRich(text, format) {
  const escape = (value) => value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  let html = null;
  if (format === "table") {
    const rows = text.split("\n").map((line) => line.split("\t"));
    html = `<table>${rows
      .map((row, index) => `<tr>${row.map((cell) => (index === 0 ? `<th>${escape(cell)}</th>` : `<td>${escape(cell)}</td>`)).join("")}</tr>`)
      .join("")}</table>`;
  } else if (window.marked && window.DOMPurify) {
    html = window.DOMPurify.sanitize(window.marked.parse(text));
  }
  if (html && window.ClipboardItem && navigator.clipboard.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(text);
}

// The arrow on links that open another app, drawn like the page's other line icons.
function externalIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: 12, height: 12, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "external-icon" })) {
    svg.setAttribute(key, String(value));
  }
  for (const d of ["M7 17 17 7", "M7 7h10v10"]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function renderHandoff(action) {
  const { handoffUrl, handoffCopy } = action.result;
  const status = h("span", { class: "handoff-status" }, handoffStatus.get(action.id) ?? "");
  const setStatus = (message) => {
    handoffStatus.set(action.id, message);
    status.textContent = message;
  };
  // A role in Recruiting is part of this app, so it opens here; everything else is another tool.
  const inApp = handoffUrl.startsWith("/");
  const open = h(
    "a",
    {
      href: handoffUrl,
      target: inApp ? undefined : "_blank",
      rel: inApp ? undefined : "noopener",
      onclick: handoffCopy
        ? () => {
            // The write lands at once, but its promise can stay pending while
            // the window is in the background, so report success up front and
            // only correct it on failure.
            setStatus(
              action.kind === "sheet_draft"
                ? "Table copied. Click cell A1 in the new spreadsheet and paste."
                : "Draft copied. Paste it into the new document.",
            );
            copyRich(handoffCopy, action.kind === "sheet_draft" ? "table" : "markdown").catch(() =>
              setStatus("Could not copy; select the draft above instead."),
            );
          }
        : undefined,
    },
    action.kind === "hiring_request"
      ? "Continue in the assistant"
      : action.kind === "sheet_draft"
      ? "Copy table and open a blank spreadsheet"
      : handoffCopy
        ? "Copy draft and open a blank document"
        : "Open to confirm",
  );
  open.append(externalIcon());
  if (action.kind === "hiring_request") {
    // The assistant opens the role and asks what it needs; the requirement goes
    // over in this tab's storage, so no outside link can start a chat for someone.
    open.addEventListener("click", () => {
      const message = `We need to hire: ${action.payload.requirement}. This came up in the meeting "${state.current.title}".`;
      sessionStorage.setItem("assistant-handoff", JSON.stringify({ message, at: Date.now() }));
    });
  }
  const row = h("p", { class: "handoff" }, open);
  if (action.kind === "calendar_draft") {
    row.append(" \u00b7 ", h("a", { href: icsDataUrl(action.payload), download: "invite.ics" }, "Download .ics"));
  }
  row.append(status);
  return row;
}

/** A minimal iCalendar file, for calendar apps with no prefilled-link support. */
function icsDataUrl(payload) {
  const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const escape = (value) => String(value).replace(/([\\;,])/g, "\\$1").replace(/\n/g, "\\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//meeting-actions//EN",
    "BEGIN:VEVENT",
    `UID:${crypto.randomUUID()}`,
    `DTSTAMP:${stamp(new Date())}`,
    `SUMMARY:${escape(payload.title)}`,
  ];
  const start = payload.proposedStart ? new Date(payload.proposedStart) : null;
  if (start && !Number.isNaN(start.getTime())) {
    lines.push(`DTSTART:${stamp(start)}`, `DTEND:${stamp(new Date(start.getTime() + payload.durationMinutes * 60000))}`);
  }
  if (payload.notes) lines.push(`DESCRIPTION:${escape(payload.notes)}`);
  for (const attendee of payload.attendees) {
    if (attendee.includes("@")) lines.push(`ATTENDEE:mailto:${attendee}`);
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(lines.join("\r\n"))}`;
}

/**
 * The words fitted more than one day, so the agent did not pick: one button
 * per candidate. A candidate with a time becomes the invite's start (a new
 * version, approved as usual); a date alone goes into the start field for
 * the employee to add the time.
 */
function renderStartOptions(action) {
  const label = (option) => {
    const date = new Date(`${option.slice(0, 10)}T00:00:00Z`);
    const day = date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    return option.includes("T") ? `${day}, ${option.slice(11, 16)}` : day;
  };
  const pick = async (option) => {
    const { startOptions: _unused, ...rest } = action.payload;
    if (!option.includes("T")) {
      const draft = currentDraft(action);
      draft.values = { ...draft.values, proposedStart: `${option}T` };
      draft.dirty = true;
      renderActions();
      return;
    }
    try {
      const updated = await postJSON(`/api/v1/meetings/${state.current.meetingId}/actions/${action.id}/edit`, {
        payload: { ...rest, proposedStart: option },
      });
      upsertAction(updated);
      renderActions();
    } catch (error) {
      showError(error.message);
    }
  };
  return h(
    "div",
    { class: "start-options" },
    h("p", { class: "missing-head" }, "Which day did they mean?"),
    h(
      "div",
      { class: "row" },
      action.payload.startOptions.map((option) => h("button", { type: "button", class: "quiet", onclick: () => pick(option) }, label(option))),
    ),
  );
}

// The quick answer comes from one search; the deeper one follows on the same
// card once the full agent has searched further.
function renderDeeper(deeper) {
  if (deeper.status === "looking") {
    return h("p", { class: "deeper-status" }, h("span", { class: "busy-dot" }), "Looking deeper…");
  }
  if (deeper.status !== "ready" || !deeper.answer) return null;
  return h("div", { class: "deeper" }, h("h4", {}, "Deeper look"), renderValue("answer", deeper.answer));
}

function renderReadonlyFields(action) {
  const spec = READONLY_FIELDS[action.kind];
  const wrap = h("div", { class: "readonly-fields" });
  if (!spec) return wrap;
  for (const [key, label] of spec) {
    const value = action.payload[key];
    if (value === undefined) continue;
    const shown = key === "rows" && Array.isArray(value) ? renderTable(value) : renderValue(key, String(value));
    wrap.append(h("div", { class: "field-row" }, h("label", {}, label), shown));
  }
  return wrap;
}

/**
 * The S1 answer is Markdown. It is parsed with marked and then sanitised by
 * DOMPurify, the same pair the main assistant page uses; everything else stays
 * plain text, because transcript-derived text may carry injection attempts.
 */
function renderValue(key, value) {
  if (key === "answer" && window.marked && window.DOMPurify) {
    const block = h("div", { class: "value markdown" });
    block.innerHTML = window.DOMPurify.sanitize(window.marked.parse(value));
    return block;
  }
  return h("p", { class: "value" }, value);
}

function renderTable(rows) {
  const [header = [], ...body] = rows;
  return h(
    "div",
    { class: "sheet-preview" },
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, header.map((cell) => h("th", {}, cell)))),
      h("tbody", {}, body.map((row) => h("tr", {}, row.map((cell) => h("td", {}, cell))))),
    ),
  );
}

function renderEditableFields(action) {
  const spec = EDITABLE_FIELDS[action.kind];
  const draft = currentDraft(action);
  const wrap = h("div", { class: "draft" });
  const chips = h("div", { class: "draft-chips" });

  for (const field of spec) {
    const rawValue = draft.values[field.key];
    const value =
      field.type === "list"
        ? Array.isArray(rawValue) ? rawValue.join(", ") : ""
        : field.type === "table"
          ? Array.isArray(rawValue) ? rawValue.map((row) => row.join(" | ")).join("\n") : ""
          : rawValue ?? "";
    const multiline = field.type === "textarea" || field.type === "table";
    const control = multiline
      ? h("textarea", { rows: 1, class: field.type === "table" ? "mono" : null })
      : h("input", { type: field.type === "number" ? "number" : "text" });
    control.value = value;
    control.dataset.field = field.key;
    control.setAttribute("aria-label", field.label);
    control.addEventListener("input", (event) => {
      if (multiline) grow(event.target);
      markDirty(action, field, event.target.value);
    });

    if (field.layout === "row") {
      wrap.append(h("label", { class: "draft-row" }, h("span", {}, field.label), control));
    } else if (field.layout === "chip") {
      control.placeholder = "Add";
      control.size = Math.max(4, Math.min(24, String(value).length || 4));
      chips.append(h("label", { class: "draft-chip" }, h("span", {}, field.label), control));
    } else {
      control.placeholder = field.label;
      control.classList.add(field.layout === "title" ? "draft-title" : "draft-body");
      wrap.append(control);
    }
    if (multiline) requestAnimationFrame(() => grow(control));
  }
  if (chips.childElementCount) wrap.append(chips);
  return wrap;
}

// A bare text area grows with what is typed, like the body of a document.
function grow(area) {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight}px`;
}

function markDirty(action, field, rawValue) {
  const draft = currentDraft(action);
  let value = rawValue;
  if (field.type === "number") value = rawValue === "" ? undefined : Number(rawValue);
  if (field.type === "list") {
    value = rawValue
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (field.type === "table") {
    value = rawValue
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => line.split("|").map((cell) => cell.trim()));
  }
  draft.values[field.key] = value;
  draft.dirty = true;

  const card = document.querySelector(`[data-action-id="${action.id}"]`);
  const approveBtn = card?.querySelector(".approve-btn");
  if (approveBtn) approveBtn.textContent = "Save and approve";
  const discard = card?.querySelector(".discard-btn");
  if (discard) discard.hidden = false;
}

function renderEvidence(evidence) {
  const list = h("ul", { class: "evidence-list" });
  for (const item of evidence) {
    list.append(
      h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            onclick: () =>
              window.open(`/api/v1/company/sources/${encodeURIComponent(item.sourceId)}`, "_blank", "noopener"),
          },
          `${item.title} (${item.sourceId})`,
        ),
      ),
    );
  }
  // Sources stay one click away so the suggestion itself is what the card shows.
  return h("details", { class: "evidence" }, h("summary", {}, `Sources (${evidence.length})`), list);
}

// One primary action, bottom right. Edits ride along with it: approving an
// edited draft saves the edit first, then approves exactly what was saved.
function renderApprovalButtons(action) {
  const draft = currentDraft(action);

  const approveBtn = h(
    "button",
    { type: "button", class: "primary approve-btn", onclick: () => approveAction(action) },
    draft.dirty ? "Save and approve" : "Approve",
  );
  const discardBtn = h(
    "button",
    {
      type: "button",
      class: "ghost discard-btn",
      onclick: () => {
        editDrafts.delete(action.id);
        renderActions();
      },
    },
    "Discard changes",
  );
  discardBtn.hidden = !draft.dirty;
  const rejectBtn = h("button", { type: "button", class: "ghost warn reject-btn", onclick: () => toggleRejectRow(action) }, "Reject");

  const reasonInput = h("input", { type: "text", placeholder: "Why not? (optional)", "aria-label": "Reason for rejecting" });
  const rejectRow = h(
    "div",
    { class: "reject-row", id: `reject-row-${action.id}` },
    reasonInput,
    h("button", { type: "button", class: "ghost", onclick: () => toggleRejectRow(action) }, "Cancel"),
    h("button", { type: "button", class: "quiet warn confirm-reject", onclick: () => rejectAction(action, reasonInput.value) }, "Reject draft"),
  );
  rejectRow.hidden = true;

  return h(
    "div",
    { class: "approval-controls" },
    rejectRow,
    h("div", { class: "card-actions" }, rejectBtn, h("span", { class: "bar-space" }), discardBtn, approveBtn),
  );
}

function toggleRejectRow(action) {
  const row = document.getElementById(`reject-row-${action.id}`);
  if (!row) return;
  row.hidden = !row.hidden;
  if (!row.hidden) row.querySelector("input").focus();
}

async function approveAction(action) {
  try {
    // An edited draft is saved first; the save returns a new version whose
    // hash is what gets approved, so the approval covers exactly the edit.
    const target = editDrafts.get(action.id)?.dirty ? await saveEdit(action) : action;
    const updated = await postJSON(`/api/v1/meetings/${state.current.meetingId}/actions/${action.id}/approve`, {
      payloadHash: target.payloadHash,
    });
    upsertAction(updated);
    renderActions();
  } catch (error) {
    showError(error.message);
  }
}

async function saveEdit(action) {
  const draft = currentDraft(action);
  const updated = await postJSON(`/api/v1/meetings/${state.current.meetingId}/actions/${action.id}/edit`, {
    payload: draft.values,
  });
  upsertAction(updated);
  return updated;
}

async function rejectAction(action, reason) {
  try {
    const updated = await postJSON(`/api/v1/meetings/${state.current.meetingId}/actions/${action.id}/reject`, {
      ...(reason ? { reason } : {}),
    });
    upsertAction(updated);
    renderActions();
  } catch (error) {
    showError(error.message);
  }
}

// ------------------------------------------------------------------ selection + trace

function selectAction(actionId) {
  state.selectedActionId = state.selectedActionId === actionId ? null : actionId;
  renderActions();
  renderTrace();
  if (state.selectedActionId) {
    const action = state.current?.actions.find((candidate) => candidate.id === actionId);
    if (action) highlightSegment(action.trigger.segmentIndex);
  }
}

function renderTrace() {
  if (!state.current) return;
  const list = $("#trace-list");
  list.replaceChildren();
  $("#trace-clear").hidden = !state.selectedActionId;

  const events = state.current.trace.filter(
    (event) => !state.selectedActionId || event.actionId === state.selectedActionId,
  );
  for (const event of events) {
    list.append(
      h(
        "li",
        { class: event.actionId && event.actionId === state.selectedActionId ? "related" : "" },
        h(
          "div",
          {},
          h("span", { class: "trace-step" }, event.step),
          h("span", { class: "trace-time" }, formatTime(event.at)),
        ),
        h("div", { class: "trace-detail" }, event.detail),
      ),
    );
  }
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

// ------------------------------------------------------------------ start / replay / live lines / end

async function startMeeting(title) {
  try {
    const meeting = await postJSON("/api/v1/meetings", { title, employeeId: "jax" });
    await loadMeetingList();
    openMeeting(meeting.meetingId);
  } catch (error) {
    showError(error.message);
  }
}

async function startReplay(sourceId) {
  try {
    const meeting = await postJSON("/api/v1/meetings/replay", { sourceId });
    await loadMeetingList();
    openMeeting(meeting.meetingId);
  } catch (error) {
    showError(error.message);
  }
}

function parseLiveLines(rawText) {
  return rawText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([^:]{1,80}):\s*(.+)$/);
      return match ? { speaker: match[1].trim(), text: match[2].trim() } : { speaker: "Someone", text: line };
    });
}

async function sendLiveLines(rawText) {
  if (!state.current) return;
  const segments = parseLiveLines(rawText);
  if (segments.length === 0) return;
  try {
    // The already-open SSE stream reflects the appended segments back;
    // this call does not need to touch local state itself.
    await postJSON(`/api/v1/meetings/${state.current.meetingId}/segments`, { segments });
  } catch (error) {
    showError(error.message);
  }
}

async function endMeeting() {
  if (!state.current) return;
  try {
    const meeting = await postJSON(`/api/v1/meetings/${state.current.meetingId}/end`, {});
    state.current.status = meeting.status;
    state.current.endedAt = meeting.endedAt;
    renderMeetingHead();
    await loadMeetingList();
  } catch (error) {
    showError(error.message);
  }
}

// --------------------------------------------------------------- recording

// Records the meeting's audio in clips cut at pauses, so words are not split,
// and sends each clip to the server, which transcribes it into the transcript.
const CLIP_MIN_MS = 3_000;
const CLIP_MAX_MS = 8_000;
const PAUSE_MS = 600;
const SILENCE_LEVEL = 0.01;

const recording = {
  active: false,
  meetingId: null,
  streams: [],
  context: null,
  tap: null,
  socket: null,
  mixed: null,
  recorder: null,
  pending: 0,
  hearing: false,
  clip: 0,
  previewing: false,
  queue: Promise.resolve(),
};

// source: "tab" records a browser tab (the call) and the mic; "mic" the mic alone.
async function startRecording(source = "tab") {
  if (!state.current || state.current.status !== "live" || recording.active) return;
  showError("");
  const streams = [];
  // Made before the share dialog, while the click still counts as a user gesture;
  // made after it, Chrome can leave it suspended, and it then hears only silence.
  const context = new AudioContext();
  try {
    if (source === "tab") {
      // Chrome asks which tab to share; the meeting tab's "Also share tab audio" must be on.
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { suppressLocalAudioPlayback: false },
        systemAudio: "include",
      });
      streams.push(display);
      if (display.getAudioTracks().length === 0) {
        throw new Error('No audio was shared. Pick the meeting tab with "Also share tab audio" on, or the entire screen with system audio on.');
      }
    }
    try {
      streams.push(await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }));
    } catch (error) {
      // Without the mic, tab audio still records everyone except you.
      if (source === "mic") throw error;
    }
  } catch (error) {
    for (const stream of streams) for (const track of stream.getTracks()) track.stop();
    context.close();
    if (error.name !== "NotAllowedError") showError(error.message);
    return;
  }

  await context.resume();
  const destination = context.createMediaStreamDestination();
  // Audio callbacks keep running while this tab is in the background, unlike
  // timers, which Chrome slows down there; clip cutting is driven from them.
  const tap = context.createScriptProcessor(4096, 1, 1);
  tap.connect(context.destination);
  for (const stream of streams) {
    const tracks = stream.getAudioTracks();
    if (tracks.length === 0) continue;
    const node = context.createMediaStreamSource(new MediaStream(tracks));
    node.connect(destination);
    node.connect(tap);
    // Stopping the share from Chrome's bar ends the recording too.
    for (const track of tracks) track.addEventListener("ended", stopRecording);
  }
  Object.assign(recording, {
    active: true,
    meetingId: state.current.meetingId,
    streams,
    context,
    tap,
    mixed: destination.stream,
  });
  if (state.liveAsr) streamAudio();
  else recordClip();
  renderRecording();
}

// With streaming recognition on the server, audio goes out continuously: the
// mix is resampled to 16 kHz mono 16-bit PCM and sent every 200 ms. Partial
// text comes back on the socket; final sentences arrive as transcript events.
const STREAM_RATE = 16_000;
const STREAM_CHUNK_SAMPLES = STREAM_RATE / 5;

function streamAudio() {
  const params = new URLSearchParams({ speaker: RECORDED_SPEAKER });
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/api/v1/meetings/${recording.meetingId}/stream?${params}`);
  socket.binaryType = "arraybuffer";
  recording.socket = socket;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "partial") setInterim(message.text);
    else if (message.type === "error") showError(`Live transcription: ${message.message}`);
  });
  socket.addEventListener("close", () => {
    if (recording.socket === socket) {
      // Closed from the far side while still recording: say so rather than go quiet.
      showError("Live transcription stopped. Stop and start recording again.");
      recording.socket = null;
    }
    setInterim("");
  });

  const ratio = recording.context.sampleRate / STREAM_RATE;
  let pending = new Int16Array(STREAM_CHUNK_SAMPLES);
  let filled = 0;
  recording.tap.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    let loud = 0;
    // Averaging each group of input samples is enough of a low-pass for speech.
    for (let position = 0; position + ratio <= input.length; position += ratio) {
      let sum = 0;
      const start = Math.floor(position);
      const end = Math.floor(position + ratio);
      for (let i = start; i < end; i += 1) sum += input[i];
      const sample = Math.max(-1, Math.min(1, sum / (end - start)));
      loud = Math.max(loud, Math.abs(sample));
      pending[filled] = sample * 0x7fff;
      filled += 1;
      if (filled === STREAM_CHUNK_SAMPLES) {
        if (socket.readyState === WebSocket.OPEN) socket.send(pending.buffer);
        pending = new Int16Array(STREAM_CHUNK_SAMPLES);
        filled = 0;
      }
    }
    const hearing = loud > SILENCE_LEVEL * 3;
    if (hearing !== recording.hearing) {
      recording.hearing = hearing;
      renderRecording();
    }
  };
}

function recordClip() {
  if (!recording.active) return;
  const recorder = new MediaRecorder(recording.mixed, { mimeType: "audio/webm;codecs=opus" });
  const chunks = [];
  const meetingId = recording.meetingId;
  const startedAt = Date.now();
  let lastSoundAt = 0;
  const clip = (recording.clip += 1);
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
    // Every half second, the clip so far is transcribed and shown, so words appear while they are spoken.
    if (recorder.state === "recording" && lastSoundAt) previewClip(new Blob(chunks, { type: "audio/webm" }), meetingId, clip);
  });
  recorder.addEventListener("stop", () => {
    // A clip nobody spoke in is not worth sending; Whisper invents text on silence.
    if (lastSoundAt && chunks.length) sendClip(new Blob(chunks, { type: "audio/webm" }), meetingId);
  });
  recorder.start(500);
  recording.recorder = recorder;

  recording.tap.onaudioprocess = (event) => {
    const samples = event.inputBuffer.getChannelData(0);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const now = Date.now();
    const hearing = Math.sqrt(sum / samples.length) > SILENCE_LEVEL;
    if (hearing) lastSoundAt = now;
    if (hearing !== recording.hearing) {
      recording.hearing = hearing;
      renderRecording();
    }
    const elapsed = now - startedAt;
    const paused = lastSoundAt && now - lastSoundAt > PAUSE_MS;
    if (elapsed >= CLIP_MAX_MS || (elapsed >= CLIP_MIN_MS && paused)) {
      recording.tap.onaudioprocess = null;
      recorder.stop();
      recordClip();
    }
  };
}

// Recorded lines carry one label; the recogniser handles Chinese mixed with English.
const RECORDED_SPEAKER = "Meeting";
const RECORDED_LANGUAGE = "zh";

function audioParams(extra = {}) {
  return new URLSearchParams({ speaker: RECORDED_SPEAKER, language: RECORDED_LANGUAGE, ...extra });
}

// Previews wait while a final clip is transcribing and never overlap, so they
// cannot hold up the lines that are kept.
async function previewClip(blob, meetingId, clip) {
  if (recording.previewing || recording.pending) return;
  recording.previewing = true;
  try {
    const response = await fetch(`/api/v1/meetings/${meetingId}/audio?${audioParams({ preview: "1" })}`, {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: blob,
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && clip === recording.clip && recording.active) setInterim(data.text);
  } catch {
    // A missed preview is replaced by the next one a second later.
  } finally {
    recording.previewing = false;
  }
}

function setInterim(text) {
  const line = $("#mic-interim");
  line.textContent = text || "";
  line.hidden = !text;
  if (text) line.scrollIntoView({ block: "nearest" });
}

function sendClip(blob, meetingId) {
  const params = audioParams();
  recording.pending += 1;
  renderRecording();
  // One clip at a time keeps the transcript in spoken order.
  recording.queue = recording.queue.then(async () => {
    try {
      const response = await fetch(`/api/v1/meetings/${meetingId}/audio?${params}`, {
        method: "POST",
        headers: { "content-type": "audio/webm" },
        body: blob,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || "Could not transcribe the recording.");
      }
      if (!recording.pending || recording.pending === 1) setInterim("");
    } catch (error) {
      showError(error.message);
    } finally {
      recording.pending -= 1;
      renderRecording();
    }
  });
}

function stopRecording() {
  if (!recording.active) return;
  recording.active = false;
  if (recording.tap) recording.tap.onaudioprocess = null;
  if (recording.socket) {
    // The server finishes the last sentence, then closes the socket.
    if (recording.socket.readyState === WebSocket.OPEN) recording.socket.send("end");
    recording.socket = null;
  }
  if (recording.recorder?.state === "recording") recording.recorder.stop();
  for (const stream of recording.streams) for (const track of stream.getTracks()) track.stop();
  recording.context?.close();
  Object.assign(recording, { streams: [], context: null, tap: null, mixed: null, recorder: null });
  recording.queue.then(() => setInterim(""));
  renderRecording();
}

// Start and end are one control in two states: a live meeting that is not
// recording can start; while recording it can end; an ended meeting offers neither.
function renderRecording() {
  const live = state.current?.status === "live";
  $("#mic-start").hidden = !live || recording.active;
  $("#end-meeting-btn").hidden = !live || !recording.active;
  $("#rec-dot").hidden = !recording.active;
  const parts = [];
  if (recording.active) parts.push(recording.hearing ? "Recording, hearing sound" : "Recording, silent");
  if (recording.pending) parts.push(`transcribing ${recording.pending} clip${recording.pending > 1 ? "s" : ""}`);
  $("#mic-status").textContent = parts.join(" · ");
}

// ------------------------------------------------------------------ wiring

function init() {
  $("#new-meeting-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#new-meeting-title");
    const title = input.value.trim();
    if (!title) return;
    input.value = "";
    startMeeting(title);
  });

  $("#replay-btn").addEventListener("click", () => {
    const sourceId = $("#replay-select").value;
    if (sourceId) startReplay(sourceId);
  });

  $("#live-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#live-input");
    const text = input.value;
    if (!text.trim()) return;
    input.value = "";
    sendLiveLines(text);
  });

  $("#end-meeting-btn").addEventListener("click", endMeeting);
  // Choosing what to record is what starts it.
  $("#mic-menu").addEventListener("sl-select", (event) => startRecording(event.detail.item.value));

  // The tray folds to its title, so the notes behind it get the whole page.
  $("#tray-toggle").addEventListener("click", () => {
    const open = $("#tray-toggle").getAttribute("aria-expanded") !== "true";
    $("#tray-toggle").setAttribute("aria-expanded", String(open));
    $(".tray-body").hidden = !open;
    // The foot only shows when something was blocked, so it is recomputed rather than simply shown.
    if (state.current) renderActions();
    else $(".tray-foot").hidden = true;
    $("#tray").classList.toggle("folded", !open);
  });

  $("#blocked-toggle").addEventListener("click", () => {
    const list = $("#blocked-list");
    list.hidden = !list.hidden;
    $("#blocked-toggle").setAttribute("aria-expanded", String(!list.hidden));
  });

  $("#tx-toggle").addEventListener("click", () => {
    const off = $("#board").classList.toggle("tx-off");
    $("#tx-toggle").setAttribute("aria-pressed", String(!off));
  });

  $("#trace-clear").addEventListener("click", () => {
    state.selectedActionId = null;
    renderActions();
    renderTrace();
  });

  loadMeetingList();
  loadReplayList();
  loadIntegrations();

  const fromAddress = meetingIdInAddress();
  if (fromAddress) openMeeting(fromAddress, { fromAddress: true });
  window.addEventListener("popstate", () => {
    const meetingId = meetingIdInAddress();
    if (meetingId && meetingId !== state.current?.meetingId) openMeeting(meetingId, { fromAddress: true });
  });
}

function meetingIdInAddress() {
  const match = location.pathname.match(/^\/meetings\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

// ------------------------------------------------------------ integrations

/**
 * Offers to connect Google when the agent could do more with it: the
 * calendar check needs free/busy, which only shows when someone is busy,
 * never what their events are. Also reports how a connect attempt ended.
 */
async function loadIntegrations() {
  const outcome = new URLSearchParams(location.search).get("google");
  if (outcome) history.replaceState(null, "", location.pathname);
  try {
    const integrations = await getJSON("/api/v1/meetings/integrations");
    state.google = integrations.google;
    state.liveAsr = Boolean(integrations.liveAsr);
  } catch {
    state.google = null;
  }
  renderGoogleBanner(outcome);
  if (state.current) renderActions();
}

function renderGoogleBanner(outcome) {
  const banner = $("#google-banner");
  banner.replaceChildren();
  const google = state.google;
  if (!google) {
    banner.hidden = true;
    return;
  }
  if (google.connected && google.mailbox && google.calendar) {
    banner.hidden = outcome !== "connected";
    banner.className = "banner connect done";
    banner.append("Google connected. Calendar invites are now checked against your free/busy.");
    return;
  }
  banner.hidden = false;
  banner.className = "banner connect";
  const lead =
    google.connected && !google.mailbox && outcome !== "no-gmail"
      ? "The connected Google account has no Gmail, so replies and addresses in your mail cannot be read. Connect the account you use for email: "
      : outcome === "no-gmail"
      ? "That Google account has no Gmail, so it was not connected and the previous connection was kept. Choose the account you use for email: "
      : outcome === "denied"
      ? "Google access was not granted, so calendar invites are not checked. "
      : google.connected
        ? "Let the agent check calendar invites: it needs to see when you are busy (never what your events are). "
        : "Connect Google so the agent can find people's addresses in your mail and check calendar invites against when you are busy. ";
  const wrongAccount = google.connected && !google.mailbox;
  const label = wrongAccount ? "Connect your Gmail account" : google.connected ? "Allow calendar access" : "Connect Google";
  const hint = google.connected && !wrongAccount && outcome !== "denied" ? ". On Google's screen, tick the calendar box." : ".";
  banner.append(lead, h("a", { href: google.connectUrl }, label), hint);
}

document.addEventListener("DOMContentLoaded", init);
