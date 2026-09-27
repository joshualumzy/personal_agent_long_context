// SME Employee Assistant Unified Client
const chatForm = document.querySelector("#chat-form");
const messageInput = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const stopButton = document.querySelector("#stop-button");
const chatMessages = document.querySelector("#chat-messages");
const emptyState = document.querySelector("#empty-state");
const statusIndicator = document.querySelector("#status-indicator");
const statusText = document.querySelector("#status-text");
const messagesContainer = document.querySelector("#messages-container");
const suggestionChips = document.querySelectorAll(".chip");
const currentChatTitle = document.querySelector("#current-chat-title");

let currentAbortController = null;

// Sidebar elements
const sidebar = document.querySelector("#sidebar");
const toggleSidebarBtn = document.querySelector("#toggle-sidebar-btn");
const collapseSidebarBtn = document.querySelector("#collapse-sidebar-btn");
const sidebarOverlay = document.querySelector("#sidebar-overlay");
const newChatBtn = document.querySelector("#new-chat-btn");
const conversationsList = document.querySelector("#conversations-list");
const clearAllConversationsBtn = document.querySelector("#clear-all-conversations-btn");

// Dialog elements
const sourceDialog = document.querySelector("#source-dialog");
const closeSourceBtn = document.querySelector("#close-source");
const memoryDialog = document.querySelector("#memory-dialog");
const closeMemoryBtn = document.querySelector("#close-memory");
const inspectMemoryBtn = document.querySelector("#inspect-memory-btn");
const memoryItemsList = document.querySelector("#memory-items-list");

// Model selector elements
const modelSelectorBtn = document.querySelector("#model-selector-btn");
const modelDropdownMenu = document.querySelector("#model-dropdown-menu");
const selectedModelName = document.querySelector("#selected-model-name");
const modelDotIcon = document.querySelector("#model-dot-icon");
/** Browser storage can be blocked (private windows, strict settings); the page works without it. */
const stored = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // not remembered this time
    }
  },
};

// With no model picker on the page, answers always come from the default model.
let activeModel = modelSelectorBtn ? stored.get("sme_selected_model") || "soclaas" : "soclaas";

// Auth & Persona Dialog elements
const loginDialog = document.querySelector("#login-dialog");
const closeLoginDialogBtn = document.querySelector("#close-login-dialog");
const personaSearchInput = document.querySelector("#persona-search-input");
const personaCountLabel = document.querySelector("#persona-count-label");
const loginForm = document.querySelector("#login-form");
const loginPasswordInput = document.querySelector("#login-password");
const loginSubmitBtn = document.querySelector("#login-submit-btn");
const loginErrorMsg = document.querySelector("#login-error-msg");
const personaGrid = document.querySelector("#persona-grid");
const sidebarUserContainer = document.querySelector("#sidebar-user-container");
const sidebarUserAvatar = document.querySelector("#sidebar-user-avatar");
const sidebarUserName = document.querySelector("#sidebar-user-name");
const sidebarUserRole = document.querySelector("#sidebar-user-role");

let currentUser = {
  employeeId: "jax",
  displayName: "Jax",
  role: "Backend Engineer",
  department: "Engineering_Backend",
};

let selectedPersonaId = "jax";
let availablePersonas = [];

try {
  const savedUser = localStorage.getItem("sme_current_user");
  if (savedUser) {
    currentUser = JSON.parse(savedUser);
    selectedPersonaId = currentUser.employeeId;
  }
} catch (_) {}

let activeConversationId = null;
// Bumped whenever another conversation is put on screen; an answer or history asked for
// before that is not about what is shown and must not be drawn or change the active one.
let chatEpoch = 0;
/** A question is being answered; the composer and the chips wait for it. */
let asking = false;
/** The conversation the running question was asked in (null for a new chat). */
let askingIn;
/** Numbers sidebar list requests; only the latest one is drawn. */
let listRequest = 0;
/** The conversation whose history is being fetched, if any. */
let historyLoading = null;
/** What the last loaded history ended with, so an answer arriving after it is not drawn twice. */
let drawnHistory = null;

/** The history on screen already answers this question (it was saved before the history loaded). */
function alreadyDrawn(conversationId, question) {
  return drawnHistory?.conversationId === conversationId && drawnHistory.lastQuestion === question && drawnHistory.answered;
}
/** Answers that finished while their conversation's history was loading, by conversation. */
const finishedAnswers = new Map();
/** Questions that failed while their conversation's history was loading, by conversation. */
const failedQuestions = new Map();

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Line icons in the same stroke style as the sidebar toggle. Emoji are never used as icons.
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
  pin: '<path d="M12 17v5"/><path d="M9 10.76V6h6v4.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 15.24V17H5v-1.76a2 2 0 0 1 1.11-1.79l1.78-.9A2 2 0 0 0 9 10.76Z"/><path d="M8 3h8"/>',
};

function lineIcon(name, size = 14) {
  return `<svg class="line-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LINE_ICONS[name] ?? ""}</svg>`;
}

/** A person is shown by their initial; the directory's emoji avatars are not used. */
function initialOf(name) {
  return (String(name || "").trim()[0] || "?").toUpperCase();
}

function avatarMarkup(person) {
  return escapeHtml(initialOf(person?.displayName));
}

