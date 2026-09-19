const CONSENT_POLICY_VERSION = "consent-v1";

const form = document.querySelector("#transcript-form");
const submitButton = document.querySelector("#submit-button");
const result = document.querySelector("#submission-result");
const memoryList = document.querySelector("#memory-list");
const refreshButton = document.querySelector("#refresh-memory");
const userIdInput = document.querySelector("#user-id");

const attestationInputs = [...document.querySelectorAll('input[name="attestation"]')];
attestationInputs.forEach((input) => {
  input.addEventListener("change", () => {
    submitButton.disabled = !attestationInputs.some((choice) => choice.checked);
  });
});

function showResult(kind, message, correlationId) {
  result.className = `result ${kind}`;
  result.textContent = correlationId ? `${message} Reference: ${correlationId}` : message;
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

refreshButton.addEventListener("click", refreshMemory);
