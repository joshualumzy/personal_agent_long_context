import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { JSDOM } from "jsdom";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";

/**
 * Browser-level smoke test. It loads the delivered page and the delivered
 * script, then drives the rendered controls against a live application
 * server, so the assertions cover what a person actually sees rather than
 * the HTTP interface alone. The Memory provider is deterministic, which
 * keeps the workflow fast and repeatable; `test/letta.smoke.test.ts` covers
 * the same product path against a real Letta App Server.
 */
async function openPage() {
  const memory = new DeterministicMemoryProvider();
  const app = buildApp({ memory });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const [html, script] = await Promise.all([
    fetch(base).then((response) => response.text()),
    fetch(`${base}/app.js`).then((response) => response.text()),
  ]);

  const dom = new JSDOM(html, { url: `${base}/`, runScripts: "outside-only" });
  const { window } = dom;

  // The page is delivered over HTTP; give the script the same-origin fetch and
  // form validation a real browser would provide.
  Object.defineProperty(window, "fetch", {
    value: (input: string, init?: RequestInit) =>
      fetch(new URL(String(input), base), init),
    writable: true,
  });
  const form = window.HTMLFormElement.prototype as unknown as {
    reportValidity?: () => boolean;
  };
  form.reportValidity ??= () => true;

  window.eval(script);

  const $ = <T extends Element>(selector: string) =>
    window.document.querySelector(selector) as T;

  async function waitFor(
    describeWait: string,
    predicate: () => boolean,
    timeoutMs = 5000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${describeWait}`);
  }

  return {
    memory,
    window,
    $,
    waitFor,
    async close() {
      window.close();
      await app.close();
    },
  };
}

function fillSubmission(
  page: Awaited<ReturnType<typeof openPage>>,
  values: { sourceId: string; transcript: string },
) {
  const { $, window } = page;
  $<HTMLInputElement>("#user-id").value = "demo-user";
  $<HTMLInputElement>("#source-id").value = values.sourceId;
  $<HTMLInputElement>("#recorded-at").value = "2026-09-18T13:45";
  $<HTMLTextAreaElement>("#transcript").value = values.transcript;

  const choice = $<HTMLInputElement>(
    'input[name="attestation"][value="uploader_only_identifiable_speaker"]',
  );
  choice.checked = true;
  choice.dispatchEvent(new window.Event("change", { bubbles: true }));
}

describe("Rendered workflow", () => {
  test("carries a Transcript through consent, inspection, and a question", async () => {
    const page = await openPage();
    after(() => page.close());
    const { $, waitFor, window } = page;

    // Consent gate: the control is unavailable until an attestation is chosen.
    assert.equal($<HTMLButtonElement>("#submit-button").disabled, true);
    fillSubmission(page, {
      sourceId: "voice-note-001",
      transcript: "I moved my weekly planning to Sunday evening.",
    });
    assert.equal($<HTMLButtonElement>("#submit-button").disabled, false);

    $<HTMLButtonElement>("#submit-button").click();
    await waitFor("the submission result", () =>
      $("#submission-result").textContent!.includes("accepted"),
    );
    assert.match($("#submission-result").textContent!, /Reference: /);

    // Submission refreshes the Memory panel on its own.
    await waitFor("the Memory panel", () =>
      $("#memory-list").textContent!.includes("Sunday evening"),
    );
    assert.match($("#memory-list").textContent!, /voice-note-001/);

    // Ask a question through the rendered form.
    $<HTMLTextAreaElement>("#question").value = "When do I plan my week?";
    $<HTMLButtonElement>("#ask-button").click();
    await waitFor("the answer", () => $(".answer-text") !== null);

    assert.match($(".answer-text")!.textContent!, /Sunday evening/);
    assert.match($(".answer-trace")!.textContent!, /Correlation /);
    assert.match($(".answer-sources")!.textContent!, /voice-note-001/);
    assert.match($("#answer-result").textContent!, /Answered from retained Memory/);

    // The delivered script never reaches Letta or a provider directly.
    assert.equal(window.document.querySelectorAll("script[src]").length, 1);
  });

  test("keeps rejected Transcript text in the form for correction", async () => {
    const page = await openPage();
    after(() => page.close());
    const { $, waitFor, memory } = page;

    const transcript = "Note to self, my password is hunter2-correct-horse.";
    fillSubmission(page, { sourceId: "voice-note-002", transcript });
    $<HTMLButtonElement>("#submit-button").click();

    await waitFor("the rejection", () =>
      $("#submission-result").textContent!.includes("authentication secret"),
    );

    // The text the person typed is still there to correct.
    assert.equal($<HTMLTextAreaElement>("#transcript").value, transcript);
    assert.equal(
      $("#submission-result").textContent!.includes("hunter2-correct-horse"),
      false,
    );
    assert.equal(memory.ingested.length, 0);
    assert.equal($<HTMLButtonElement>("#submit-button").disabled, false);
  });
});