/** Where a page sent the visitor from to sign in; only a path on this site is followed. */
function returnAddress() {
  const next = new URLSearchParams(location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : null;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  // Quotes too: the result also goes inside attribute values.
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatRelativeTime(dateString) {
  if (!dateString) return "";
  const date = new Date(dateString);
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffSec < 60) return "Just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 172800) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Clean, understated Claude-Code-style loading messages
const WAITING_MESSAGES = [
  "Evaluating working context and company evidence…",
  "Herding digital unicorns…",
  "Summoning double rainbows…",
  "Consulting the company oracle…",
  "Brewing a fresh pot of coffee…",
  "Untangling internal Slack threads…",
  "Asking the rubber duck for advice…",
  "Translating engineer thoughts into English…",
  "Searching behind the server racks…",
  "Reticulating workplace splines…",
  "Checking if anyone actually documented this…",
  "Pondering the meaning of life, the universe, and Jira…",
  "Untying knots in the fiber optic cables…",
  "Polishing the facts with a microfiber cloth…",
  "Bribing the database with cookies…",
  "Calculating the velocity of an unladen swallow…",
  "Consulting Jax's past notes and memory…",
  "Synthesizing wisdom from company evidence…",
  "Almost there, tying up loose ends…",
];

let waitingIntervalId = null;

function startWaitingAnimation() {
  stopWaitingAnimation();
  statusIndicator.hidden = false;

  const dynamicMessages = WAITING_MESSAGES.map((m) =>
    m.includes("past notes and memory")
      ? `Consulting ${currentUser?.displayName || "your"} past notes and memory…`
      : m,
  );
  const shuffledPool = [...dynamicMessages.slice(1)].sort(() => Math.random() - 0.5);
  const queue = [dynamicMessages[0], ...shuffledPool];
  let queueIndex = 0;

  statusText.textContent = queue[0];
  statusText.classList.remove("fade-out");

  waitingIntervalId = setInterval(() => {
    queueIndex = (queueIndex + 1) % queue.length;
    statusText.classList.add("fade-out");
    setTimeout(() => {
      statusText.textContent = queue[queueIndex];
      statusText.classList.remove("fade-out");
    }, 220);
  }, 2700);
}

function stopWaitingAnimation() {
  if (waitingIntervalId) {
    clearInterval(waitingIntervalId);
    waitingIntervalId = null;
  }
  statusIndicator.hidden = true;
  statusText.classList.remove("fade-out");
}

function normalizeModelMarkdown(markdown) {
  if (!markdown) return "";
  return markdown.replace(/\*{4}(`[^`\n]+`)\*{4}/g, "$1");
}

/**
 * Puts sanitized HTML into `container` and turns [source:ID] in its text into citation buttons.
 * Only text nodes are touched: a citation inside a link title or image alt stays plain text.
 */
function setAnswerHtml(container, sanitizedHtml) {
  container.innerHTML = sanitizedHtml;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) {
    // A button inside a link would follow the link when pressed; that citation stays text.
    if (!walker.currentNode.parentElement?.closest("a")) texts.push(walker.currentNode);
  }
  // One tag may hold several ids: "[source:JIRA-1, CONF-2]" becomes a button for each.
  const pattern = /\[sources?\s*[:：]\s*([A-Za-z0-9._:：-]+(?:[\s,;，；]+[A-Za-z0-9._:：-]+)*)[\s,;，；]*\]/gi;
  for (const node of texts) {
    const text = node.nodeValue;
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    const pieces = document.createDocumentFragment();
    let at = 0;
    for (const match of text.matchAll(pattern)) {
      pieces.append(text.slice(at, match.index));
      for (const id of match[1].split(/[\s,;，；]+/).map((part) => part.replace(/^sources?[:：]/i, "")).filter(Boolean)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "inline-citation";
        button.dataset.sourceId = id;
        button.textContent = id;
        pieces.append(button);
      }
      at = match.index + match[0].length;
    }
    pieces.append(text.slice(at));
    node.replaceWith(pieces);
  }
}

// Auto-expand textarea
messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 180) + "px";
});

// Submit on Enter without Shift
messageInput.addEventListener("keydown", (e) => {
  // Enter that confirms an input method's text (Chinese, Japanese, Korean) is not a send.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

function isMobile() {
  return typeof window !== "undefined" && window.innerWidth <= 768;
}

function setSidebarCollapsed(collapsed) {
  if (!sidebar) return;
  sidebar.classList.toggle("collapsed", collapsed);
  if (toggleSidebarBtn) {
    toggleSidebarBtn.setAttribute("aria-expanded", String(!collapsed));
    toggleSidebarBtn.title = collapsed ? "Open sidebar (⌘B)" : "Minimize sidebar (⌘B)";
  }
  if (sidebarOverlay) {
    sidebarOverlay.hidden = collapsed || !isMobile();
  }
  try {
    stored.set("sme_sidebar_collapsed", String(collapsed));
  } catch (_) {}
}

function toggleSidebar() {
  if (!sidebar) return;
  const willCollapse = !sidebar.classList.contains("collapsed");
  setSidebarCollapsed(willCollapse);
}

// Toggle sidebar button (in header)
if (toggleSidebarBtn) {
  toggleSidebarBtn.addEventListener("click", toggleSidebar);
}

// Minimize sidebar button (in sidebar header)
if (collapseSidebarBtn) {
  collapseSidebarBtn.addEventListener("click", () => setSidebarCollapsed(true));
}

// Click outside overlay on mobile
if (sidebarOverlay) {
  sidebarOverlay.addEventListener("click", () => setSidebarCollapsed(true));
}

// Keyboard shortcut: Cmd+B (Mac) or Ctrl+B (Windows/Linux), only while there is a sidebar.
if (sidebar) {
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      toggleSidebar();
    }
  });
}

// Restore sidebar state from localStorage or default on mobile
try {
  const savedState = stored.get("sme_sidebar_collapsed");
  if (savedState !== null) {
    setSidebarCollapsed(savedState === "true");
  } else if (isMobile()) {
    setSidebarCollapsed(true);
  }
} catch (_) {}

// Model selector controller
function updateModelSelectorUI(modelId) {
  activeModel = modelId;
  try {
    stored.set("sme_selected_model", modelId);
  } catch (_) {}

  if (selectedModelName) {
    selectedModelName.textContent =
      modelId === "sonnet" ? "Claude 3.5 Sonnet" : "Qwen 2.5 32B";
  }
  if (modelDotIcon) {
    modelDotIcon.className = modelId === "sonnet" ? "model-dot-icon sonnet" : "model-dot-icon";
  }
  if (modelDropdownMenu) {
    modelDropdownMenu.querySelectorAll(".model-option").forEach((opt) => {
      const selected = opt.getAttribute("data-model") === modelId;
      opt.classList.toggle("active", selected);
      opt.setAttribute("aria-checked", String(selected));
    });
  }
}

function showModelNotice(message) {
  let banner = document.querySelector("#model-notice-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "model-notice-banner";
    banner.className = "model-notice-banner";
    const header = document.querySelector(".chat-header") || document.body;
    header.insertAdjacentElement("afterend", banner);
  }
  banner.textContent = message;
  banner.hidden = false;
  setTimeout(() => {
    if (banner) banner.hidden = true;
  }, 6000);
}

async function initModels() {
  updateModelSelectorUI(activeModel);
  try {
    const res = await fetch("/api/v1/models");
    if (!res.ok) return;
    const data = await res.json();
    const availableIds = data.models.filter((m) => m.available).map((m) => m.id);
    if (!availableIds.includes(activeModel)) {
      const previouslyActive = activeModel;
      activeModel = data.default || "soclaas";
      updateModelSelectorUI(activeModel);
      if (previouslyActive === "sonnet") {
        showModelNotice("Claude is unavailable; Qwen selected.");
      }
    }

    if (modelDropdownMenu) {
      data.models.forEach((m) => {
        const opt = modelDropdownMenu.querySelector(`[data-model="${m.id}"]`);
        if (opt) {
          if (!m.available) {
            opt.classList.add("disabled");
            opt.setAttribute("disabled", "");
            opt.style.opacity = "0.45";
            opt.style.pointerEvents = "none";
            opt.title = m.unavailableReason || "Not configured on server";
          } else {
            opt.classList.remove("disabled");
            opt.removeAttribute("disabled");
            opt.style.opacity = "";
            opt.style.pointerEvents = "";
            opt.title = "";
          }
        }
      });
    }
  } catch (_) {}
}

if (modelSelectorBtn && modelDropdownMenu) {
  modelSelectorBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = modelDropdownMenu.hasAttribute("hidden");
    if (isHidden) {
      modelDropdownMenu.removeAttribute("hidden");
      modelSelectorBtn.setAttribute("aria-expanded", "true");
      const selected = modelDropdownMenu.querySelector('.model-option[aria-checked="true"]');
      if (selected instanceof HTMLElement) selected.focus();
    } else {
      modelDropdownMenu.setAttribute("hidden", "");
      modelSelectorBtn.setAttribute("aria-expanded", "false");
    }
  });

  modelDropdownMenu.querySelectorAll(".model-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      const model = opt.getAttribute("data-model");
      if (model) updateModelSelectorUI(model);
      modelDropdownMenu.setAttribute("hidden", "");
      modelSelectorBtn.setAttribute("aria-expanded", "false");
    });
  });

  document.addEventListener("click", (e) => {
    if (!modelSelectorBtn.contains(e.target) && !modelDropdownMenu.contains(e.target)) {
      modelDropdownMenu.setAttribute("hidden", "");
      modelSelectorBtn.setAttribute("aria-expanded", "false");
    }
  });

  modelDropdownMenu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      modelDropdownMenu.setAttribute("hidden", "");
      modelSelectorBtn.setAttribute("aria-expanded", "false");
      modelSelectorBtn.focus();
    }
  });
}

// Role-Tailored Suggestion Prompts (Grounded, Evergreen Questions)
const ROLE_SUGGESTION_PROMPTS = {
  Engineering_Backend: [
    "What is Project Titan and what architecture decisions are recorded for it?",
    "What is our current team policy on production deployment freeze?",
    "Who are the primary code owners and maintainers for our backend services?",
    "What active engineering tasks or focus areas are currently assigned to me?",
  ],
  Engineering_Mobile: [
    "What mobile release schedules and build guidelines are currently documented?",
    "What are the major open crash reports or defects for iOS and Android?",
    "Who is the lead reviewer for our mobile app pull requests?",
    "What mobile deliverables or feature branches are currently assigned to me?",
  ],
  Design: [
    "Where can I find our brand guidelines and design system color tokens?",
    "What user feedback was documented on the recent onboarding flow redesign?",
    "Who signed off on the latest mobile UI navigation specs?",
    "What design reviews or deliverables am I currently responsible for?",
  ],
  Product: [
    "What is the release timeline and approved scope for Project Titan?",
    "What are the top customer pain points reported in Zendesk tickets?",
    "Which engineering leads are currently assigned to the Q3 roadmap epics?",
    "What PRDs and roadmap deliverables are currently tracked under my name?",
  ],
  QA_Support: [
    "What are the critical open P1 and P2 issues logged in Jira right now?",
    "What is our team's escalation procedure when customer tickets breach SLA?",
    "Which services currently have active automated regression test suites?",
    "What test coverage or QA sign-offs am I currently tracking?",
  ],
  HR_Ops: [
    "What are our company guidelines on remote work and equipment stipends?",
    "What is the standard onboarding checklist for new engineering hires?",
    "Who is currently in charge of facilities and office operations across our teams?",
    "What personnel reviews and HR milestones are on my agenda?",
  ],
  Sales_Marketing: [
    "What are our enterprise tier pricing plans and API rate limits?",
    "What customer case studies or product announcements were published recently?",
    "Who is the primary technical contact for enterprise security reviews?",
    "What client accounts and sales outreach deliverables are assigned to me?",
  ],
  Default: [
    "What is Project Titan and what are its key architecture decisions?",
    "Where can I find our company policies on deployments and remote work?",
    "Who are the department leads across Engineering, Product, and Design?",
    "What focus areas or active assignments do I currently have recorded?",
  ],
};

function renderSuggestionChips(user) {
  const container = document.querySelector("#suggestion-chips");
  if (!container) return;

  const dept = user?.department || "";
  const prompts = ROLE_SUGGESTION_PROMPTS[dept] || ROLE_SUGGESTION_PROMPTS.Default;

  container.innerHTML = "";
  prompts.forEach((promptText) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = promptText;
    btn.addEventListener("click", () => {
      messageInput.value = promptText;
      messageInput.dispatchEvent(new Event("input"));
      chatForm.requestSubmit();
    });
    container.appendChild(btn);
  });
}

// Start New Chat
function startNewChat() {
  chatEpoch += 1;
  historyLoading = null;
  activeConversationId = null;
  chatMessages.innerHTML = "";
  if (emptyState) emptyState.style.display = "block";
  if (soboRiveInstance && typeof soboRiveInstance.play === "function") {
    soboRiveInstance.play();
  }
  const emptyTitle = document.querySelector("#empty-state-title");
  if (emptyTitle && currentUser?.displayName) {
    emptyTitle.textContent = `How can I help you today, ${currentUser.displayName}?`;
  }
  renderSuggestionChips(currentUser);
  if (currentUser) loadHome();
  if (currentChatTitle) currentChatTitle.textContent = "Kaki";
  document.querySelectorAll(".conversation-item").forEach((el) => el.classList.remove("active"));
  if (isMobile()) setSidebarCollapsed(true);
  messageInput.focus();
}

if (newChatBtn) {
  newChatBtn.addEventListener("click", startNewChat);
}

async function showSource(sourceId) {
  try {
    const response = await fetch(`/api/v1/company/sources/${encodeURIComponent(sourceId)}`);
    const source = await response.json();
    if (!response.ok) {
      alert(source.message || "Failed to load source details.");
      return;
    }
    document.querySelector("#source-type").textContent = source.sourceType;
    document.querySelector("#source-title").textContent = source.title;
    document.querySelector("#source-meta").textContent = [
      source.sourceId,
      source.occurredAt,
      source.department,
    ]
      .filter(Boolean)
      .join(" · ");
    document.querySelector("#source-body").textContent = source.excerpt;
    sourceDialog.showModal();
  } catch (err) {
    alert("Could not load source details.");
  }
}

closeSourceBtn.addEventListener("click", () => sourceDialog.close());
sourceDialog.addEventListener("click", (e) => {
  if (e.target === sourceDialog) sourceDialog.close();
});

// Inspect working memory (if dialog present)
async function refreshMemoryDialog() {
  if (!memoryDialog || !memoryItemsList) return;
  memoryItemsList.innerHTML = '<p class="loading-text">Loading retained context…</p>';
  try {
    const res = await fetch("/api/v1/me/memory", { credentials: "same-origin" });
    const data = await res.json();
    if (!res.ok) {
      memoryItemsList.innerHTML = `<p class="error-text">${escapeHtml(data.message || "Failed to load memory.")}</p>`;
      return;
    }
    const context = data.workingContext;
    if (!context || !context.trim()) {
      memoryItemsList.innerHTML = `<p>No active memory items retained yet for ${escapeHtml(currentUser?.displayName || "employee")}.</p>`;
      return;
    }
    memoryItemsList.innerHTML = "";
    const card = document.createElement("div");
    card.className = "memory-item-card";
    card.innerHTML = `
      <div class="item-header">
        <strong>Working Context</strong>
        <small>${escapeHtml(data.employeeId || "")}</small>
      </div>
      <pre>${escapeHtml(context)}</pre>
    `;
    memoryItemsList.appendChild(card);
  } catch (err) {
    memoryItemsList.innerHTML = '<p class="error-text">Could not load working memory.</p>';
  }
}

if (inspectMemoryBtn && memoryDialog) {
  inspectMemoryBtn.addEventListener("click", () => {
    memoryDialog.showModal();
    refreshMemoryDialog();
  });
}

if (closeMemoryBtn && memoryDialog) {
  closeMemoryBtn.addEventListener("click", () => memoryDialog.close());
}

if (memoryDialog) {
  memoryDialog.addEventListener("click", (e) => {
    if (e.target === memoryDialog) memoryDialog.close();
  });
}

function appendUserMessage(text) {
  const row = document.createElement("div");
  row.className = "message-row user";
  row.innerHTML = `<div class="message-bubble"><p>${escapeHtml(text)}</p></div>`;
  chatMessages.appendChild(row);
  scrollToBottom();
}

function appendAssistantMessage(data) {
  const row = document.createElement("div");
  row.className = "message-row assistant";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  // Parse markdown
  const normalized = normalizeModelMarkdown(data.answer);
  const rawHtml = marked.parse(normalized, { gfm: true, breaks: false });
  const sanitized = DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
  const textContainer = document.createElement("div");
  textContainer.className = "message-text";
  setAnswerHtml(textContainer, sanitized);

  // Add click listeners to inline citations
  textContainer.querySelectorAll(".inline-citation").forEach((btn) => {
    btn.addEventListener("click", () => showSource(btn.getAttribute("data-source-id")));
  });

  bubble.appendChild(textContainer);
  attachAssistantMeta(bubble, data);

  row.appendChild(bubble);
  chatMessages.appendChild(row);
  scrollToBottom();
}

function formatRuntime(durationMs) {
  if (typeof durationMs !== "number" || isNaN(durationMs)) return null;
  const totalStr = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
  return {
    label: totalStr,
    tooltip: `Response time: ${totalStr}`,
  };
}

const PANEL_LABELS = {
  criteria: "Review the criteria",
  pool: "Candidates",
  candidate: "Candidate",
};

function panelSource(block) {
  const query = new URLSearchParams({ embed: "1" });
  if (block.roleId) query.set("role", block.roleId);
  if (block.candidateId) query.set("candidate", block.candidateId);
  return `/recruiting?${query}`;
}

// The panel fits in the visible chat area, so the orbit is never cut by the composer.
function panelHeight() {
  const available = messagesContainer.clientHeight - 64;
  return Math.max(360, Math.min(620, available));
}

window.addEventListener("resize", () => {
  const height = `${panelHeight()}px`;
  document.querySelectorAll(".chat-block.live iframe").forEach((frame) => (frame.style.height = height));
});

/** A panel with text typed but not yet used (a pass reason, a reply, a draft edit): folding it would lose that. */
function holdsUnsavedText(container) {
  try {
    const frame = container.querySelector("iframe");
    // The panel knows best: typed text it keeps across its own redraws, cleared once saved or used.
    const ask = frame?.contentWindow?.hasUnsavedText;
    if (typeof ask === "function") return Boolean(ask());
    const doc = frame?.contentDocument;
    if (!doc) return false;
    return [...doc.querySelectorAll("textarea, input")].some((box) => {
      if (box.tagName === "INPUT" && ["button", "submit", "checkbox", "radio", "file", "hidden"].includes(box.type)) return false;
      return box.value !== box.defaultValue && box.value.trim() !== "";
    });
  } catch {
    return false;
  }
}

// Only the newest panel stays live; older ones fold into a button so they stop polling.
function mountPanel(container, block) {
  document.querySelectorAll(".chat-block.live").forEach((other) => {
    // A panel the founder is typing in stays open; folding it would throw the text away.
    const active = document.activeElement;
    let typed = null;
    try {
      typed = active?.tagName === "IFRAME" ? active.contentDocument?.activeElement : null;
    } catch {
      typed = null;
    }
    const inUse = (other.contains(active) && Boolean(typed) &&
      (typed.tagName === "TEXTAREA" || typed.tagName === "INPUT" || typed.isContentEditable)) || holdsUnsavedText(other);
    if (other !== container && !inUse) foldPanel(other, other.recruitingBlock);
  });
  const frame = document.createElement("iframe");
  frame.src = panelSource(block);
  frame.title = `Hiring panel: ${PANEL_LABELS[block.view] || "Candidates"}`;
  frame.loading = "lazy";
  frame.style.height = `${panelHeight()}px`;
  container.querySelector(".chat-block-body").replaceChildren(frame);
  container.classList.add("live");
}

function foldPanel(container, block) {
  const reopen = document.createElement("button");
  reopen.type = "button";
  reopen.className = "chat-block-reopen";
  reopen.textContent = "Show this panel";
  reopen.addEventListener("click", () => mountPanel(container, block));
  container.querySelector(".chat-block-body").replaceChildren(reopen);
  container.classList.remove("live");
}

function renderBlocks(bubble, blocks, live) {
  const recruiting = (blocks || []).filter((block) => block && block.type === "recruiting");
  if (recruiting.length === 0) return;
  bubble.classList.add("has-block");
  // One panel per message is enough: the last one the agent asked for.
  const block = recruiting[recruiting.length - 1];
  const container = document.createElement("div");
  container.className = "chat-block";
  container.recruitingBlock = block;

  const head = document.createElement("div");
  head.className = "chat-block-head";
  const label = document.createElement("span");
  label.textContent = `Hiring · ${PANEL_LABELS[block.view] || "Candidates"}`;
  head.append(label);
  // The panel is where hiring happens; pinning keeps it in view, so there is no separate full page.
  if (block.roleId) head.append(pinButton(block));

  const body = document.createElement("div");
  body.className = "chat-block-body";
  container.append(head, body);
  bubble.appendChild(container);
  if (showsPinned(block)) markShownOnRight(container);
  else if (live) mountPanel(container, block);
  else foldPanel(container, block);
}

// ------------------------------------------------------------- pinned panel

/**
 * A role's candidates can stay beside the chat while the conversation goes
 * on: choices, questions and follow-ups on the left, the people found on the
 * right. While pinned, the same candidates are not repeated inline.
 */
let pinnedRole = null;
const pinnedPanel = document.querySelector("#pinned-panel");

function showsPinned(block) {
  return Boolean(pinnedRole) && block.roleId === pinnedRole && (block.view || "pool") === "pool";
}

function pinButton(block) {
  const pin = document.createElement("button");
  pin.type = "button";
  pin.className = "pin-panel";
  pin.innerHTML = `${lineIcon("pin", 12)}Pin beside the chat`;
  pin.hidden = pinnedRole === block.roleId;
  pin.addEventListener("click", () => pinPanel(block));
  return pin;
}

// A role already pinned offers no second pin; unpinning brings the buttons back.
function refreshPinButtons() {
  document.querySelectorAll(".chat-block").forEach((container) => {
    const pin = container.querySelector(".pin-panel");
    if (pin && container.recruitingBlock) pin.hidden = pinnedRole === container.recruitingBlock.roleId;
  });
}

function markShownOnRight(container) {
  const note = document.createElement("p");
  note.className = "chat-block-note";
  note.textContent = "Shown on the right";
  container.querySelector(".chat-block-body").replaceChildren(note);
  container.classList.remove("live");
}

function pinPanel(block) {
  pinnedRole = block.roleId;
  const frame = document.createElement("iframe");
  frame.src = panelSource({ roleId: block.roleId, view: "pool" });
  frame.title = "Pinned hiring panel: Candidates";
  pinnedPanel.querySelector(".pinned-body").replaceChildren(frame);
  pinnedPanel.hidden = false;
  document.body.classList.add("has-pinned");
  refreshPinButtons();
  document.querySelectorAll(".chat-block").forEach((container) => {
    if (container.recruitingBlock && showsPinned(container.recruitingBlock)) markShownOnRight(container);
  });
}

function unpinPanel() {
  pinnedRole = null;
  pinnedPanel.hidden = true;
  pinnedPanel.querySelector(".pinned-body").replaceChildren();
  document.body.classList.remove("has-pinned");
  refreshPinButtons();
  document.querySelectorAll(".chat-block").forEach((container) => {
    if (container.recruitingBlock && container.querySelector(".chat-block-note")) foldPanel(container, container.recruitingBlock);
  });
}

pinnedPanel?.querySelector(".unpin-panel").addEventListener("click", unpinPanel);

function attachAssistantMeta(bubble, data) {
  renderBlocks(bubble, data.blocks, !data.fromHistory);

  const meta = document.createElement("div");
  meta.className = "message-meta";

  const contextTags = document.createElement("div");
  contextTags.className = "context-tags";

  if (data.stopped) {
    const stopTag = document.createElement("span");
    stopTag.className = "context-tag";
    stopTag.innerHTML = `${lineIcon("stop", 12)}Stopped`;
    stopTag.title = "Response generation was cancelled by user";
    contextTags.appendChild(stopTag);
  }

  // Not shown for now: which model answered, how long it took, and the
  // working-context notes. Kept here to bring back.
  /*
  if (data.model) {
    const modelTag = document.createElement("span");
    modelTag.className = `context-tag model-badge ${data.model}`;
    modelTag.textContent = data.model === "sonnet" ? "Claude Sonnet" : "SoCLaaS Qwen";
    modelTag.title =
      data.model === "sonnet"
        ? "Answered using Claude 3.5 Sonnet on AWS Bedrock"
        : "Answered using Qwen 2.5 32B on NUS SoCLaaS";
    contextTags.appendChild(modelTag);
  }

  const runtime = formatRuntime(data.durationMs, data.ttftMs);
  if (runtime) {
    const tag = document.createElement("span");
    tag.className = "context-tag runtime";
    tag.textContent = runtime.label;
    tag.title = runtime.tooltip;
    contextTags.appendChild(tag);
  }

  if (data.personalMemory) {
    if (data.personalMemory.memoryUpdated) {
      const tag = document.createElement("span");
      tag.className = "context-tag updated";
      tag.innerHTML = `${lineIcon("save", 12)}Working memory updated`;
      contextTags.appendChild(tag);
    }
    if (data.personalMemory.status === "unavailable") {
      const tag = document.createElement("span");
      tag.className = "context-tag unavailable";
      tag.innerHTML = `${lineIcon("alert", 12)}Personal memory unavailable`;
      if (data.personalMemory.reason) tag.title = data.personalMemory.reason;
      contextTags.appendChild(tag);
    } else if (data.personalMemory.answer && data.personalMemory.answer.trim().length > 0) {
      const tag = document.createElement("span");
      tag.className = "context-tag referenced";
      tag.innerHTML = `${lineIcon("book", 12)}Working context referenced`;
      tag.title = data.personalMemory.answer;
      contextTags.appendChild(tag);
    }
  }

  */

  if (contextTags.children.length > 0) {
    meta.appendChild(contextTags);
  }

  // The answer's graph: a small picture of what its evidence connects to,
  // above the evidence itself. Opens larger on click.
  if (data.question && data.sources && data.sources.length > 0) {
    meta.appendChild(answerGraphPreview(data.question, data.sources));
  }

  // Sources grid
  if (data.sources && data.sources.length > 0) {
    const sourcesGrid = document.createElement("div");
    sourcesGrid.className = "sources-grid";

    for (const source of data.sources) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "source-card";
      card.innerHTML = `
        <span>${escapeHtml(source.sourceType || "source")}</span>
        <strong>${escapeHtml(source.title || source.sourceId)}</strong>
        <small>${escapeHtml(source.sourceId)}</small>
      `;
      card.addEventListener("click", () => showSource(source.sourceId));
      sourcesGrid.appendChild(card);
    }
    meta.appendChild(sourcesGrid);
  }

  if (meta.children.length > 0) {
    bubble.appendChild(meta);
  }
}

// ---------------------------------------------------------------------------
// The answer's graph
// ---------------------------------------------------------------------------

/** /api/v1/graph/query for this answer: centred on its question, seeded from
 * the evidence it cited (in the order cited), so the picture is of what the
 * answer drew on rather than of a fresh search. */
function answerGraphParams(question, sources) {
  return new URLSearchParams({
    q: question,
    sources: sources.map((source) => source.sourceId).filter(Boolean).slice(0, 20).join(","),
  });
}

function answerGraphPreview(question, sources) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "answer-graph loading";
  button.setAttribute("aria-label", "How this answer's evidence connects. Open the graph larger.");
  button.innerHTML = `
    <svg class="answer-graph-picture" viewBox="-190 -84 380 168" aria-hidden="true"></svg>
    <span class="answer-graph-caption">
      <span class="answer-graph-title">${lineIcon("graph", 12)}How the evidence connects</span>
      <span class="answer-graph-count">Loading…</span>
    </span>`;
  button.addEventListener("click", () => openAnswerGraph(question, sources));

  // Fetched once the preview is near the screen: a long history would
  // otherwise ask for every answer's graph at once.
  const load = () => loadAnswerGraphPreview(button, question, sources);
  if (typeof IntersectionObserver === "function") {
    const watcher = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        watcher.disconnect();
        load();
      }
    }, { rootMargin: "200px" });
    watcher.observe(button);
  } else {
    load();
  }
  return button;
}

async function loadAnswerGraphPreview(button, question, sources) {
  try {
    const response = await fetch(`/api/v1/graph/query?${answerGraphParams(question, sources)}`);
    if (!response.ok) throw new Error(String(response.status));
    const slice = await response.json();
    const nodes = Array.isArray(slice?.nodes) ? slice.nodes : [];
    // Nothing but the question itself: no picture worth showing.
    if (nodes.length < 2) {
      button.remove();
      return;
    }
    drawAnswerGraph(button.querySelector("svg"), slice);
    button.classList.remove("loading");
    const seeds = nodes.length - 1;
    button.querySelector(".answer-graph-count").textContent =
      `${seeds} ${seeds === 1 ? "thing" : "things"} it points to · click to explore`;
  } catch {
    // The answer stands without its picture.
    button.remove();
  }
}

/** A small, fixed picture: the question in the middle, what it points at
 * around it on an ellipse, and the edges between them. Kinds are told apart
 * by shape as on the graph page. */
function drawAnswerGraph(svg, slice) {
  const centreId = slice.centre ?? slice.nodes[0].id;
  const others = slice.nodes.filter((node) => node.id !== centreId);
  const at = new Map([[centreId, { x: 0, y: 0 }]]);
  others.forEach((node, index) => {
    const angle = -Math.PI / 2 + (index / others.length) * Math.PI * 2;
    at.set(node.id, { x: Math.cos(angle) * 128, y: Math.sin(angle) * 54 });
  });
  // The namespace is read off the <svg> itself: this script names no URLs.
  const make = (tag, attributes) => {
    const element = document.createElementNS(svg.namespaceURI, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  };
  const shape = (node) => {
    switch (node.type) {
      case "person": return make("polygon", { points: "0,-5 5,0 0,5 -5,0", class: "ag-person" });
      case "organization": return make("polygon", { points: "-3,-5 3,-5 5,0 3,5 -3,5 -5,0", class: "ag-organization" });
      case "event": return make("rect", { x: -4, y: -4, width: 8, height: 8, class: "ag-event" });
      case "document": return make("polygon", { points: "0,-5 5,4 -5,4", class: "ag-document" });
      case "query": return make("circle", { r: 7, class: "ag-query" });
      default: return make("circle", { r: 5, class: "ag-item" });
    }
  };
  svg.replaceChildren();
  for (const edge of slice.edges) {
    const a = at.get(edge.source);
    const b = at.get(edge.target);
    if (!a || !b) continue;
    svg.append(make("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `ag-edge ${edge.type === "matches" ? "matches" : ""}` }));
  }
  for (const node of slice.nodes) {
    const point = at.get(node.id);
    const group = make("g", { transform: `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})` });
    group.append(shape(node));
    if (node.id !== centreId) {
      const label = node.label || node.refKey || node.id;
      const text = make("text", { y: point.y < 0 ? -9 : 14, class: "ag-label" });
      text.textContent = label.length > 20 ? `${label.slice(0, 19)}…` : label;
      group.append(text);
    }
    svg.append(group);
  }
}

/** The full graph page for this answer, in a dialog over the chat: expand by
 * clicking, filter by kind, read each item's details and evidence. */
function openAnswerGraph(question, sources) {
  let dialog = document.querySelector("#answer-graph-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "answer-graph-dialog";
    dialog.className = "answer-graph-dialog";
    dialog.setAttribute("aria-label", "How this answer's evidence connects");
    dialog.innerHTML = `
      <div class="answer-graph-dialog-bar">
        <span class="answer-graph-dialog-title"></span>
        <button type="button" class="close-btn" aria-label="Close the graph" title="Close (Esc)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </div>
      <iframe title="How this answer's evidence connects"></iframe>`;
    dialog.querySelector(".close-btn").addEventListener("click", () => dialog.close());
    // Esc pressed inside the graph goes to the frame's document, not to the
    // dialog; the frame is same-origin, so listen there too.
    dialog.querySelector("iframe").addEventListener("load", (event) => {
      try {
        event.target.contentWindow.addEventListener("keydown", (key) => {
          if (key.key === "Escape") dialog.close();
        });
      } catch {
        // Not reachable: the close button and a click outside still work.
      }
    });
    // Clicking the dim area outside the sheet closes it too.
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    document.body.appendChild(dialog);
  }
  dialog.querySelector(".answer-graph-dialog-title").textContent = question;
  const params = answerGraphParams(question, sources);
  params.set("embed", "1");
  dialog.querySelector("iframe").src = `/graph/answer?${params}`;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function appendErrorMessage(message) {
  const row = document.createElement("div");
  row.className = "message-row assistant";
  row.innerHTML = `
    <div class="message-bubble error-bubble">
      <strong>Unable to complete request</strong>
      <p style="margin: 4px 0 0;">${escapeHtml(message)}</p>
    </div>
  `;
  chatMessages.appendChild(row);
  scrollToBottom();
}

function showConfirmDialog({
  title = "Are you sure?",
  message = "This action cannot be undone.",
  icon = "trash",
  confirmText = "Delete",
  destructive = true,
} = {}) {
  const dialog = document.querySelector("#confirm-dialog");
  if (!dialog || typeof dialog.showModal !== "function") {
    return Promise.resolve(window.confirm ? window.confirm(`${title}\n${message}`) : true);
  }

  const titleEl = document.querySelector("#confirm-dialog-title");
  const messageEl = document.querySelector("#confirm-dialog-message");
  const iconEl = document.querySelector("#confirm-modal-icon");
  const cancelBtn = document.querySelector("#confirm-cancel-btn");
  const actionBtn = document.querySelector("#confirm-action-btn");

  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  if (iconEl) iconEl.innerHTML = lineIcon(icon, 22);
  if (actionBtn) {
    actionBtn.textContent = confirmText;
    actionBtn.className = destructive ? "confirm-btn destructive" : "confirm-btn secondary";
  }

  return new Promise((resolve) => {
    let resolved = false;

    function cleanup(result) {
      if (resolved) return;
      resolved = true;
      cancelBtn?.removeEventListener("click", onCancel);
      actionBtn?.removeEventListener("click", onConfirm);
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("click", onBackdrop);
      if (dialog.open) dialog.close();
      resolve(result);
    }

    function onCancel() {
      cleanup(false);
    }

    function onConfirm() {
      cleanup(true);
    }

    function onBackdrop(e) {
      if (e.target === dialog) {
        cleanup(false);
      }
    }

    cancelBtn?.addEventListener("click", onCancel);
    actionBtn?.addEventListener("click", onConfirm);
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("click", onBackdrop);

    dialog.showModal();
    actionBtn?.focus();
  });
}

// Conversation Management
async function loadConversations() {
  if (!conversationsList) return;
  const asked = ++listRequest;
  try {
    const response = await fetch("/api/v1/conversations", {
      credentials: "same-origin",
    });
    if (!response.ok) {
      if (response.status === 401) handleAuthRequired();
      return;
    }
    const conversations = await response.json();
    // A list asked for later (after a delete, say) may already be drawn.
    if (asked !== listRequest) return;

    if (!Array.isArray(conversations) || conversations.length === 0) {
      conversationsList.innerHTML = '<div class="conversations-empty">No saved chats yet</div>';
      if (clearAllConversationsBtn) clearAllConversationsBtn.setAttribute("hidden", "");
      return;
    }

    if (clearAllConversationsBtn) clearAllConversationsBtn.removeAttribute("hidden");

    conversationsList.innerHTML = "";
    for (const conv of conversations) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "conversation-item";
      if (conv.conversationId === activeConversationId) {
        item.classList.add("active");
      }
      item.dataset.conversationId = conv.conversationId;

      item.innerHTML = `
        <div class="conv-main">
          <span class="conv-icon">${lineIcon("message", 14)}</span>
          <span class="conv-title" title="${escapeHtml(conv.title)}">${escapeHtml(conv.title)}</span>
        </div>
        <div class="conv-meta">
          <span class="conv-date">${escapeHtml(formatRelativeTime(conv.updatedAt))}</span>
          <button type="button" class="conv-delete-btn" title="Delete conversation" aria-label="Delete conversation">${lineIcon("x", 13)}</button>
        </div>
      `;

      item.addEventListener("click", (e) => {
        if (e.target.closest(".conv-delete-btn")) return;
        selectConversation(conv.conversationId, conv.title);
      });

      const delBtn = item.querySelector(".conv-delete-btn");
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const confirmed = await showConfirmDialog({
          title: "Delete conversation?",
          message: `Are you sure you want to delete "${conv.title}"? This cannot be undone.`,
          confirmText: "Delete",
          destructive: true,
        });
        if (confirmed) {
          await deleteConversation(conv.conversationId);
        }
      });

      conversationsList.appendChild(item);
    }
  } catch (err) {
    console.warn("Could not load conversations", err);
  }
}

if (clearAllConversationsBtn) {
  clearAllConversationsBtn.addEventListener("click", async () => {
    const name = currentUser?.displayName || "your account";
    const confirmed = await showConfirmDialog({
      title: "Clear all conversations?",
      message: `Delete all saved conversations for ${name}? This action cannot be undone.`,
      confirmText: "Clear all",
      destructive: true,
    });
    if (confirmed) {
      try {
        const response = await fetch("/api/v1/conversations", {
          method: "DELETE",
          credentials: "same-origin",
        });
        if (response.ok) {
          startNewChat();
          await loadConversations();
        }
      } catch (err) {
        console.warn("Could not clear conversations", err);
      }
    }
  });
}

function updateConversationTitleUI(convId, title) {
  if (!title) return;
  if (!convId || convId === activeConversationId) {
    if (currentChatTitle) currentChatTitle.textContent = title;
  }
  const item = document.querySelector(`.conversation-item[data-conversation-id="${convId}"]`);
  if (item) {
    const titleEl = item.querySelector(".conv-title");
    if (titleEl) {
      titleEl.textContent = title;
      titleEl.title = title;
    }
  }
}

async function selectConversation(conversationId, title) {
  const asked = ++chatEpoch;
  try {
    activeConversationId = conversationId;
    if (currentChatTitle) currentChatTitle.textContent = title || "SME Assistant";

    // Update active class in sidebar
    document.querySelectorAll(".conversation-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.conversationId === conversationId);
    });

    if (isMobile()) {
      setSidebarCollapsed(true);
    }

    statusIndicator.hidden = false;
    statusText.textContent = "Loading conversation…";
    historyLoading = conversationId;

    const response = await fetch(`/api/v1/conversations/${encodeURIComponent(conversationId)}`, {
      credentials: "same-origin",
    });
    if (!response.ok) {
      if (response.status === 401) {
        handleAuthRequired();
        return;
      }
      throw new Error("Failed to load conversation");
    }
    const detail = await response.json();
    // Another conversation was opened while this one loaded.
    if (asked !== chatEpoch) return;

    chatMessages.innerHTML = "";
    if (detail.messages && detail.messages.length > 0) {
      if (emptyState) emptyState.style.display = "none";
      let askedBefore;
      for (const msg of detail.messages) {
        if (msg.role === "user") {
          askedBefore = msg.content;
          appendUserMessage(msg.content);
        } else if (msg.role === "assistant") {
          appendAssistantMessage({
            question: askedBefore,
            answer: msg.content,
            sources: msg.metadata?.sources,
            personalMemory: msg.metadata?.personalMemory,
            durationMs: typeof msg.metadata?.durationMs === "number" ? msg.metadata.durationMs : undefined,
            ttftMs: typeof msg.metadata?.ttftMs === "number" ? msg.metadata.ttftMs : undefined,
            model: msg.metadata?.model,
            blocks: msg.metadata?.blocks,
            fromHistory: true,
          });
        }
      }
    } else {
      if (emptyState) emptyState.style.display = "block";
    }
    historyLoading = null;
    // An answer that finished while this history was loading, and is not in it yet.
    const pending = finishedAnswers.get(conversationId);
    finishedAnswers.delete(conversationId);
    const messages = detail.messages ?? [];
    const lastQuestionAt = messages.map((msg) => msg.role).lastIndexOf("user");
    drawnHistory = {
      conversationId,
      lastQuestion: lastQuestionAt >= 0 ? messages[lastQuestionAt].content : undefined,
      answered: lastQuestionAt >= 0 && messages.slice(lastQuestionAt + 1).some((msg) => msg.role === "assistant"),
    };
    if (pending && !alreadyDrawn(conversationId, pending.question)) {
      appendAssistantMessage({ ...pending.payload, question: pending.question });
      drawnHistory = { conversationId, lastQuestion: pending.question, answered: true };
    }
    const failed = failedQuestions.get(conversationId);
    failedQuestions.delete(conversationId);
    if (failed && !alreadyDrawn(conversationId, failed.question)) appendErrorMessage(failed.text);
  } catch (err) {
    if (asked === chatEpoch) {
      historyLoading = null;
      if (currentChatTitle) currentChatTitle.textContent = "SME Assistant";
      document.querySelectorAll(".conversation-item.active").forEach((el) => el.classList.remove("active"));
      // Nothing of the conversation that was open before may stay under this one's title,
      // and the next message must not go to a conversation that could not be read.
      activeConversationId = null;
      chatMessages.innerHTML = "";
      appendErrorMessage("Could not load this conversation. Pick it again, or start a new chat.");
    }
  } finally {
    // Only the load for what is on screen touches the status line; a load the founder moved away
    // from must not hide the progress of the conversation they came back to.
    if (asked === chatEpoch) {
      // Still answering a question asked here earlier: say so, instead of looking stuck.
      const answering = asking && askingIn === conversationId;
      statusIndicator.hidden = !answering;
      if (answering) statusText.textContent = "Still working on your question…";
    }
    scrollToBottom();
  }
}

async function deleteConversation(conversationId) {
  try {
    const res = await fetch(`/api/v1/conversations/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (res.status === 401) {
      handleAuthRequired();
      return;
    }
    // Already gone counts as deleted; anything else leaves the chat where it is.
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    // Gone from the list now, even if reloading the list fails.
    document.querySelectorAll(".conversation-item").forEach((el) => {
      if (el.dataset.conversationId === conversationId) el.remove();
    });
    if (activeConversationId === conversationId) {
      startNewChat();
    }
    await loadConversations();
  } catch (err) {
    appendErrorMessage("Could not delete the conversation. It is still saved; try again.");
  }
}

