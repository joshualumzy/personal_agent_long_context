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
let activeModel = localStorage.getItem("sme_selected_model") || "soclaas";

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
  avatar: "👨‍💻",
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

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
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

function linkifyCitations(html) {
  return html.replace(
    /\[source:([A-Za-z0-9._:-]+)\]/gi,
    '<button type="button" class="inline-citation" data-source-id="$1">$1</button>',
  );
}

// Auto-expand textarea
messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 180) + "px";
});

// Submit on Enter without Shift
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
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
    localStorage.setItem("sme_sidebar_collapsed", String(collapsed));
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

// Keyboard shortcut: Cmd+B (Mac) or Ctrl+B (Windows/Linux)
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
    e.preventDefault();
    toggleSidebar();
  }
});

// Restore sidebar state from localStorage or default on mobile
try {
  const savedState = localStorage.getItem("sme_sidebar_collapsed");
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
    localStorage.setItem("sme_selected_model", modelId);
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
      opt.classList.toggle("active", opt.getAttribute("data-model") === modelId);
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
            opt.style.opacity = "0.45";
            opt.style.pointerEvents = "none";
            opt.title = m.unavailableReason || "Not configured on server";
          } else {
            opt.classList.remove("disabled");
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
  activeConversationId = null;
  chatMessages.innerHTML = "";
  if (emptyState) emptyState.style.display = "block";
  const emptyTitle = document.querySelector("#empty-state-title");
  if (emptyTitle && currentUser?.displayName) {
    emptyTitle.textContent = `How can I help you today, ${currentUser.displayName}?`;
  }
  renderSuggestionChips(currentUser);
  if (currentChatTitle) currentChatTitle.textContent = "SME Assistant";
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
  const linkedHtml = linkifyCitations(sanitized);

  const textContainer = document.createElement("div");
  textContainer.className = "message-text";
  textContainer.innerHTML = linkedHtml;

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

function formatRuntime(durationMs, ttftMs) {
  if (typeof durationMs !== "number" || isNaN(durationMs)) return null;
  const totalStr = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
  if (typeof ttftMs === "number" && !isNaN(ttftMs) && ttftMs > 0) {
    const safeTtft = Math.min(ttftMs, durationMs);
    const ttftStr = safeTtft < 1000 ? `${safeTtft}ms` : `${(safeTtft / 1000).toFixed(1)}s`;
    return {
      label: `⏱️ ${totalStr} (TTFT ${ttftStr})`,
      tooltip: `Total runtime: ${totalStr} (${durationMs}ms) · Time to first token: ${ttftStr} (${safeTtft}ms)`,
    };
  }
  return {
    label: `⏱️ ${totalStr}`,
    tooltip: `Total runtime: ${totalStr} (${durationMs}ms)`,
  };
}

function attachAssistantMeta(bubble, data) {
  const meta = document.createElement("div");
  meta.className = "message-meta";

  const contextTags = document.createElement("div");
  contextTags.className = "context-tags";

  if (data.model) {
    const modelTag = document.createElement("span");
    modelTag.className = `context-tag model-badge ${data.model}`;
    modelTag.textContent = data.model === "sonnet" ? "⚡ Claude Sonnet" : "⚙️ SoCLaaS Qwen";
    modelTag.title =
      data.model === "sonnet"
        ? "Answered using Claude 3.5 Sonnet on AWS Bedrock"
        : "Answered using Qwen 2.5 32B on NUS SoCLaaS";
    contextTags.appendChild(modelTag);
  }

  if (data.stopped) {
    const stopTag = document.createElement("span");
    stopTag.className = "context-tag";
    stopTag.textContent = "⏹️ Stopped";
    stopTag.title = "Response generation was cancelled by user";
    contextTags.appendChild(stopTag);
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
      tag.textContent = "💾 Working memory updated";
      contextTags.appendChild(tag);
    }
    if (data.personalMemory.status === "unavailable") {
      const tag = document.createElement("span");
      tag.className = "context-tag unavailable";
      tag.textContent = "⚠️ Personal memory unavailable";
      if (data.personalMemory.reason) tag.title = data.personalMemory.reason;
      contextTags.appendChild(tag);
    } else if (data.personalMemory.answer && data.personalMemory.answer.trim().length > 0) {
      const tag = document.createElement("span");
      tag.className = "context-tag referenced";
      tag.textContent = "🧠 Working context referenced";
      tag.title = data.personalMemory.answer;
      contextTags.appendChild(tag);
    }
  }

  if (contextTags.children.length > 0) {
    meta.appendChild(contextTags);
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

// Conversation Management
async function loadConversations() {
  if (!conversationsList) return;
  try {
    const response = await fetch("/api/v1/conversations", {
      credentials: "same-origin",
    });
    if (!response.ok) {
      if (response.status === 401) handleAuthRequired();
      return;
    }
    const conversations = await response.json();

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
          <span class="conv-icon">💬</span>
          <span class="conv-title" title="${escapeHtml(conv.title)}">${escapeHtml(conv.title)}</span>
        </div>
        <div class="conv-meta">
          <span class="conv-date">${escapeHtml(formatRelativeTime(conv.updatedAt))}</span>
          <button type="button" class="conv-delete-btn" title="Delete conversation" aria-label="Delete conversation">✕</button>
        </div>
      `;

      item.addEventListener("click", (e) => {
        if (e.target.closest(".conv-delete-btn")) return;
        selectConversation(conv.conversationId, conv.title);
      });

      const delBtn = item.querySelector(".conv-delete-btn");
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm(`Delete conversation "${conv.title}"?`)) {
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
    if (confirm(`Clear all saved conversations for ${name}? This action cannot be undone.`)) {
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

    chatMessages.innerHTML = "";
    if (detail.messages && detail.messages.length > 0) {
      if (emptyState) emptyState.style.display = "none";
      for (const msg of detail.messages) {
        if (msg.role === "user") {
          appendUserMessage(msg.content);
        } else if (msg.role === "assistant") {
          appendAssistantMessage({
            answer: msg.content,
            sources: msg.metadata?.sources,
            personalMemory: msg.metadata?.personalMemory,
            durationMs: typeof msg.metadata?.durationMs === "number" ? msg.metadata.durationMs : undefined,
            ttftMs: typeof msg.metadata?.ttftMs === "number" ? msg.metadata.ttftMs : undefined,
            model: msg.metadata?.model,
          });
        }
      }
    } else {
      if (emptyState) emptyState.style.display = "block";
    }
  } catch (err) {
    appendErrorMessage("Could not load conversation history.");
  } finally {
    statusIndicator.hidden = true;
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
    if (activeConversationId === conversationId) {
      startNewChat();
    }
    await loadConversations();
  } catch (err) {
    alert("Could not delete conversation.");
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
  if (!message) return;

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
      if (data.conversationId) {
        activeConversationId = data.conversationId;
        if (data.title) {
          updateConversationTitleUI(data.conversationId, data.title);
        }
        loadConversations();
      }
      appendAssistantMessage(data);
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

        if (event === "status") {
          if (statusText && parsed?.phrase) {
            statusText.textContent = parsed.phrase;
          }
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
          textContainer.innerHTML = linkifyCitations(sanitized);
          textContainer.querySelectorAll(".inline-citation").forEach((btn) => {
            btn.addEventListener("click", () => showSource(btn.getAttribute("data-source-id")));
          });
          scrollToBottom();
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
          textContainer.innerHTML = linkifyCitations(sanitized);
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
          const msg =
            parsed?.message ||
            (parsed?.error === "provider_unavailable"
              ? "The selected model is temporarily unavailable—retry."
              : "Agent request failed.");
          throw new Error(msg);
        }
      }
    }

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
    const errMsg = err instanceof Error ? err.message : "The request failed.";
    if (assistantRow && bubble && textContainer) {
      textContainer.innerHTML = `<p class="error-text">${escapeHtml(errMsg)}</p>`;
    } else {
      appendErrorMessage(errMsg);
    }
  } finally {
    currentAbortController = null;
    stopWaitingAnimation();
    messageInput.disabled = false;
    sendButton.hidden = false;
    sendButton.disabled = false;
    if (stopButton) stopButton.hidden = true;
    messageInput.focus();
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
  if (sidebarUserAvatar) sidebarUserAvatar.textContent = "👤";
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

  if (sidebarUserAvatar) sidebarUserAvatar.textContent = user.avatar || "👤";
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
      <div class="persona-avatar">${escapeHtml(persona.avatar || "👤")}</div>
      <div class="persona-info">
        <div class="persona-name-row">
          <span class="persona-name">${escapeHtml(persona.displayName)}</span>
        </div>
        <span class="persona-role">${escapeHtml(persona.role || "Employee")}</span>
        <span class="persona-dept-badge">${escapeHtml(persona.department || "OrgForge")}</span>
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
      { employeeId: "jax", displayName: "Jax", role: "Backend Engineer", department: "Engineering_Backend", avatar: "👨‍💻" },
      { employeeId: "priya", displayName: "Priya", role: "Product Designer", department: "Design", avatar: "🎨" },
      { employeeId: "chloe", displayName: "Chloe", role: "Product Manager", department: "Product", avatar: "📋" },
      { employeeId: "marcus", displayName: "Marcus", role: "Staff Systems Engineer", department: "Engineering_Backend", avatar: "🛠️" },
      { employeeId: "deepa", displayName: "Deepa", role: "People Operations Lead", department: "HR_Ops", avatar: "🤝" },
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
        updateUserDisplay(data.employee);
        await loadConversations();
        return;
      }
    }
  } catch (_) {}

  // 401 or failure: authoritative sign-in required
  handleAuthRequired();
}

// Startup
initAuth();
initModels();
