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
  escalation: "Escalation",
  blocked: "Blocked",
};

const TIERS = ["auto", "approval", "escalate", "blocked"];

// Fields a human can change before approving. Only kinds that change the
// world (tier "approval") get edit controls; the rest render read-only.
const EDITABLE_FIELDS = {
  email_draft: [
    { key: "to", label: "To", type: "text" },
    { key: "subject", label: "Subject", type: "text" },
    { key: "body", label: "Body", type: "textarea" },
  ],
  ticket_draft: [
    { key: "title", label: "Title", type: "text" },
    { key: "description", label: "Description", type: "textarea" },
    { key: "assignee", label: "Assignee", type: "text" },
    { key: "due", label: "Due", type: "text" },
  ],
  calendar_draft: [
    { key: "title", label: "Title", type: "text" },
    { key: "attendees", label: "Attendees (comma separated)", type: "list" },
    { key: "proposedStart", label: "Start (ISO time)", type: "text" },
    { key: "durationMinutes", label: "Duration (minutes)", type: "number" },
  ],
  message_draft: [
    { key: "recipient", label: "To", type: "text" },
    { key: "address", label: "Phone or work email (optional)", type: "text" },
    { key: "text", label: "Message", type: "textarea" },
  ],
  doc_draft: [
    { key: "title", label: "Title", type: "text" },
    { key: "body", label: "Draft (Markdown)", type: "textarea" },
  ],
  sheet_draft: [
    { key: "title", label: "Title", type: "text" },
    { key: "rows", label: "Rows (one per line, cells separated by |, first line is the header)", type: "table" },
  ],
  hiring_request: [{ key: "requirement", label: "Requirement", type: "textarea" }],
};

const READONLY_FIELDS = {
  // The quoted line above the fields already shows the question.
  answer_question: [["answer", "Answer"]],
  flag_conflict: [
    ["statement", "Statement"],
    ["priorDecision", "Prior decision"],
    ["explanation", "Why this conflicts"],
  ],
  escalation: [
    ["subject", "Subject"],
    ["reason", "Reason"],
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
            onclick: () => openMeeting(meeting.meetingId),
          },
          h("span", {}, meeting.title),
          h("span", { class: "status" }, meeting.status === "live" ? "live" : "ended"),
        ),
      ),
    );
  }
}

function renderReplaySelect() {
  const select = $("#replay-select");
  const button = $("#replay-btn");
  select.replaceChildren();
  if (state.replays.length === 0) {
    select.append(h("option", { value: "" }, "No replays found"));
    button.disabled = true;
    return;
  }
  for (const replay of state.replays) {
    select.append(h("option", { value: replay.sourceId }, replay.title));
  }
  button.disabled = false;
}

// ------------------------------------------------------------------ opening a meeting (SSE)

function closeStream() {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
}

function openMeeting(meetingId) {
  document.body.classList.add("in-meeting");
  stopRecording();
  closeStream();
  state.current = null;
  state.streams = {};
  state.thoughts = {};
  state.selectedActionId = null;
  editDrafts.clear();
  showError("");
  $("#board").hidden = false;

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
  $("#status-line").textContent = `${state.current.title} — ${state.current.status === "live" ? "live" : "ended"}`;
  $("#end-meeting-btn").disabled = state.current.status !== "live";
  for (const element of $("#live-form").elements) element.disabled = state.current.status !== "live";
  if (state.current.status !== "live" && recording.active) stopRecording();
  renderRecording();
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
  const leads = new Set(["flag_conflict", "answer_question"]);
  const groups = {
    alerts: actions.filter((action) => action.kind === "flag_conflict"),
    answers: actions.filter((action) => action.kind === "answer_question").reverse(),
    ...Object.fromEntries(
      TIERS.map((tier) => [tier, actions.filter((action) => action.tier === tier && !leads.has(action.kind))]),
    ),
  };
  for (const [group, members] of Object.entries(groups)) {
    const container = $(`#cards-${group}`);
    container.replaceChildren(...members.map((action) => renderCard(action, group === "auto" || group === "blocked")));
    container.closest(".tier-group").hidden = members.length === 0;
  }
  refreshEmpty();
  for (const action of actions) seenActions.add(action.id);
}

const seenActions = new Set();

// The empty-room hint goes as soon as the assistant has anything to show.
function refreshEmpty() {
  const current = state.current;
  const shown =
    (current?.actions.length ?? 0) > 0 ||
    (current?.decisions?.length ?? 0) > 0 ||
    (current?.assignments?.length ?? 0) > 0 ||
    Boolean(current?.minutes) ||
    !$("#assistant-pending").hidden;
  $("#assistant-empty").hidden = shown;
}