if (stopButton) {
  stopButton.addEventListener("click", () => {
    if (currentAbortController) {
      currentAbortController.abort();
    }
  });
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && currentAbortController) {
    currentAbortController.abort();
  }
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = messageInput.value.trim();
  // Not while a conversation's history is loading: it would redraw over this question.
  if (!message || asking || historyLoading) return;
  asking = true;

  if (emptyState) {
    emptyState.style.display = "none";
  }

  appendUserMessage(message);

  currentAbortController = new AbortController();
  messageInput.value = "";
  messageInput.style.height = "auto";
  messageInput.disabled = true;
  sendButton.hidden = true;
  if (stopButton) stopButton.hidden = false;

  startWaitingAnimation();
  scrollToBottom();

  const requestStartTime = performance.now();
  let ttftMs = null;
  const epoch = chatEpoch;
  const stillHere = () => epoch === chatEpoch;
  const sentTo = activeConversationId;
  askingIn = sentTo;
  let assistantRow = null;
  let bubble = null;
  let textContainer = null;
  let accumulatedContent = "";
  let finalPayload = null;

  try {
    const payload = {
      message,
      stream: true,
      model: activeModel,
    };
    if (activeConversationId) {
      payload.conversationId = activeConversationId;
    }

    const response = await fetch("/api/v1/agent/chat", {
      method: "POST",
      headers: {
        "accept": "text/event-stream, application/json",
        "content-type": "application/json",
      },
      credentials: "same-origin",
      body: JSON.stringify(payload),
      signal: currentAbortController.signal,
    });

    if (!response.ok) {
      if (response.status === 401) {
        handleAuthRequired();
        return;
      }
      let errMessage = `Request failed with code ${response.status}`;
      try {
        const errData = await response.json();
        if (errData.error === "provider_unavailable" || response.status === 503) {
          errMessage = errData.message || "The selected model is temporarily unavailable—retry.";
        } else if (errData.message) {
          errMessage = errData.message;
        }
      } catch (_) {}
      throw new Error(errMessage);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      const data = await response.json();
      const clientDurationMs = Math.round(performance.now() - requestStartTime);
      data.durationMs = typeof data.durationMs === "number" ? data.durationMs : clientDurationMs;
      if (!stillHere()) {
        loadConversations();
        return;
      }
      if (data.conversationId) {
        activeConversationId = data.conversationId;
        if (data.title) {
          updateConversationTitleUI(data.conversationId, data.title);
        }
        loadConversations();
      }
      appendAssistantMessage({ ...data, question: message });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "message";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";

      for (const frame of frames) {
        const lines = frame.split("\n");
        let event = currentEvent;
        let dataStr = "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          if (line.startsWith("event:")) {
            event = line.slice(6).trim();
            currentEvent = event;
          } else if (line.startsWith("data:")) {
            dataStr = line.slice(5).trim();
          }
        }
        if (!dataStr) continue;

        let parsed = null;
        try {
          parsed = JSON.parse(dataStr);
        } catch (_) {
          parsed = dataStr;
        }

        const shownAgain = sentTo !== null && sentTo === activeConversationId && !historyLoading;
        if (!stillHere() && shownAgain && event === "status") {
          if (statusText && parsed?.phrase) statusText.textContent = parsed.phrase;
        } else if (!stillHere() && event !== "done" && event !== "error") {
          // The user opened another conversation: keep reading, draw nothing.
        } else if (event === "status") {
          if (statusText && parsed?.phrase) {
            statusText.textContent = parsed.phrase;
          }
        } else if (event === "reset_tokens") {
          accumulatedContent = "";
          if (assistantRow) {
            assistantRow.remove();
            assistantRow = null;
            bubble = null;
            textContainer = null;
          }
          ttftMs = null;
          startWaitingAnimation();
        } else if (event === "token") {
          if (ttftMs === null) {
            ttftMs = Math.round(performance.now() - requestStartTime);
          }
          if (!assistantRow) {
            stopWaitingAnimation();
            assistantRow = document.createElement("div");
            assistantRow.className = "message-row assistant";
            bubble = document.createElement("div");
            bubble.className = "message-bubble";
            textContainer = document.createElement("div");
            textContainer.className = "message-text";
            bubble.appendChild(textContainer);
            assistantRow.appendChild(bubble);
            chatMessages.appendChild(assistantRow);
          }
          accumulatedContent += (parsed.delta || "");
          const normalized = normalizeModelMarkdown(accumulatedContent);
          const rawHtml = marked.parse(normalized, { gfm: true, breaks: false });
          const sanitized = DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
          setAnswerHtml(textContainer, sanitized);
          textContainer.querySelectorAll(".inline-citation").forEach((btn) => {
            btn.addEventListener("click", () => showSource(btn.getAttribute("data-source-id")));
          });
          scrollToBottom();
        } else if (event === "answer") {
          stopWaitingAnimation();
          if (ttftMs === null) {
            ttftMs = Math.round(performance.now() - requestStartTime);
          }
          if (!assistantRow) {
            assistantRow = document.createElement("div");
            assistantRow.className = "message-row assistant";
            bubble = document.createElement("div");
            bubble.className = "message-bubble";
            textContainer = document.createElement("div");
            textContainer.className = "message-text";
            bubble.appendChild(textContainer);
            assistantRow.appendChild(bubble);
            chatMessages.appendChild(assistantRow);
          }
          const text = parsed?.text || "";
          accumulatedContent = text;
          const normalized = normalizeModelMarkdown(text);
          const rawHtml = marked.parse(normalized, { gfm: true, breaks: false });
          const sanitized = DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
          setAnswerHtml(textContainer, sanitized);
          textContainer.querySelectorAll(".inline-citation").forEach((btn) => {
            btn.addEventListener("click", () => showSource(btn.getAttribute("data-source-id")));
          });
          scrollToBottom();
        } else if (event === "title") {
          if (parsed?.title && parsed?.conversationId) {
            updateConversationTitleUI(parsed.conversationId, parsed.title);
          }
        } else if (event === "done") {
          finalPayload = parsed;
        } else if (event === "error") {
          if (assistantRow && !accumulatedContent.trim()) assistantRow.remove();
          const msg =
            parsed?.message ||
            (parsed?.error === "provider_unavailable"
              ? "The selected model is temporarily unavailable—retry."
              : "Agent request failed.");
          throw new Error(msg);
        }
      }
    }

    // The question travels with its answer, for the answer's graph.
    if (finalPayload) finalPayload.question = message;

    if (!stillHere()) {
      // The answer is saved in its own conversation. If that conversation is back on screen (the
      // user left and returned, and its history loaded before the answer was saved), draw it now.
      const id = finalPayload?.conversationId;
      if (finalPayload && id && id === activeConversationId) {
        finalPayload.durationMs = typeof finalPayload.durationMs === "number" ? finalPayload.durationMs : Math.round(performance.now() - requestStartTime);
        if (historyLoading === id) {
          // Its history is still on its way: that load draws it if the history lacks it.
          finishedAnswers.set(id, { payload: finalPayload, question: message });
        } else if (!alreadyDrawn(id, message)) {
          appendAssistantMessage(finalPayload);
          drawnHistory = { conversationId: id, lastQuestion: message, answered: true };
        }
      }
      loadConversations();
      // Cut off with no answer: reported below if the user is back in this conversation.
      if (!finalPayload) throw new Error("The answer was cut off before it finished. Please try again.");
      return;
    }
    if (!finalPayload) throw new Error("The answer was cut off before it finished. Please try again.");
    const clientDurationMs = Math.round(performance.now() - requestStartTime);
    if (finalPayload) {
      if (finalPayload.persistenceStatus === "failed") {
        showModelNotice("Answer delivered, but this chat was not saved.");
      }
      if (finalPayload.conversationId) {
        activeConversationId = finalPayload.conversationId;
        if (finalPayload.title) {
          updateConversationTitleUI(finalPayload.conversationId, finalPayload.title);
        }
        loadConversations();
      }
      if (finalPayload.personalMemory?.memoryUpdated && memoryDialog && memoryDialog.open) {
        refreshMemoryDialog();
      }
      finalPayload.durationMs = typeof finalPayload.durationMs === "number" ? finalPayload.durationMs : clientDurationMs;
      finalPayload.ttftMs = typeof finalPayload.ttftMs === "number" ? finalPayload.ttftMs : ttftMs;
      if (bubble) {
        // The server's final answer can hold more than the last streamed step (text the model
        // wrote alongside a tool call, a translation, a repaired citation): show that.
        if (typeof finalPayload.answer === "string" && finalPayload.answer.trim() && textContainer) {
          const rawHtml = marked.parse(normalizeModelMarkdown(finalPayload.answer), { gfm: true, breaks: false });
          setAnswerHtml(textContainer, DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } }));
          textContainer.querySelectorAll(".inline-citation").forEach((btn) => {
            btn.addEventListener("click", () => showSource(btn.getAttribute("data-source-id")));
          });
        }
        attachAssistantMeta(bubble, finalPayload);
      } else {
        appendAssistantMessage(finalPayload);
      }
    }
  } catch (err) {
    stopWaitingAnimation();
    if (err.name === "AbortError" || currentAbortController?.signal?.aborted) {
      if (bubble) {
        const clientDurationMs = Math.round(performance.now() - requestStartTime);
        attachAssistantMeta(bubble, {
          durationMs: clientDurationMs,
          ttftMs: ttftMs ?? clientDurationMs,
          model: activeModel,
          stopped: true,
        });
      }
      return;
    }
    const text = err instanceof Error ? err.message : "The request failed.";
    if (stillHere()) {
      if (assistantRow && bubble && textContainer) {
        textContainer.innerHTML = `<p class="error-text">${escapeHtml(text)}</p>`;
      } else {
        appendErrorMessage(text);
      }
    } else if (sentTo && sentTo === activeConversationId) {
      if (historyLoading === sentTo) failedQuestions.set(sentTo, { question: message, text });
      else if (!alreadyDrawn(sentTo, message)) appendErrorMessage(text);
    }
  } finally {
    asking = false;
    currentAbortController = null;
    stopWaitingAnimation();
    messageInput.disabled = false;
    sendButton.hidden = false;
    sendButton.disabled = false;
    if (stopButton) stopButton.hidden = true;
    askingIn = undefined;
    const isTextBox = (element) =>
      Boolean(element) &&
      (element.tagName === "TEXTAREA" || element.isContentEditable ||
        (element.tagName === "INPUT" && !["button", "submit", "checkbox", "radio"].includes(element.type)));
    const insideFrame = (element) => {
      try {
        return element?.tagName === "IFRAME" ? element.contentDocument?.activeElement ?? null : null;
      } catch {
        return null;
      }
    };
    const elsewhere = document.activeElement;
    const typingElsewhere =
      elsewhere && elsewhere !== messageInput && (isTextBox(elsewhere) || isTextBox(insideFrame(elsewhere)));
    if (!typingElsewhere) messageInput.focus();
    scrollToBottom();
  }
});

