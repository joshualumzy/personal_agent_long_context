// "Clear all": approve, reject or skip what needs you, one draft at a time,
// without leaving the home page. Loaded after app.js (see index.html), so it
// reuses that script's top-level helpers (escapeHtml, lineIcon, taskTitle,
// HOME_KINDS, loadHome, refreshContext) rather than duplicating them.
//
// app.js's loadHome() dispatches "kaki:home-needs" with the drafts waiting on
// the employee every time it refreshes the plate; that is this module's only
// hook into app.js. Approving or rejecting a draft calls the very same
// meeting routes the tray on /meetings/:id uses, with the same payloadHash
// contract, so nothing here bypasses approval or sends anything the
// employee did not click.

/** The queue for the review in progress; empty when no review is open. */
let clearQueue = [];
let clearIndex = 0;
let clearActive = false;
/** The plate's freshest "needs you" list, kept current so Clear all always starts from it. */
let clearNeeds = [];

document.addEventListener("kaki:home-needs", (event) => {
  clearNeeds = event.detail?.needs ?? [];
  const button = document.querySelector("#clear-needs-btn");
  if (button) button.hidden = clearNeeds.length === 0;
});

/** What each field is called for a kind, and where its value lives in the payload. */
const CLEAR_FIELDS = {
  email_draft: [["to", "To"], ["subject", "Subject"], ["body", "Message"]],
  ticket_draft: [["title", "Title"], ["description", "Description"], ["assignee", "Assignee"], ["due", "Due"]],
  calendar_draft: [["title", "Event"], ["attendees", "Guests"], ["proposedStart", "Starts"], ["durationMinutes", "Minutes"], ["notes", "Notes"]],
  message_draft: [["recipient", "To"], ["address", "Phone or email"], ["text", "Message"]],
  doc_draft: [["title", "Title"], ["body", "Draft"]],
  sheet_draft: [["title", "Title"]],
  hiring_request: [["requirement", "Requirement"]],
};
/** The last field of each kind is the one shown as a full block, not a row; the rest are short. */
const CLEAR_BODY_FIELD = {
  email_draft: "body",
  ticket_draft: "description",
  message_draft: "text",
  doc_draft: "body",
  hiring_request: "requirement",
};

function currentItem() {
  return clearQueue[clearIndex];
}

function approveLabel(action) {
  return action.kind === "email_draft" ? "Approve, open in Gmail" : "Approve";
}