// ------------------------------------------------------------------ notes and minutes

// What was decided and who took what on, as the meeting goes. Assignments are
// tasks the agent cannot do itself, so they are noted here rather than drafted.
function renderNotes() {
  if (!state.current) return;
  const decisions = state.current.decisions ?? [];
  const assignments = state.current.assignments ?? [];
  const box = $("#notes");
  box.replaceChildren();
  if (decisions.length) {
    box.append(
      h("h4", {}, "Decided"),
      h(
        "ul",
        {},
        decisions.map((decision) =>
          h(
            "li",
            { onclick: () => highlightSegment(decision.segmentIndex) },
            decision.text,
            h("span", { class: "who" }, ` ${decision.speaker}`),
          ),
        ),
      ),
    );
  }
  if (assignments.length) {
    box.append(
      h("h4", {}, "Who's on it"),
      h(
        "ul",
        {},
        assignments.map((entry) =>
          h(
            "li",
            { onclick: () => highlightSegment(entry.segmentIndex) },
            h("strong", {}, entry.owner),
            `: ${entry.task}`,
            entry.due ? h("span", { class: "who" }, ` by ${entry.due}`) : null,
          ),
        ),
      ),
    );
  }
  box.closest(".tier-group").hidden = decisions.length + assignments.length === 0;
  refreshEmpty();
}