// Authentication & Persona Management
function handleAuthRequired() {
  localStorage.removeItem("sme_current_user");
  currentUser = null;
  selectedPersonaId = "jax";
  if (sidebarUserName) sidebarUserName.textContent = "Signed out";
  if (sidebarUserRole) sidebarUserRole.textContent = "Please sign in";
  if (sidebarUserAvatar) sidebarUserAvatar.textContent = "?";
  if (conversationsList) {
    conversationsList.innerHTML = '<div class="conversations-empty">Sign in to view saved chats</div>';
  }
  if (clearAllConversationsBtn) {
    clearAllConversationsBtn.setAttribute("hidden", "");
  }
  renderSuggestionChips(null);
  openLoginDialog();
}

async function handleLogout() {
  try {
    await fetch("/api/v1/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
  } catch (_) {}
  handleAuthRequired();
}

function updateUserDisplay(user) {
  if (!user || !user.employeeId) {
    currentUser = null;
    return;
  }
  currentUser = user;
  selectedPersonaId = user.employeeId;
  try {
    localStorage.setItem("sme_current_user", JSON.stringify(user));
  } catch (_) {}

  if (sidebarUserAvatar) sidebarUserAvatar.innerHTML = avatarMarkup(user);
  if (sidebarUserName) sidebarUserName.textContent = user.displayName;
  if (sidebarUserRole) sidebarUserRole.textContent = user.role || user.department || "Employee";

  const emptyTitle = document.querySelector("#empty-state-title");
  if (emptyTitle) {
    emptyTitle.textContent = `How can I help you today, ${user.displayName}?`;
  }
  renderSuggestionChips(user);

  const memoryTitle = document.querySelector("#memory-title");
  if (memoryTitle) {
    memoryTitle.textContent = `${user.displayName}'s Active Working Memory`;
  }
}

function renderPersonaCards(personas, activeId) {
  if (!personaGrid || !Array.isArray(personas)) return;
  personaGrid.innerHTML = "";

  if (personas.length === 0) {
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "no-personas-found";
    emptyMsg.style.cssText = "grid-column: 1 / -1; padding: 24px; text-align: center; color: var(--muted); font-size: 0.88rem;";
    emptyMsg.textContent = "No matching employees found in directory.";
    personaGrid.appendChild(emptyMsg);
    return;
  }

  for (const persona of personas) {
    const card = document.createElement("div");
    card.className = "persona-card";
    if (persona.employeeId === activeId) {
      card.classList.add("selected");
    }
    card.dataset.employeeId = persona.employeeId;

    card.innerHTML = `
      <div class="persona-avatar">${avatarMarkup(persona)}</div>
      <div class="persona-info">
        <div class="persona-name-row">
          <span class="persona-name">${escapeHtml(persona.displayName)}</span>
        </div>
        <span class="persona-role">${escapeHtml(persona.role || "Employee")}</span>
        <span class="persona-dept-badge">${escapeHtml(persona.department || "Employee")}</span>
      </div>
    `;

    card.addEventListener("click", () => {
      selectedPersonaId = persona.employeeId;
      document.querySelectorAll(".persona-card").forEach((c) => {
        c.classList.toggle("selected", c.dataset.employeeId === persona.employeeId);
      });
      if (loginSubmitBtn) {
        loginSubmitBtn.querySelector("span").textContent = `Sign In as ${persona.displayName}`;
      }
      if (loginErrorMsg) loginErrorMsg.hidden = true;
    });

    personaGrid.appendChild(card);
  }
}

function filterPersonas(query) {
  const q = (query || "").trim().toLowerCase();
  let filtered = availablePersonas;
  if (q) {
    filtered = availablePersonas.filter((p) => {
      const name = (p.displayName || "").toLowerCase();
      const role = (p.role || "").toLowerCase();
      const dept = (p.department || "").toLowerCase();
      const id = (p.employeeId || "").toLowerCase();
      return name.includes(q) || role.includes(q) || dept.includes(q) || id.includes(q);
    });
  }

  if (personaCountLabel) {
    if (q) {
      personaCountLabel.textContent = `Showing ${filtered.length} of ${availablePersonas.length} Employees`;
    } else {
      personaCountLabel.textContent = `Company Directory (${availablePersonas.length} Employees)`;
    }
  }

  renderPersonaCards(filtered, selectedPersonaId);
}

async function openLoginDialog() {
  if (!loginDialog) return;
  if (loginErrorMsg) loginErrorMsg.hidden = true;
  if (loginPasswordInput) loginPasswordInput.value = "password";
  if (personaSearchInput) personaSearchInput.value = "";

  // Show close button if an employee session is already active
  if (closeLoginDialogBtn) {
    closeLoginDialogBtn.style.display = currentUser?.employeeId ? "block" : "none";
  }

  try {
    const res = await fetch("/api/v1/auth/personas");
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        availablePersonas = data;
      }
    }
  } catch (_) {}

  if (!Array.isArray(availablePersonas) || availablePersonas.length === 0) {
    availablePersonas = [
      { employeeId: "jax", displayName: "Jax", role: "Backend Engineer", department: "Engineering_Backend" },
      { employeeId: "priya", displayName: "Priya", role: "Product Designer", department: "Design" },
      { employeeId: "chloe", displayName: "Chloe", role: "Product Manager", department: "Product" },
      { employeeId: "marcus", displayName: "Marcus", role: "Staff Systems Engineer", department: "Engineering_Backend" },
      { employeeId: "deepa", displayName: "Deepa", role: "People Operations Lead", department: "HR_Ops" },
    ];
  }

  selectedPersonaId = currentUser?.employeeId || availablePersonas[0]?.employeeId || "jax";
  filterPersonas("");

  const selectedPersona = availablePersonas.find((p) => p.employeeId === selectedPersonaId);
  if (loginSubmitBtn && selectedPersona) {
    loginSubmitBtn.querySelector("span").textContent = `Sign In as ${selectedPersona.displayName}`;
  }

  try {
    loginDialog.showModal();
  } catch (_) {
    loginDialog.setAttribute("open", "");
  }

  if (personaSearchInput && currentUser?.employeeId) {
    setTimeout(() => personaSearchInput.focus(), 50);
  }
}

