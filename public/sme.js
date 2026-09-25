const form = document.querySelector("#question-form");
const question = document.querySelector("#question");
const askButton = document.querySelector("#ask-button");
const status = document.querySelector("#status");
const answer = document.querySelector("#answer");
const answerText = document.querySelector("#answer-text");
const trace = document.querySelector("#trace");
const sourcesSection = document.querySelector("#sources-section");
const sourcesList = document.querySelector("#sources-list");
const memorySection = document.querySelector("#memory-section");
const memoryAnswer = document.querySelector("#memory-answer");
const memorySources = document.querySelector("#memory-sources");
const dialog = document.querySelector("#source-dialog");
const closeSource = document.querySelector("#close-source");

function setStatus(kind, message) {
  status.className = kind;
  status.textContent = message;
}

function normalizeModelMarkdown(markdown) {
  return markdown.replace(/\*{4}(`[^`\n]+`)\*{4}/g, "$1");
}

function renderAnswer(result) {
  const rendered = marked.parse(normalizeModelMarkdown(result.answer), {
    gfm: true,
    breaks: false,
  });
  answerText.innerHTML = DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
  });
  trace.textContent = `Run ${result.runId} · ${result.toolCalls.length} tool call${result.toolCalls.length === 1 ? "" : "s"}`;
  answer.hidden = false;
  sourcesList.replaceChildren();
  for (const source of result.sources) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "source-card";
    const kind = document.createElement("span");
    kind.textContent = source.sourceType;
    const title = document.createElement("strong");
    title.textContent = source.title;
    const id = document.createElement("small");
    id.textContent = source.sourceId;
    button.append(kind, title, id);
    button.addEventListener("click", () => showSource(source.sourceId));
    sourcesList.append(button);
  }
  sourcesSection.hidden = result.sources.length === 0;
  const personalMemory = result.personalMemory;
  memorySection.hidden = !personalMemory || personalMemory.sources.length === 0;
  if (!memorySection.hidden) {
    memoryAnswer.textContent = personalMemory.answer;
    memorySources.textContent = `Memory sources: ${personalMemory.sources.map((source) => source.sourceId).join(", ")}`;
  }
}

async function showSource(sourceId) {
  const response = await fetch(`/api/v1/company/sources/${encodeURIComponent(sourceId)}`);
  const source = await response.json();
  if (!response.ok) {
    setStatus("error", source.message ?? "The source could not be loaded.");
    return;
  }
  document.querySelector("#source-type").textContent = source.sourceType;
  document.querySelector("#source-title").textContent = source.title;
  document.querySelector("#source-meta").textContent = [source.sourceId, source.occurredAt, source.department]
    .filter(Boolean)
    .join(" · ");
  document.querySelector("#source-body").textContent = source.excerpt;
  dialog.showModal();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  askButton.disabled = true;
  answer.hidden = true;
  sourcesSection.hidden = true;
  memorySection.hidden = true;
  setStatus("pending", "Investigating company evidence…");
  try {
    const response = await fetch("/api/v1/agent/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "jax", employeeId: "jax", question: question.value.trim() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "The question could not be answered.");
    renderAnswer(result);
    setStatus("success", "Answer grounded in retrieved company evidence.");
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : "The request failed.");
  } finally {
    askButton.disabled = false;
  }
});

closeSource.addEventListener("click", () => dialog.close());
