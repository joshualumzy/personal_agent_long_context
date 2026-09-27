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

// LINE_ICONS, lineIcon and escapeHtml are defined in plate.js, loaded before
// this script; every page that shows the plate shares that one copy.

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
        button.textContent = citationLabel(id);
        button.title = id;
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

// ------------------------------------------------------------ a chat's address
// Each chat lives at /chat/<id>, so a reload or a shared link comes back to it;
// the home is /. The chosen day (?asOf=) stays in the query either way.
function chatFromAddress() {
  const match = /^\/chat\/([^/]+)\/?$/.exec(location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

function setChatAddress(conversationId, { replace = false } = {}) {
  const path = conversationId ? `/chat/${encodeURIComponent(conversationId)}` : "/";
  if (location.pathname === path) return;
  history[replace ? "replaceState" : "pushState"](null, "", `${path}${location.search}${location.hash}`);
}

/** At start (or after signing in), a chat named in the address opens by itself. */
function openChatFromAddress() {
  const conversationId = chatFromAddress();
  if (conversationId && conversationId !== activeConversationId) selectConversation(conversationId, "", { fromAddress: true });
}

// Back and forward move between chats, and to the home, as links would.
window.addEventListener("popstate", () => {
  const conversationId = chatFromAddress();
  if (conversationId) {
    if (conversationId !== activeConversationId) selectConversation(conversationId, "", { fromAddress: true });
  } else if (activeConversationId) {
    startNewChat({ fromAddress: true });
  }
});

// Start New Chat
function startNewChat({ fromAddress = false } = {}) {
  chatEpoch += 1;
  historyLoading = null;
  activeConversationId = null;
  if (!fromAddress) setChatAddress(null);
  chatMessages.innerHTML = "";
  if (emptyState) emptyState.style.display = "block";
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
setPlateSourceHandler(showSource);

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

/** Past this many characters a message is a passage handed over (a meeting's hiring need, say), not a question. */
const LONG_QUESTION = 140;

function appendUserMessage(text) {
  const row = document.createElement("div");
  row.className = "message-row user";
  // A question reads as a heading; a long passage reads as text.
  if (String(text).length > LONG_QUESTION) row.classList.add("long");
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
  // Candidates need room: the orbit and a person's details side by side.
  document.body.classList.add("context-wide");
  refreshContext();
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
  document.body.classList.remove("context-wide");
  refreshContext();
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
      // On a past day memory is set aside on purpose, which is not a fault.
      tag.innerHTML = data.asOf
        ? `${lineIcon("book", 12)}Memory set aside for this day`
        : `${lineIcon("alert", 12)}Personal memory unavailable`;
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

  if (data.asOf) {
    const tag = document.createElement("span");
    tag.className = "context-tag as-of-tag";
    tag.innerHTML = `${lineIcon("clock", 12)}As of ${escapeHtml(data.asOf)}`;
    tag.title = "Answered from the end of this working day: nothing after it was read.";
    contextTags.prepend(tag);
  }

  if (contextTags.children.length > 0) {
    meta.appendChild(contextTags);
  }

  // The answer's graph: a small picture of what its evidence connects to,
  // above the evidence itself. Opens larger on click. The graph is not read by
  // date yet, so an answer from a past day has none.
  if (!data.asOf && data.question && data.sources && data.sources.length > 0) {
    meta.appendChild(answerGraphPreview(data.question, data.sources));
  }

  // Sources: one line each, three at first; opening one shows its full text.
  if (data.sources && data.sources.length > 0) {
    const SHOWN = 3;
    const list = document.createElement("div");
    // sources-grid kept for what already looks for it.
    list.className = "sources-list sources-grid";
    const head = document.createElement("div");
    head.className = "sources-head";
    head.textContent = `${data.sources.length} ${data.sources.length === 1 ? "source" : "sources"}`;
    list.appendChild(head);
    const rows = data.sources.map((source, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "source-row";
      row.title = source.sourceId;
      row.hidden = index >= SHOWN;
      row.innerHTML = `
        <span class="source-kind">${escapeHtml(sourceKind(source.sourceType))}</span>
        <span class="source-title">${escapeHtml(sourceTitle(source))}</span>
        <span class="source-meta">${escapeHtml(sourceMeta(source))}</span>`;
      row.addEventListener("click", () => showSource(source.sourceId));
      list.appendChild(row);
      return row;
    });
    if (rows.length > SHOWN) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "sources-more";
      more.textContent = `Show ${rows.length - SHOWN} more`;
      more.addEventListener("click", () => {
        rows.forEach((row) => { row.hidden = false; });
        more.remove();
      });
      list.appendChild(more);
    }
    meta.appendChild(list);
  }

  if (meta.children.length > 0) {
    bubble.appendChild(meta);
  }
}

// ---------------------------------------------------------------------------
// Evidence cards: what a source is, in plain words
// ---------------------------------------------------------------------------

const SOURCE_KINDS = {
  confluence: "Confluence page",
  slack: "Slack message",
  email: "Email",
  jira: "Jira ticket",
  zd_ticket: "Support ticket",
  zoom_transcript: "Meeting transcript",
  pr: "Pull request",
  sf_opp: "Sales opportunity",
  sf_account: "Customer account",
  datadog_alert: "Alert",
  invoice: "Invoice",
  nps_survey: "Customer survey",
};

/** What a citation chip reads: the key people say (ZD-101), or for a stored
 * message, just what it is. */
function citationLabel(id) {
  if (/^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+$/.test(id)) return id;
  const prefix = id.split("_")[0];
  const short = { slack: "Slack", email: "Email", zoom: "Meeting", datadog: "Alert" }[prefix];
  return short ?? (id.length > 18 ? `${id.slice(0, 17)}\u2026` : id);
}

function sourceKind(type) {
  if (SOURCE_KINDS[type]) return SOURCE_KINDS[type];
  const words = String(type || "source").replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function sourceTitle(source) {
  return String(source.title || source.sourceId || "").replace(/[\s:]+$/, "");
}

/** A key people say out loud (ENG-148, CONF-ENG-150), then the date. A
 * storage id such as slack_incidents_2026-01-23T10:00:00 is never shown. */
function sourceMeta(source) {
  const parts = [];
  if (/^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+$/.test(source.sourceId || "") && source.sourceId !== sourceTitle(source)) {
    parts.push(source.sourceId);
  }
  const when = source.occurredAt ? new Date(source.occurredAt) : null;
  if (when && !Number.isNaN(when.getTime())) {
    parts.push(when.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }));
  }
  return parts.join(" \u00b7 ");
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
      <span class="answer-graph-open">Open the graph →</span>
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
      `${seeds} ${seeds === 1 ? "thing" : "things"} it points to`;
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
/** The context column shows whatever is in it: pinned candidates, an answer's graph. */
function refreshContext() {
  const context = document.querySelector("#context");
  if (!context) return;
  const graph = document.querySelector("#graph-panel");
  context.hidden = pinnedPanel.hidden && (!graph || graph.hidden);
  document.body.classList.toggle("has-context", !context.hidden);
}

function closeAnswerGraph() {
  const panel = document.querySelector("#graph-panel");
  if (!panel) return;
  panel.hidden = true;
  panel.querySelector("iframe").removeAttribute("src");
  refreshContext();
}
document.querySelector("#graph-panel .graph-panel-close")?.addEventListener("click", closeAnswerGraph);

/** Opens the answer's graph beside the page, in the context column. */
function openAnswerGraph(question, sources) {
  const panel = document.querySelector("#graph-panel");
  if (!panel) return;
  panel.querySelector(".graph-panel-title").textContent = question;
  const params = answerGraphParams(question, sources);
  params.set("embed", "1");
  panel.querySelector("iframe").src = `/graph/answer?${params}`;
  panel.hidden = false;
  refreshContext();
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
    lastConversations = Array.isArray(conversations) ? conversations : [];
    renderTimeline();
    // A list asked for later (after a delete, say) may already be drawn.
    if (asked !== listRequest) return;

    if (!Array.isArray(conversations) || conversations.length === 0) {
      conversationsList.innerHTML = '<div class="conversations-empty">No saved chats yet</div>';
      if (clearAllConversationsBtn) clearAllConversationsBtn.setAttribute("hidden", "");
      if (conversationsMore) conversationsMore.hidden = true;
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
    // The latest few; the rest wait behind one quiet link.
    const items = [...conversationsList.querySelectorAll(".conversation-item")];
    items.forEach((item, index) => { item.hidden = index >= RECENT_CHATS; });
    if (conversationsMore) {
      conversationsMore.hidden = items.length <= RECENT_CHATS;
      conversationsMore.textContent = `Show all ${items.length}`;
    }
  } catch (err) {
    console.warn("Could not load conversations", err);
  }
}

const RECENT_CHATS = 5;
const conversationsMore = document.querySelector("#conversations-more");
conversationsMore?.addEventListener("click", () => {
  for (const item of conversationsList.querySelectorAll(".conversation-item")) item.hidden = false;
  conversationsMore.hidden = true;
});

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

async function selectConversation(conversationId, title, { fromAddress = false } = {}) {
  const asked = ++chatEpoch;
  try {
    activeConversationId = conversationId;
    if (!fromAddress) setChatAddress(conversationId);
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
    showConversationDay(detail.messages?.[0]?.metadata?.asOf ?? null);
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
            asOf: typeof msg.metadata?.asOf === "string" ? msg.metadata.asOf : undefined,
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
      setChatAddress(null, { replace: true });
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
    if (currentViewDay()) payload.asOf = currentViewDay();

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
        setChatAddress(data.conversationId, { replace: true });
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
        setChatAddress(finalPayload.conversationId, { replace: true });
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
setPlateAuthRequiredHandler(handleAuthRequired);

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
  refreshTodayPanelForNewUser();
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
        // The plate and the page belong to whoever just signed in: fill them now, not on the next reload.
        loadHome();
        await loadConversations();
        await initPlanner();
        openChatFromAddress();
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


// ---------------------------------------------------------------------------
// The chosen day, and the Today panel: showDay, chooseDay, loadTodayPanel,
// renderTodo, renderPlan, initPlanner and the rest live in plate.js, shared
// with the meetings page. A change of day here interrupts the open
// conversation, which only the assistant page has.
// ---------------------------------------------------------------------------

setPlateDayChangeHandler(() => {
  if (activeConversationId && chatMessages.children.length > 0) startNewChat();
});

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
        await initPlanner();
        openChatFromAddress();
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
//
// TOUR_MEETING_ID, homeTask, fillHomeGroup and loadPlateNeeds (which fetches
// the meetings and their actions, and fills #home-needs/#home-waiting) live
// in plate.js, shared with the meetings page. loadHome, below, builds on
// what that call found for the parts only the assistant's own home shows.

const homeSection = document.querySelector("#home");

function homeSummary(needs) {
  if (needs.length === 0) return "";
  const titles = [...new Set(needs.map((item) => item.meeting.title))];
  const from = titles.length === 1 ? `<mark>${escapeHtml(titles[0])}</mark>` : `${titles.length} meetings`;
  if (needs.length === 1) return `A draft from ${from}.`;
  return needs.length === 2 ? `Both are drafts from ${from}.` : `All ${needs.length} are drafts from ${from}.`;
}

function renderHomeMeetings(meetings) {
  const group = document.querySelector("#home-meetings");
  if (!group) return;
  group.querySelector(".count").textContent = String(meetings.length);
  const rows = meetings.map((meeting) => {
    const row = document.createElement("a");
    row.className = "meeting";
    row.href = `/meetings/${encodeURIComponent(meeting.meetingId)}`;
    const tour = isTourMeeting(meeting.meetingId);
    const when = tour ? "Sample" : meeting.status === "live" ? "Live" : formatRelativeTime(meeting.startedAt);
    row.innerHTML = `${lineIcon(tour ? "play" : "mic", 14)}<span class="t">${escapeHtml(meeting.title)}</span><span class="when">${escapeHtml(when)}</span>${lineIcon("chevron", 14)}`;
    return row;
  });
  group.querySelector(".rows").replaceChildren(...rows);
}

/** Swaps the plain line for one the model writes, the way a colleague would say
 * it; kept for the session, so a revisit does not ask again. */
async function askForHomeLine(asked, needs, waiting) {
  if (needs.length === 0) return;
  const items = [...needs.map((item) => ["needs", item]), ...waiting.map((item) => ["waiting", item])].map(([part, { action, meeting }]) => ({
    part, kind: action.kind, title: taskTitle(action.title), meeting: meeting.title,
  }));
  const body = JSON.stringify({ name: currentUser?.displayName || "", items });
  const key = `home-line:${body}`;
  let sentence = null;
  try {
    sentence = sessionStorage.getItem(key);
  } catch (_) {}
  if (!sentence) {
    try {
      const response = await fetch("/api/v1/home/summary", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body,
      });
      if (response.ok) sentence = (await response.json()).sentence ?? null;
    } catch (_) {
      // The plain line stays.
    }
    if (sentence) {
      try {
        sessionStorage.setItem(key, sentence);
      } catch (_) {}
    }
  }
  const summary = document.querySelector("#home-summary");
  if (sentence && summary && isLatestHomeRequest(asked)) summary.textContent = sentence;
}

// ---------------------------------------------------------------------------
// Today's page: the day's meetings and chats, in the order they happened
// ---------------------------------------------------------------------------

let lastMeetings = [];
let lastConversations = [];

function isToday(iso) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return false;
  const now = new Date();
  return when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth() && when.getDate() === now.getDate();
}

function clockTime(iso) {
  const when = new Date(iso);
  return `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
}

function renderTimeline() {
  const list = document.querySelector("#timeline .entries");
  if (!list) return;
  const entries = [
    ...lastMeetings
      .filter((meeting) => !isTourMeeting(meeting.meetingId) && isToday(meeting.startedAt))
      .map((meeting) => ({ kind: "meeting", at: meeting.startedAt, meeting })),
    ...lastConversations
      .filter((conversation) => isToday(conversation.updatedAt))
      .map((conversation) => ({ kind: "chat", at: conversation.updatedAt, conversation })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const rows = entries.map((entry) => {
    const row = document.createElement("div");
    row.className = `entry ${entry.kind}`;
    const time = document.createElement("span");
    time.className = "entry-time";
    time.textContent = clockTime(entry.at);
    let body;
    if (entry.kind === "meeting") {
      body = document.createElement("a");
      body.href = `/meetings/${encodeURIComponent(entry.meeting.meetingId)}`;
      const live = entry.meeting.status === "live";
      body.innerHTML = `${lineIcon("mic", 14)}<span class="entry-title">${escapeHtml(entry.meeting.title)}</span><span class="entry-meta">${live ? "Live" : "Minutes"}</span>`;
    } else {
      body = document.createElement("button");
      body.type = "button";
      body.innerHTML = `${lineIcon("message", 14)}<span class="entry-title">${escapeHtml(entry.conversation.title)}</span><span class="entry-meta">Chat</span>`;
      body.addEventListener("click", () => selectConversation(entry.conversation.conversationId, entry.conversation.title));
    }
    body.className = "entry-body";
    row.append(time, body);
    return row;
  });
  const now = document.createElement("div");
  now.className = "entry-now";
  now.innerHTML = `<span class="entry-time">${escapeHtml(clockTime(new Date().toISOString()))}</span><span class="now-line" aria-hidden="true"></span>`;
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "timeline-empty";
    empty.textContent = "Nothing on today's page yet. Record a meeting or ask Kaki something.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...rows, now);
}

/** The walking loops that failed to load: the still stands in for them from then on. */
const brokenWalks = new Set();
for (const id of ["#home-walk", "#home-win"]) {
  const walk = document.querySelector(id);
  const sources = walk ? walk.querySelectorAll("source") : [];
  // A <video> reports a missing file on its last <source>, not on itself.
  sources[sources.length - 1]?.addEventListener("error", () => {
    brokenWalks.add(id);
    if (walk.hidden) return;
    walk.hidden = true;
    const art = document.querySelector("#home-art");
    if (art) art.hidden = false;
  });
}

async function loadHome() {
  if (!homeSection) return;
  // The plate fetches the meetings and their actions, and fills its own
  // "Needs you" / "Waiting on others"; this builds the rest of the home
  // screen on what it found, rather than asking again.
  const result = await loadPlateNeeds();
  if (!result) return;
  const { asked, meetings, needs, waiting, done, oneMeeting } = result;
  renderHomeMeetings(meetings);
  lastMeetings = meetings;
  renderTimeline();

  const name = currentUser?.displayName || "You";
  const title = document.querySelector("#home-title");
  if (title) {
    title.textContent = needs.length === 0
      ? `${name}, nothing needs you right now.`
      : `${name}, ${needs.length} ${needs.length === 1 ? "thing needs" : "things need"} you.`;
  }
  // The one illustration: the hand waves while things wait, and shows a V when all is clear.
  const art = document.querySelector("#home-art");
  // Either way it walks (a silent loop): the shaka strides steadily on while things wait,
  // the V bounces along at an easy stroll once all is clear.
  const shown = needs.length === 0 ? "#home-win" : "#home-walk";
  const pace = { "#home-walk": 1, "#home-win": 0.85 };
  let walking = false;
  for (const id of ["#home-walk", "#home-win"]) {
    const walk = document.querySelector(id);
    if (!walk) continue;
    walk.muted = true;
    walk.defaultPlaybackRate = walk.playbackRate = pace[id];
    walk.hidden = id !== shown || brokenWalks.has(id);
    if (walk.hidden) walk.pause?.();
    else {
      walking = true;
      walk.play?.()?.catch?.(() => {});
    }
  }
  if (art) {
    art.hidden = walking;
    // The still is the loop's first frame, so reduced motion shows the same toy.
    art.src = `/assets/${needs.length === 0 ? "kaki-win" : "kaki-walk"}.jpg`;
  }
  const summary = document.querySelector("#home-summary");
  if (summary) summary.innerHTML = homeSummary(needs);
  askForHomeLine(asked, needs, waiting);
  // Everything from one meeting: the headline names it, so the rows do not repeat it.
  fillHomeGroup("#home-done", done.slice(0, 5), "done", oneMeeting);
  // Hook for public/clear.js: the drafts that need approval, freshly gathered.
  document.dispatchEvent(new CustomEvent("kaki:home-needs", { detail: { needs } }));
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

// Startup
initAuth();
initModels();