if (closeLoginDialogBtn) {
  closeLoginDialogBtn.addEventListener("click", () => {
    if (currentUser?.employeeId) {
      try {
        loginDialog.close();
      } catch (_) {
        loginDialog.removeAttribute("open");
      }
    }
  });
}

if (loginDialog) {
  loginDialog.addEventListener("click", (e) => {
    if (e.target === loginDialog && currentUser?.employeeId) {
      try {
        loginDialog.close();
      } catch (_) {
        loginDialog.removeAttribute("open");
      }
    }
  });
}

if (personaSearchInput) {
  personaSearchInput.addEventListener("input", (e) => {
    filterPersonas(e.target.value);
  });
}

if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (loginErrorMsg) loginErrorMsg.hidden = true;
    if (loginSubmitBtn) loginSubmitBtn.disabled = true;

    const password = loginPasswordInput ? loginPasswordInput.value.trim() : "password";

    try {
      // Switching persona: sign out first to clear old session
      await fetch("/api/v1/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      }).catch(() => {});

      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          employeeId: selectedPersonaId,
          password,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (loginErrorMsg) {
          loginErrorMsg.textContent = data.message || "Authentication failed.";
          loginErrorMsg.hidden = false;
        }
        return;
      }

      if (data.employee) {
        const next = returnAddress();
        if (next) {
          // Sent here to sign in from another page: go back to it.
          location.assign(next);
          return;
        }
        const prevId = currentUser?.employeeId;
        updateUserDisplay(data.employee);

        if (loginDialog) {
          try {
            loginDialog.close();
          } catch (_) {
            loginDialog.removeAttribute("open");
          }
        }

        // If switching user, reset chat view and reload conversations
        if (prevId !== data.employee.employeeId) {
          startNewChat();
        }
        await loadConversations();
        takeOverFromMeeting();
      }
    } catch (err) {
      if (loginErrorMsg) {
        loginErrorMsg.textContent = "Could not reach the server.";
        loginErrorMsg.hidden = false;
      }
    } finally {
      if (loginSubmitBtn) loginSubmitBtn.disabled = false;
    }
  });
}