function renderMinutes() {
  const box = $("#minutes-box");
  const minutes = state.current?.minutes;
  box.hidden = !minutes;
  refreshEmpty();
  if (!minutes) return;
  if (minutes.status !== "ready") {
    box.replaceChildren(
      h(
        "p",
        { class: "pending-head" },
        minutes.status === "writing" ? h("span", { class: "busy-dot" }) : null,
        minutes.status === "writing" ? "Writing the minutes…" : "The minutes could not be written.",
      ),
    );
    return;
  }
  const markdown = minutes.markdown ?? "";
  const copy = h("button", { type: "button", class: "quiet" }, "Copy");
  copy.addEventListener("click", async () => {
    await copyRich(markdown, "markdown");
    copy.textContent = "Copied";
  });
  const download = h(
    "a",
    {
      class: "quiet",
      download: `${state.current.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "minutes"}.md`,
      href: `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`,
    },
    "Download .md",
  );
  box.replaceChildren(
    h("div", { class: "minutes-head" }, h("h3", {}, "Minutes"), copy, download),
    renderValue("answer", markdown),
  );
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
      h("span", { class: "card-title" }, action.title),
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
    card.append(
      h(
        "div",
        { class: "missing" },
        h("p", { class: "missing-head" }, "Still needed from you (the agent looked and could not find it):"),
        h("ul", {}, action.missing.map((need) => h("li", {}, need))),
      ),
    );
  }

  if (action.tier === "escalate" && action.payload.requiredApprover) {
    card.append(h("p", { class: "required-approver" }, `Needs approval from: ${action.payload.requiredApprover}`));
  }

  if (action.kind === "hiring_request") {
    card.append(
      h(
        "p",
        { class: "hiring-note" },
        "Approving opens this requirement in ",
        h("a", { href: "/recruiting" }, "Recruiting"),
        ".",
      ),
    );
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

function renderHandoff(action) {
  const { handoffUrl, handoffCopy } = action.result;
  const status = h("span", { class: "handoff-status" }, handoffStatus.get(action.id) ?? "");
  const setStatus = (message) => {
    handoffStatus.set(action.id, message);
    status.textContent = message;
  };
  const open = h(
    "a",
    {
      href: handoffUrl,
      target: "_blank",
      rel: "noopener",
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
    action.kind === "sheet_draft"
      ? "Copy table and open a blank spreadsheet \u2197"
      : handoffCopy
        ? "Copy draft and open a blank document \u2197"
        : "Open to confirm \u2197",
  );
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
  const wrap = h("div", { class: "editable-fields" });
  const dirtyHint = h("p", { class: "dirty-hint" }, "Edited — click Edit to save before approving.");
  dirtyHint.hidden = !draft.dirty;

  for (const field of spec) {
    const rawValue = draft.values[field.key];
    const value =
      field.type === "list"
        ? Array.isArray(rawValue) ? rawValue.join(", ") : ""
        : field.type === "table"
          ? Array.isArray(rawValue) ? rawValue.map((row) => row.join(" | ")).join("\n") : ""
          : rawValue ?? "";
    const control =
      field.type === "textarea" || field.type === "table"
        ? h("textarea", { oninput: (event) => markDirty(action, field, event.target.value) })
        : h("input", {
            type: field.type === "number" ? "number" : "text",
            oninput: (event) => markDirty(action, field, event.target.value),
          });
    control.value = value;
    wrap.append(h("div", { class: "field-row" }, h("label", {}, field.label), control));
  }
  wrap.append(dirtyHint);
  return wrap;
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
  const hint = card?.querySelector(".dirty-hint");
  if (hint) hint.hidden = false;
  const approveBtn = card?.querySelector(".approve-btn");
  if (approveBtn) approveBtn.disabled = true;
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

function renderApprovalButtons(action) {
  const draft = currentDraft(action);

  const approveBtn = h(
    "button",
    { type: "button", class: "primary approve-btn", onclick: () => approveAction(action) },
    "Approve",
  );
  approveBtn.disabled = draft.dirty;

  const editBtn = h("button", { type: "button", class: "quiet", onclick: () => submitEdit(action) }, "Edit");
  const rejectBtn = h(
    "button",
    { type: "button", class: "quiet warn", onclick: () => toggleRejectRow(action) },
    "Reject",
  );

  const reasonInput = h("input", { type: "text", placeholder: "Reason (optional)" });
  const rejectRow = h(
    "div",
    { class: "reject-row", id: `reject-row-${action.id}` },
    reasonInput,
    h(
      "button",
      { type: "button", class: "quiet warn", onclick: () => rejectAction(action, reasonInput.value) },
      "Confirm reject",
    ),
  );
  rejectRow.hidden = true;

  const wrap = h("div", { class: "approval-controls" });
  wrap.append(h("div", { class: "card-actions" }, approveBtn, editBtn, rejectBtn), rejectRow);
  return wrap;
}

function toggleRejectRow(action) {
  const row = document.getElementById(`reject-row-${action.id}`);
  if (row) row.hidden = !row.hidden;
}

async function approveAction(action) {
  try {
    // The exact, unchanged payloadHash this card was rendered with. If the
    // fields were edited, the Edit button already sent that change and
    // replaced this action with a new version, so this is always the
    // payload the employee is currently looking at.
    const updated = await postJSON(`/api/v1/meetings/${state.current.meetingId}/actions/${action.id}/approve`, {
      payloadHash: action.payloadHash,
    });
    upsertAction(updated);
    renderActions();
  } catch (error) {
    showError(error.message);
  }
}

async function submitEdit(action) {
  const draft = currentDraft(action);
  try {
    const updated = await postJSON(`/api/v1/meetings/${state.current.meetingId}/actions/${action.id}/edit`, {
      payload: draft.values,
    });
    upsertAction(updated);
    renderActions();
  } catch (error) {
    showError(error.message);
  }
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
  mixed: null,
  recorder: null,
  pending: 0,
  hearing: false,
  clip: 0,
  previewing: false,
  queue: Promise.resolve(),
};

async function startRecording() {
  if (!state.current || state.current.status !== "live" || recording.active) return;
  showError("");
  const source = $("#mic-source").value;
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
  recordClip();
  renderRecording();
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

function audioParams(extra = {}) {
  const params = new URLSearchParams({ speaker: $("#mic-speaker").value.trim() || "Meeting", ...extra });
  const language = $("#mic-lang").value;
  if (language) params.set("language", language);
  return params;
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
  if (recording.recorder?.state === "recording") recording.recorder.stop();
  for (const stream of recording.streams) for (const track of stream.getTracks()) track.stop();
  recording.context?.close();
  Object.assign(recording, { streams: [], context: null, tap: null, mixed: null, recorder: null });
  recording.queue.then(() => setInterim(""));
  renderRecording();
}

function renderRecording() {
  const live = state.current?.status === "live";
  const button = $("#mic-btn");
  button.textContent = recording.active ? "Stop recording" : "Start recording";
  button.classList.toggle("recording", recording.active);
  button.disabled = !live && !recording.active;
  for (const id of ["#mic-source", "#mic-lang", "#mic-speaker"]) $(id).disabled = !live || recording.active;
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
  $("#mic-btn").addEventListener("click", () => (recording.active ? stopRecording() : startRecording()));

  $("#trace-clear").addEventListener("click", () => {
    state.selectedActionId = null;
    renderActions();
    renderTrace();
  });

  loadMeetingList();
  loadReplayList();
  loadIntegrations();
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
    state.google = (await getJSON("/api/v1/meetings/integrations")).google;
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
