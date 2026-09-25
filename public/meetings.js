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
  answer_question: [
    ["question", "Question"],
    ["answer", "Answer"],
  ],
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
  closeStream();
  state.current = null;
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
    renderActions();
  });
  source.addEventListener("trace", (event) => {
    if (!state.current) return;
    const payload = JSON.parse(event.data);
    state.current.trace.push(payload.trace);
    renderTrace();
  });
  source.addEventListener("meeting", (event) => {
    if (!state.current) return;
    const payload = JSON.parse(event.data);
    state.current.status = payload.status;
    renderMeetingHead();
    renderMeetingList();
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
  $("#busy-indicator").hidden = !busy;
}

// ------------------------------------------------------------------ transcript

function renderBoard() {
  renderMeetingHead();
  renderTranscript();
  renderActions();
  renderTrace();
}

function renderMeetingHead() {
  if (!state.current) return;
  $("#meeting-title-heading").textContent = state.current.title;
  $("#status-line").textContent = `${state.current.title} — ${state.current.status === "live" ? "live" : "ended"}`;
  $("#end-meeting-btn").disabled = state.current.status !== "live";
  for (const element of $("#live-form").elements) element.disabled = state.current.status !== "live";
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

function renderActions() {
  if (!state.current) return;
  for (const tier of TIERS) {
    const container = $(`#cards-${tier}`);
    container.replaceChildren();
    for (const action of state.current.actions.filter((candidate) => candidate.tier === tier)) {
      container.append(renderCard(action));
    }
  }
}

function currentDraft(action) {
  if (!editDrafts.has(action.id)) {
    editDrafts.set(action.id, { values: { ...action.payload }, dirty: false });
  }
  return editDrafts.get(action.id);
}

function renderCard(action) {
  const card = h("div", {
    class: `card${action.kind === "flag_conflict" ? " conflict" : ""}${
      state.selectedActionId === action.id ? " selected" : ""
    }`,
    "data-tier": action.tier,
    "data-action-id": action.id,
  });

  card.addEventListener("click", (event) => {
    if (event.target.closest("button, input, textarea, select")) return;
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
            navigator.clipboard
              .writeText(handoffCopy)
              .catch(() => setStatus("Could not copy; select the draft above instead."));
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
  return list;
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
  if (google.connected && google.calendar) {
    banner.hidden = outcome !== "connected";
    banner.className = "banner connect done";
    banner.append("Google connected. Calendar invites are now checked against your free/busy.");
    return;
  }
  banner.hidden = false;
  banner.className = "banner connect";
  const lead =
    outcome === "denied"
      ? "Google access was not granted, so calendar invites are not checked. "
      : google.connected
        ? "Let the agent check calendar invites: it needs to see when you are busy (never what your events are). "
        : "Connect Google so the agent can find people's addresses in your mail and check calendar invites against when you are busy. ";
  const hint = google.connected && outcome !== "denied" ? " On Google's screen, tick the calendar box." : "";
  banner.append(lead, h("a", { href: google.connectUrl }, google.connected ? "Allow calendar access" : "Connect Google"), hint);
}

document.addEventListener("DOMContentLoaded", init);