const logoutBtn = document.querySelector("#logout-btn");
if (logoutBtn) {
  logoutBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    handleLogout();
  });
}

if (sidebarUserContainer) {
  sidebarUserContainer.addEventListener("click", (e) => {
    if (e.target.closest("#logout-btn")) return;
    openLoginDialog();
  });
  sidebarUserContainer.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      if (e.target.closest("#logout-btn")) return;
      e.preventDefault();
      openLoginDialog();
    }
  });
}

async function initAuth() {
  try {
    const res = await fetch("/api/v1/auth/me", { credentials: "same-origin" });
    if (res.ok) {
      const data = await res.json();
      if (data.authenticated && data.employee) {
        const next = returnAddress();
        if (next) {
          location.assign(next);
          return;
        }
        updateUserDisplay(data.employee);
        loadHome();
        await loadConversations();
        takeOverFromMeeting();
        return;
      }
    }
  } catch (_) {}

  // 401 or failure: authoritative sign-in required
  handleAuthRequired();
}

// ---------------------------------------------------------------------------
// Home: what needs you, gathered from your meetings
// ---------------------------------------------------------------------------

/** The sample meeting that explains the product; listed, but its drafts are not work. */
const TOUR_MEETING_ID = "product-tour";
const homeSection = document.querySelector("#home");
let homeRequest = 0;

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

