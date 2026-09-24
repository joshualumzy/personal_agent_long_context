import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";

async function openSmePage() {
  const app = buildApp({ memory: new DeterministicMemoryProvider() });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const [html, markedScript, domPurifyScript, script] = await Promise.all([
    fetch(`${base}/sme`).then((response) => response.text()),
    fetch(`${base}/vendor/marked.js`).then((response) => response.text()),
    fetch(`${base}/vendor/dompurify.js`).then((response) => response.text()),
    fetch(`${base}/sme.js`).then((response) => response.text()),
  ]);
  const dom = new JSDOM(html, { url: `${base}/sme`, runScripts: "outside-only" });
  const { window } = dom;
  Object.defineProperty(window, "fetch", {
    value: async () =>
      new Response(
        JSON.stringify({
          answer: [
            "## Answer",
            "",
            "**Established facts**",
            "",
            "The **TitanDB migration** includes the&#x20;****`/config`****&#x20;service [source:CONF-ENG-239].",
            "<img src=x onerror=alert('unsafe')>",
          ].join("\n"),
          runId: "render-test",
          toolCalls: [{ name: "search_company_knowledge", arguments: {} }],
          sources: [
            {
              sourceId: "CONF-ENG-239",
              sourceType: "confluence",
              title: "Remote config design",
              excerpt: "Evidence",
            },
          ],
          personalMemory: {
            answer: "Jax is coordinating the TitanDB migration rollout.",
            sources: [{ sourceId: "note-jax-1", label: "context/note-jax-1" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    writable: true,
  });
  const form = window.HTMLFormElement.prototype as unknown as {
    reportValidity?: () => boolean;
  };
  form.reportValidity ??= () => true;
  window.eval(markedScript);
  window.eval(domPurifyScript);
  window.eval(script);

  return {
    app,
    window,
    document: window.document,
    async close() {
      window.close();
      await app.close();
    },
  };
}

describe("SME answer rendering", () => {
  test("renders model Markdown without exposing markup or encoded spaces", async () => {
    const page = await openSmePage();
    after(() => page.close());
    const form = page.document.querySelector("#question-form") as HTMLFormElement;
    const question = page.document.querySelector("#question") as HTMLTextAreaElement;
    question.value = "What is the latest project?";
    form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));

    const deadline = Date.now() + 2_000;
    while (page.document.querySelector("#answer")?.hasAttribute("hidden")) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the SME answer.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const rendered = page.document.querySelector("#answer-text")!;
    assert.equal(rendered.querySelector("h2")?.textContent, "Answer");
    assert.deepEqual(
      [...rendered.querySelectorAll("strong")].map((node) => node.textContent),
      ["Established facts", "TitanDB migration"],
    );
    assert.equal(rendered.querySelector("code")?.textContent, "/config");
    assert.doesNotMatch(rendered.textContent ?? "", /&#x20;|\*\*\*\*/);
    assert.equal(rendered.querySelector("[onerror]"), null);
    assert.equal(page.document.querySelector("#memory-section")?.hasAttribute("hidden"), false);
    assert.match(page.document.querySelector("#memory-answer")?.textContent ?? "", /coordinating/);
  });
});