function fieldValue(payload, key) {
  const value = payload ? payload[key] : undefined;
  if (value === undefined || value === null || value === "") return "";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function renderClearFields(action) {
  const spec = CLEAR_FIELDS[action.kind] ?? [];
  const bodyKey = CLEAR_BODY_FIELD[action.kind];
  const payload = action.payload ?? {};
  const parts = [];

  if (Array.isArray(action.missing) && action.missing.length > 0) {
    parts.push(
      `<div class="clear-missing"><p class="clear-missing-head">Still needed from you</p><ul>${action.missing
        .map((need) => `<li>${escapeHtml(need)}</li>`)
        .join("")}</ul></div>`,
    );
  }

  for (const [key, label] of spec) {
    if (key === bodyKey) continue;
    const value = fieldValue(payload, key);
    if (!value) continue;
    parts.push(`<div class="clear-row"><span class="clear-label">${escapeHtml(label)}</span><span class="clear-value">${escapeHtml(value)}</span></div>`);
  }

  if (bodyKey) {
    const value = fieldValue(payload, bodyKey);
    if (value) parts.push(`<div class="clear-body">${escapeHtml(value)}</div>`);
  }

  if (action.kind === "sheet_draft" && Array.isArray(payload.rows)) {
    const rows = payload.rows
      .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join("")}</tr>`)
      .join("");
    parts.push(`<table class="clear-table">${rows}</table>`);
  }

  if (Array.isArray(action.notes) && action.notes.length > 0) {
    parts.push(
      `<div class="clear-notes"><p class="clear-missing-head">Checked for you</p><ul>${action.notes
        .map((note) => `<li>${escapeHtml(note)}</li>`)
        .join("")}</ul></div>`,
    );
  }

  return parts.join("");
}

function renderClearContext(item) {
  const { action, meeting } = item;
  const quoteMeta = document.querySelector("#clear-quote-meta");
  const quoteText = document.querySelector("#clear-quote-text");
  if (quoteMeta) quoteMeta.textContent = [meeting.title, action.trigger?.speaker].filter(Boolean).join(" · ");
  if (quoteText) quoteText.textContent = action.trigger?.quote ?? "";

  const evidenceList = document.querySelector("#clear-evidence");
  if (evidenceList) {
    const evidence = Array.isArray(action.evidence) ? action.evidence : [];
    evidenceList.replaceChildren(
      ...evidence.map((source) => {
        const row = document.createElement("div");
        row.className = "clear-evidence-row";
        row.innerHTML = `<span class="clear-evidence-id">${escapeHtml(source.sourceId)}</span><span>${escapeHtml(source.title || "")}</span>`;
        return row;
      }),
    );
  }
  const built = document.querySelector("#clear-built");
  if (built) built.hidden = !action.evidence || action.evidence.length === 0;
}

function setStatus(message) {
  const status = document.querySelector("#clear-status");
  if (status) status.textContent = message ?? "";
}

function setBusy(busy) {
  for (const id of ["#clear-skip", "#clear-reject", "#clear-approve"]) {
    const button = document.querySelector(id);
    if (button) button.disabled = busy;
  }
}

function showCurrent() {
  const item = currentItem();
  if (!item) return finishClear();
  const { action } = item;
  const [kindLabel, icon] = (typeof HOME_KINDS !== "undefined" && HOME_KINDS[action.kind]) || ["Action", "check"];
  const iconEl = document.querySelector("#clear-icon");
  if (iconEl) {
    iconEl.innerHTML = typeof lineIcon === "function" ? lineIcon(icon, 15) : "";
    iconEl.title = kindLabel;
  }
  const titleEl = document.querySelector("#clear-title");
  if (titleEl) titleEl.textContent = typeof taskTitle === "function" ? taskTitle(action.title) : action.title;
  const progressEl = document.querySelector("#clear-progress");
  if (progressEl) progressEl.textContent = `${clearIndex + 1} of ${clearQueue.length}`;
  const fieldsEl = document.querySelector("#clear-fields");
  if (fieldsEl) fieldsEl.innerHTML = renderClearFields(action);
  const approveBtn = document.querySelector("#clear-approve");
  if (approveBtn) approveBtn.textContent = approveLabel(action);

  renderClearContext(item);
  setStatus("");
  setBusy(false);
}

function advance() {
  clearIndex += 1;
  if (clearIndex >= clearQueue.length) {
    finishClear();
    return;
  }
  showCurrent();
}

function skipCurrent() {
  if (!clearActive) return;
  advance();
}

/** Opens what an approved action hands off to, the way the meeting tray does:
 * an email opens in the employee's own, already signed-in Gmail. */
function openHandoff(action) {
  const url = action.result?.handoffUrl;
  if (!url) return;
  if (action.kind === "hiring_request") {
    try {
      sessionStorage.setItem(
        "assistant-handoff",
        JSON.stringify({ message: `We need to hire: ${action.payload?.requirement ?? ""}.`, at: Date.now() }),
      );
    } catch (_) {
      // Continuing in the assistant is a convenience; its absence does not block the handoff.
    }
  }
  window.open(url, "_blank", url.startsWith("/") ? undefined : "noopener");
}

async function approveCurrent() {
  if (!clearActive) return;
  const item = currentItem();
  if (!item) return;
  setBusy(true);
  setStatus("Approving…");
  try {
    const response = await fetch(
      `/api/v1/meetings/${encodeURIComponent(item.meeting.meetingId)}/actions/${encodeURIComponent(item.action.id)}/approve`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payloadHash: item.action.payloadHash }),
      },
    );
    const updated = await response.json();
    if (!response.ok) throw new Error(updated.message || "Could not approve this draft.");
    if (updated.status === "executed" && updated.result?.handoffUrl) openHandoff(updated);
    if (updated.status === "failed") {
      setStatus(updated.error || "That draft could not be sent.");
      setBusy(false);
      return;
    }
    advance();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not approve this draft.");
    setBusy(false);
  }
}

async function rejectCurrent() {
  if (!clearActive) return;
  const item = currentItem();
  if (!item) return;
  setBusy(true);
  setStatus("Rejecting…");
  try {
    const response = await fetch(
      `/api/v1/meetings/${encodeURIComponent(item.meeting.meetingId)}/actions/${encodeURIComponent(item.action.id)}/reject`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const updated = await response.json();
    if (!response.ok) throw new Error(updated.message || "Could not reject this draft.");
    advance();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not reject this draft.");
    setBusy(false);
  }
}

function setPanelsVisible(visible) {
  const review = document.querySelector("#clear-review");
  if (review) review.hidden = !visible;
  const chatMain = document.querySelector(".chat-main");
  if (chatMain) chatMain.hidden = visible;

  const clearContext = document.querySelector("#clear-context");
  if (clearContext) clearContext.hidden = !visible;
  const context = document.querySelector("#context");
  if (context) {
    if (visible) {
      context.hidden = false;
      document.body.classList.add("has-context");
    } else if (typeof refreshContext === "function") {
      refreshContext();
    } else {
      context.hidden = true;
    }
  }
}

function finishClear() {
  clearActive = false;
  clearQueue = [];
  clearIndex = 0;
  setPanelsVisible(false);
  if (typeof loadHome === "function") loadHome();
}

function closeClear() {
  if (!clearActive) return;
  finishClear();
}

function ensureMounted() {
  if (document.querySelector("#clear-review")) return;
  const page = document.querySelector("#page");
  if (page) {
    const section = document.createElement("section");
    section.id = "clear-review";
    section.className = "clear-review";
    section.hidden = true;
    section.setAttribute("aria-label", "Clearing what needs you");
    section.innerHTML = `
      <div class="clear-head">
        <span class="clear-icon" id="clear-icon"></span>
        <b class="clear-title" id="clear-title"></b>
        <span class="clear-progress" id="clear-progress"></span>
        <button type="button" class="close-btn clear-close" id="clear-close" aria-label="Back to the page" title="Back to the page"></button>
      </div>
      <div class="clear-fields" id="clear-fields"></div>
      <p class="clear-status" id="clear-status" role="status" aria-live="polite"></p>
      <div class="clear-foot">
        <button type="button" class="clear-btn" id="clear-skip">Skip</button>
        <button type="button" class="clear-btn warn" id="clear-reject">Reject</button>
        <span class="clear-spacer"></span>
        <span class="clear-keys"><kbd>S</kbd><kbd>↵</kbd></span>
        <button type="button" class="clear-btn primary" id="clear-approve">Approve</button>
      </div>`;
    page.appendChild(section);
  }

  const context = document.querySelector("#context");
  if (context) {
    const panel = document.createElement("section");
    panel.id = "clear-context";
    panel.className = "clear-context";
    panel.hidden = true;
    panel.setAttribute("aria-label", "Where it came from");
    panel.innerHTML = `
      <span class="clear-cap">Where it came from</span>
      <div class="clear-quote" id="clear-quote">
        <span class="clear-quote-meta" id="clear-quote-meta"></span>
        <span class="clear-quote-text" id="clear-quote-text"></span>
      </div>
      <div id="clear-built">
        <span class="clear-cap">Built from</span>
        <div class="clear-evidence" id="clear-evidence"></div>
      </div>`;
    context.appendChild(panel);
  }

  document.querySelector("#clear-skip")?.addEventListener("click", skipCurrent);
  document.querySelector("#clear-reject")?.addEventListener("click", rejectCurrent);
  document.querySelector("#clear-approve")?.addEventListener("click", approveCurrent);
  const close = document.querySelector("#clear-close");
  if (close) {
    close.innerHTML = typeof lineIcon === "function" ? lineIcon("x", 15) : "";
    close.addEventListener("click", closeClear);
  }
}

function startClear(needs) {
  if (!Array.isArray(needs) || needs.length === 0) return;
  ensureMounted();
  clearQueue = needs.slice();
  clearIndex = 0;
  clearActive = true;
  setPanelsVisible(true);
  showCurrent();
}

document.querySelector("#clear-needs-btn")?.addEventListener("click", () => startClear(clearNeeds));

document.addEventListener("keydown", (event) => {
  if (!clearActive) return;
  const target = event.target;
  const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
  if (typing) return;
  if (event.key === "s" || event.key === "S") {
    event.preventDefault();
    skipCurrent();
  } else if (event.key === "Enter") {
    event.preventDefault();
    approveCurrent();
  }
});