function homeTask({ action, meeting }, part) {
  const [kindLabel, icon] = HOME_KINDS[action.kind] ?? ["Action", "check"];
  const row = document.createElement("a");
  row.className = `task ${part}`;
  row.href = `/meetings/${encodeURIComponent(meeting.meetingId)}`;
  const quote = action.trigger?.quote ? ` · “${action.trigger.quote}” · ${action.trigger.speaker ?? ""}` : "";
  let sub = `${meeting.title}${quote}`;
  if (part === "waiting") {
    const approver = action.payload?.requiredApprover;
    const reason = String(action.payload?.reason ?? "").trim();
    sub = `${approver ? `Needs ${approver}. ` : ""}${reason}${reason && !/[.!?]$/.test(reason) ? "." : ""} From ${meeting.title}.`;
  }
  if (part === "done") sub = meeting.title;
  const need = part === "needs" && Array.isArray(action.missing) && action.missing.length > 0
    ? `<span class="need"><b>Needs input:</b> ${escapeHtml(action.missing[0])}</span>` : "";
  const go = part === "needs" ? '<span class="task-go">Review</span>' : "";
  row.innerHTML = `
    <span class="task-icon ${part}">${lineIcon(icon, 15)}</span>
    <span class="task-body"><b>${escapeHtml(action.title)}<span class="kind">${escapeHtml(kindLabel)}</span></b><span class="sub">${escapeHtml(sub.trim())}</span>${need}</span>
    ${go}${lineIcon("chevron", 14)}`;
  return row;
}

