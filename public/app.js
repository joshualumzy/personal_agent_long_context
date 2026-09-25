// SME Employee Assistant Unified Client
const chatForm = document.querySelector("#chat-form");
const messageInput = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const chatMessages = document.querySelector("#chat-messages");
const emptyState = document.querySelector("#empty-state");
const statusIndicator = document.querySelector("#status-indicator");
const statusText = document.querySelector("#status-text");
const messagesContainer = document.querySelector("#messages-container");
const suggestionChips = document.querySelectorAll(".chip");
const currentChatTitle = document.querySelector("#current-chat-title");

// Sidebar elements
const sidebar = document.querySelector("#sidebar");
const toggleSidebarBtn = document.querySelector("#toggle-sidebar-btn");
const collapseSidebarBtn = document.querySelector("#collapse-sidebar-btn");
const sidebarOverlay = document.querySelector("#sidebar-overlay");
const newChatBtn = document.querySelector("#new-chat-btn");
const conversationsList = document.querySelector("#conversations-list");

// Dialog elements
const sourceDialog = document.querySelector("#source-dialog");
const closeSourceBtn = document.querySelector("#close-source");
const memoryDialog = document.querySelector("#memory-dialog");
const closeMemoryBtn = document.querySelector("#close-memory");
const inspectMemoryBtn = document.querySelector("#inspect-memory-btn");
const memoryItemsList = document.querySelector("#memory-items-list");

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

  // Shuffle the whimsical pool so every request feels fresh, starting with the primary status
  const shuffledPool = [...WAITING_MESSAGES.slice(1)].sort(() => Math.random() - 0.5);
  const queue = [WAITING_MESSAGES[0], ...shuffledPool];
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

// Start New Chat
function startNewChat() {
  activeConversationId = null;
  chatMessages.innerHTML = "";
  if (emptyState) emptyState.style.display = "block";
  if (currentChatTitle) currentChatTitle.textContent = "SME Assistant";
  document.querySelectorAll(".conversation-item").forEach((el) => el.classList.remove("active"));
  if (isMobile()) setSidebarCollapsed(true);
  messageInput.focus();
}

if (newChatBtn) {
  newChatBtn.addEventListener("click", startNewChat);
}

// Suggestion chips
suggestionChips.forEach((chip) => {
  chip.addEventListener("click", () => {
    messageInput.value = chip.textContent.trim();
    messageInput.dispatchEvent(new Event("input"));
    chatForm.requestSubmit();
  });
});

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

// Inspect working memory
inspectMemoryBtn.addEventListener("click", async () => {
  memoryDialog.showModal();
  memoryItemsList.innerHTML = '<p class="loading-text">Loading retained context…</p>';
  try {
    const res = await fetch("/api/v1/users/jax/memory");
    const data = await res.json();
    if (!res.ok) {
      memoryItemsList.innerHTML = `<p class="error-text">${escapeHtml(data.message || "Failed to load memory.")}</p>`;
      return;
    }
    if (!data.items || data.items.length === 0) {
      memoryItemsList.innerHTML = "<p>No active memory items retained yet for Jax.</p>";
      return;
    }
    memoryItemsList.innerHTML = "";
    for (const item of data.items) {
      const card = document.createElement("div");
      card.className = "memory-item-card";
      card.innerHTML = `
        <div class="item-header">
          <strong>${escapeHtml(item.label)}</strong>
          <small>${escapeHtml(item.updatedAt || "")}</small>
        </div>
        <pre>${escapeHtml(item.content)}</pre>
      `;
      memoryItemsList.appendChild(card);
    }
  } catch (err) {
    memoryItemsList.innerHTML = '<p class="error-text">Could not load working memory.</p>';
  }
});

closeMemoryBtn.addEventListener("click", () => memoryDialog.close());
memoryDialog.addEventListener("click", (e) => {
  if (e.target === memoryDialog) memoryDialog.close();
});

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
  if (typeof ttftMs === "number" && !isNaN(ttftMs) && ttftMs > 0 && ttftMs <= durationMs) {
    const ttftStr = ttftMs < 1000 ? `${ttftMs}ms` : `${(ttftMs / 1000).toFixed(1)}s`;
    return {
      label: `⏱️ ${totalStr} (TTFT ${ttftStr})`,
      tooltip: `Total runtime: ${totalStr} · Time to first token: ${ttftStr}`,
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
    if (data.personalMemory.answer && data.personalMemory.answer.trim().length > 0) {
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
    const response = await fetch("/api/v1/conversations?userId=jax");
    if (!response.ok) return;
    const conversations = await response.json();

    if (!Array.isArray(conversations) || conversations.length === 0) {
      conversationsList.innerHTML = '<div class="conversations-empty">No saved chats yet</div>';
      return;
    }

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

    const response = await fetch(`/api/v1/conversations/${encodeURIComponent(conversationId)}?userId=jax`);
    if (!response.ok) throw new Error("Failed to load conversation");
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
    await fetch(`/api/v1/conversations/${encodeURIComponent(conversationId)}?userId=jax`, {
      method: "DELETE",
    });
    if (activeConversationId === conversationId) {
      startNewChat();
    }
    await loadConversations();
  } catch (err) {
    alert("Could not delete conversation.");
  }
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = messageInput.value.trim();
  if (!message) return;

  if (emptyState) {
    emptyState.style.display = "none";
  }

  appendUserMessage(message);

  messageInput.value = "";
  messageInput.style.height = "auto";
  messageInput.disabled = true;
  sendButton.disabled = true;

  startWaitingAnimation();
  scrollToBottom();

  const requestStartTime = performance.now();
  let ttftMs = null;

  try {
    const payload = {
      userId: "jax",
      employeeId: "jax",
      message,
      stream: true,
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
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let errMessage = `Request failed with code ${response.status}`;
      try {
        const errData = await response.json();
        if (errData.message) errMessage = errData.message;
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
        loadConversations();
      }
      appendAssistantMessage(data);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantRow = null;
    let bubble = null;
    let textContainer = null;
    let accumulatedContent = "";
    let finalPayload = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let currentEvent = "message";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          const dataStr = line.slice(5).trim();
          let parsed = null;
          try {
            parsed = JSON.parse(dataStr);
          } catch (_) {
            parsed = dataStr;
          }

          if (currentEvent === "status") {
            if (waitingStatusText && parsed?.phrase) {
              waitingStatusText.textContent = parsed.phrase;
            }
          } else if (currentEvent === "token") {
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
          } else if (currentEvent === "done") {
            finalPayload = parsed;
          } else if (currentEvent === "error") {
            throw new Error(parsed?.message || "Agent request failed.");
          }
        }
      }
    }

    const clientDurationMs = Math.round(performance.now() - requestStartTime);
    if (finalPayload) {
      if (finalPayload.conversationId) {
        activeConversationId = finalPayload.conversationId;
        loadConversations();
      }
      finalPayload.durationMs = typeof finalPayload.durationMs === "number" ? finalPayload.durationMs : clientDurationMs;
      finalPayload.ttftMs = ttftMs;
      if (bubble) {
        attachAssistantMeta(bubble, finalPayload);
      } else {
        appendAssistantMessage(finalPayload);
      }
    }
  } catch (err) {
    appendErrorMessage(err instanceof Error ? err.message : "The request failed.");
  } finally {
    stopWaitingAnimation();
    messageInput.disabled = false;
    sendButton.disabled = false;
    messageInput.focus();
    scrollToBottom();
  }
});

// Load conversations on startup
loadConversations();
