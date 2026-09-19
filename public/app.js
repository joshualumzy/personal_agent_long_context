const CONSENT_POLICY_VERSION = "consent-v1";

const form = document.querySelector("#transcript-form");
const submitButton = document.querySelector("#submit-button");
const result = document.querySelector("#submission-result");
const memoryList = document.querySelector("#memory-list");
const refreshButton = document.querySelector("#refresh-memory");
const userIdInput = document.querySelector("#user-id");
const questionForm = document.querySelector("#question-form");
const askButton = document.querySelector("#ask-button");
const answerResult = document.querySelector("#answer-result");
const answerPanel = document.querySelector("#answer");

const attestationInputs = [...document.querySelectorAll('input[name="attestation"]')];
attestationInputs.forEach((input) => {
  input.addEventListener("change", () => {
    submitButton.disabled = !attestationInputs.some((choice) => choice.checked);
  });
});

function showStatus(element, kind, message, correlationId) {
  element.className = `result ${kind}`;
  element.textContent = correlationId ? `${message} Reference: ${correlationId}` : message;
}

function showResult(kind, message, correlationId) {
  showStatus(result, kind, message, correlationId);
}

function showAnswerStatus(kind, message, correlationId) {
  showStatus(answerResult, kind, message, correlationId);
}

function renderAnswer(body) {
  answerPanel.replaceChildren();

  const text = document.createElement("p");
  text.className = "answer-text";
  text.textContent = body.answer;

  const trace = document.createElement("p");
  trace.className = "answer-trace";
  trace.textContent = body.runRef
    ? `Correlation ${body.correlationId} · Run ${body.runRef}`
    : `Correlation ${body.correlationId} · No run to inspect`;

  const sources = document.createElement("p");
  sources.className = "answer-sources";
  sources.textContent = body.sources.length
    ? `Supporting Transcript sources: ${body.sources
        .map((source) => source.sourceId)
        .join(", ")}`
    : "Letta did not report supporting Transcript sources for this answer.";

  answerPanel.append(text, trace, sources);
}

function renderMemory(inspection) {
  memoryList.replaceChildren();
  if (!inspection.items.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No retained Memory is currently exposed for this user.";
    memoryList.append(empty);
    return;
  }

  inspection.items.forEach((item) => {
    const article = document.createElement("article");
    const heading = document.createElement("h3");
    const content = document.createElement("pre");
    heading.textContent = item.label;
    content.textContent = item.content;
    article.append(heading, content);

    if (item.description) {
      const description = document.createElement("p");
      description.textContent = item.description;
      article.append(description);
    }
    memoryList.append(article);
  });
}

async function refreshMemory() {
  const userId = userIdInput.value.trim();
  if (!userId) {
    showResult("error", "Enter a user identifier before inspecting Memory.");
    return;
  }

  refreshButton.disabled = true;
  try {
    const response = await fetch(`/api/v1/users/${encodeURIComponent(userId)}/memory`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? "Memory inspection failed.");
    renderMemory(body);
  } catch (error) {
    showResult("error", error instanceof Error ? error.message : "Memory inspection failed.");
  } finally {
    refreshButton.disabled = false;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  const data = new FormData(form);
  const localRecordedAt = String(data.get("recordedAt"));
  const recordedAt = new Date(localRecordedAt).toISOString();
  const payload = {
    userId: String(data.get("userId")),
    sourceId: String(data.get("sourceId")),
    recordedAt,
    transcript: String(data.get("transcript")),
    attestation: String(data.get("attestation")),
    policyVersion: CONSENT_POLICY_VERSION,
  };

  submitButton.disabled = true;
  showResult("pending", "Submitting Transcript…");
  try {
    const response = await fetch("/api/v1/transcripts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) {
      showResult("error", body.message ?? "Transcript was rejected.", body.correlationId);
      return;
    }

    showResult("success", "Transcript accepted.", body.correlationId);
    await refreshMemory();
  } catch {
    showResult("error", "The server could not be reached. Your Transcript remains in the form.");
  } finally {
    submitButton.disabled = !attestationInputs.some((choice) => choice.checked);
  }
});

questionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!questionForm.reportValidity()) return;

  const payload = {
    userId: userIdInput.value.trim(),
    question: String(new FormData(questionForm).get("question")),
  };

  askButton.disabled = true;
  answerPanel.replaceChildren();
  showAnswerStatus("pending", "Asking your agent…");
  try {
    const response = await fetch("/api/v1/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) {
      showAnswerStatus(
        "error",
        body.message ?? "The question could not be answered.",
        body.correlationId,
      );
      return;
    }

    showAnswerStatus("success", "Answered from retained Memory.", body.correlationId);
    renderAnswer(body);
  } catch {
    showAnswerStatus("error", "The server could not be reached. Your question was not sent.");
  } finally {
    askButton.disabled = false;
  }
});

refreshButton.addEventListener("click", refreshMemory);