function fillHomeGroup(id, items, part) {
  const group = document.querySelector(id);
  if (!group) return;
  group.hidden = items.length === 0;
  group.querySelector(".count").textContent = String(items.length);
  const list = group.querySelector(".tasks");
  list.replaceChildren(...items.map((item) => homeTask(item, part)));
}

function homeSummary(needs, waiting) {
  const parts = [];
  if (needs.length > 0) {
    const titles = [...new Set(needs.map((item) => item.meeting.title))];
    const from = titles.length === 1 ? `<mark>${escapeHtml(titles[0])}</mark>` : `${titles.length} meetings`;
    parts.push(needs.length === 1 ? `It is a draft from ${from}.` : `All ${needs.length} are drafts from ${from}.`);
  }
  const call = waiting.find((item) => item.action.payload?.requiredApprover);
  if (call) {
    const subject = call.action.payload.subject || call.action.title;
    parts.push(`${escapeHtml(subject)} is <mark>${escapeHtml(call.action.payload.requiredApprover)}’s call</mark>, not yours.`);
  }
  return parts.join(" ");
}

function renderHomeMeetings(meetings) {
  const group = document.querySelector("#home-meetings");
  if (!group) return;
  group.querySelector(".count").textContent = String(meetings.length);
  const rows = meetings.map((meeting) => {
    const row = document.createElement("a");
    row.className = "meeting";
    row.href = `/meetings/${encodeURIComponent(meeting.meetingId)}`;
    const tour = meeting.meetingId === TOUR_MEETING_ID;
    const when = tour ? "Sample" : meeting.status === "live" ? "Live" : formatRelativeTime(meeting.startedAt);
    row.innerHTML = `${lineIcon(tour ? "play" : "mic", 14)}<span class="t">${escapeHtml(meeting.title)}</span><span class="when">${escapeHtml(when)}</span>${lineIcon("chevron", 14)}`;
    return row;
  });
  group.querySelector(".rows").replaceChildren(...rows);
}

async function loadHome() {
  if (!homeSection) return;
  const asked = ++homeRequest;
  let meetings = [];
  try {
    const response = await fetch("/api/v1/meetings", { credentials: "same-origin" });
    if (response.ok) meetings = await response.json();
  } catch (_) {
    // The home shows no meetings, and the chat still works.
  }
  if (asked !== homeRequest || !Array.isArray(meetings)) return;
  meetings = [...meetings].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  renderHomeMeetings(meetings);

  const withWork = meetings.filter((meeting) => meeting.meetingId !== TOUR_MEETING_ID && meeting.actionCount !== 0).slice(0, 8);
  const states = await Promise.all(withWork.map((meeting) =>
    fetch(`/api/v1/meetings/${encodeURIComponent(meeting.meetingId)}`, { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)));
  if (asked !== homeRequest) return;

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

  const name = currentUser?.displayName || "You";
  const title = document.querySelector("#home-title");
  if (title) {
    title.textContent = needs.length === 0
      ? `${name}, nothing needs you right now.`
      : `${name}, ${needs.length} ${needs.length === 1 ? "thing needs" : "things need"} you.`;
  }
  const summary = document.querySelector("#home-summary");
  if (summary) summary.innerHTML = homeSummary(needs, waiting);
  fillHomeGroup("#home-needs", needs, "needs");
  fillHomeGroup("#home-waiting", waiting, "waiting");
  fillHomeGroup("#home-done", done.slice(0, 5), "done");
}

/**
 * A meeting handed something over (a hiring need): start a chat with it, once.
 * It arrives in this tab's storage rather than the address, so no outside link
 * can start a conversation on someone's behalf; anything older than a few
 * minutes was not just clicked and is dropped.
 */
const HANDOFF_FRESH_MS = 5 * 60 * 1000;

function takeOverFromMeeting() {
  let handoff = null;
  try {
    handoff = JSON.parse(sessionStorage.getItem("assistant-handoff") || "null");
    sessionStorage.removeItem("assistant-handoff");
  } catch (_) {
    return;
  }
  if (!handoff || typeof handoff.message !== "string" || Date.now() - Number(handoff.at) > HANDOFF_FRESH_MS) return;
  startNewChat();
  messageInput.value = handoff.message;
  chatForm.requestSubmit();
}

let soboRiveInstance = null;
function initSoboMascot() {
  const canvas = document.querySelector("#sobo-canvas");
  if (!canvas) return;

  if (typeof rive !== "undefined" && typeof rive.Rive === "function") {
    try {
      if (rive.RuntimeLoader && typeof rive.RuntimeLoader.setWasmUrl === "function") {
        rive.RuntimeLoader.setWasmUrl("/vendor/rive.wasm");
      }
      soboRiveInstance = new rive.Rive({
        src: "/assets/merlion.riv",
        canvas: canvas,
        autoplay: true,
        layout: new rive.Layout({
          fit: rive.Fit.Contain,
          alignment: rive.Alignment.Center,
        }),
        onLoad: () => {
          window.soboRive = soboRiveInstance;
          if (soboRiveInstance) {
            soboRiveInstance.resizeDrawingSurfaceToCanvas();
          }
        },
        onError: (err) => {
          console.warn("Rive mascot failed to load, falling back to icon", err);
          canvas.style.display = "none";
          const wrapper = document.querySelector("#empty-avatar-wrapper");
          if (wrapper) wrapper.innerHTML = '<svg class="empty-icon" viewBox="0 0 40 40" width="72" height="72" aria-hidden="true"><rect x="2" y="2" width="36" height="36" rx="13" fill="#4b3fd1"/><rect x="8" y="10" width="24" height="18" rx="8" fill="#fbfaff"/><circle cx="15" cy="19" r="2.4" fill="#1c1a33"/><circle cx="25" cy="19" r="2.4" fill="#1c1a33"/><path d="M16.5 24 q3.5 2.6 7 0" stroke="#1c1a33" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
        },
      });

      canvas.addEventListener("click", () => {
        if (!soboRiveInstance) return;
        const bumpAnimation = soboRiveInstance.animationNames.find(
          (name) => name.toLowerCase() === "bump",
        );
        if (bumpAnimation) soboRiveInstance.play(bumpAnimation);
      });
    } catch (err) {
      console.warn("Could not instantiate Rive animation", err);
    }
  }
}

// Startup
initAuth();
initModels();
initSoboMascot();
