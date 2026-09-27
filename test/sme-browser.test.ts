import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";

interface PageOptions {
  /** Answers a request before the default chat answer does; undefined falls through. */
  respond?: (url: string, init?: { method?: string; body?: string }) => Response | undefined;
  /** Runs before the page's own script, for storage the page reads as it starts. */
  setup?: (window: JSDOM["window"]) => void;
}

async function openSmePage(options: PageOptions = {}) {
  const app = buildApp({ memory: new DeterministicMemoryProvider() });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const [html, markedScript, domPurifyScript, script] = await Promise.all([
    fetch(`${base}/`).then((response) => response.text()),
    fetch(`${base}/vendor/marked.js`).then((response) => response.text()),
    fetch(`${base}/vendor/dompurify.js`).then((response) => response.text()),
    fetch(`${base}/app.js`).then((response) => response.text()),
  ]);
  const dom = new JSDOM(html, { url: `${base}/`, runScripts: "outside-only" });
  const { window } = dom;
  const requests: Array<{ url: string; body?: string }> = [];
  Object.defineProperty(window, "fetch", {
    value: async (url: string, init?: { method?: string; body?: string }) =>
      (requests.push({ url, ...(init?.body ? { body: init.body } : {}) }), options.respond?.(url, init)) ??
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
            memoryUpdated: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    writable: true,
  });
  const form = window.HTMLFormElement.prototype as unknown as {
    requestSubmit?: (this: { dispatchEvent(event: unknown): boolean }) => void;
    dispatchEvent: (event: unknown) => boolean;
  };
  form.requestSubmit ??= function (this: { dispatchEvent(event: unknown): boolean }) {
    this.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  };
  options.setup?.(window);
  window.eval(markedScript);
  window.eval(domPurifyScript);
  window.eval(script);

  return {
    app,
    window,
    requests,
    document: window.document,
    async close() {
      window.close();
      await app.close();
    },
  };
}

describe("SME Assistant shell", () => {
  test("sits in the shared shell, with the assistant as the current page", async () => {
    // The shell is plain markup, so the page's script does not need to run.
    const app = buildApp({ memory: new DeterministicMemoryProvider() });
    after(() => app.close());
    const html = (await app.inject({ method: "GET", url: "/" })).body;
    const page = { document: new JSDOM(html).window.document };

    const links = [...page.document.querySelectorAll("#sidebar .app-nav a")];
    assert.deepEqual(
      links.map((link) => link.getAttribute("href")),
      ["/meetings", "/"],
    );
    assert.equal(page.document.querySelector('.app-nav a[aria-current="page"]')?.getAttribute("href"), "/");
    const sheets = [...page.document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.getAttribute("href"));
    assert.equal(sheets[0], "/theme.css", "the shared theme loads before the page's own styles");
  });
});

describe("SME Assistant conversational rendering", () => {
  test("keeps an unvalidated token off-screen until the authoritative answer event", async () => {
    const encoder = new TextEncoder();
    let tokenChunkSent: (() => void) | undefined;
    const tokenChunk = new Promise<void>((resolve) => {
      tokenChunkSent = resolve;
    });
    let sendFinal: (() => void) | undefined;
    const sse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: status\ndata: {"phrase":"Drafting from evidence…"}\n\nevent: token\ndata: {"delta":"Unvalidated draft that must not appear"}\n\n'));
          tokenChunkSent!();
          sendFinal = () => {
            controller.enqueue(
              encoder.encode(
                'event: answer\ndata: {"text":"Validated answer [source:CONF-1]","sources":[{"sourceId":"CONF-1","sourceType":"confluence","title":"Evidence","excerpt":"Verified"}]}\n\nevent: done\ndata: {"answer":"Validated answer [source:CONF-1]","sources":[{"sourceId":"CONF-1","sourceType":"confluence","title":"Evidence","excerpt":"Verified"}],"runId":"run","toolCalls":[],"personalMemory":{"status":"empty","answer":"","sources":[]}}\n\n',
              ),
            );
            controller.close();
          };
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const page = await openSmePage({
      respond: (url) => (url.startsWith("/api/v1/agent/chat") ? sse : undefined),
      setup: (window) => {
        Object.defineProperty(window, "TextDecoder", { value: TextDecoder });
      },
    });
    after(() => page.close());

    const input = page.document.querySelector("#message-input") as HTMLTextAreaElement;
    const assistantRowsBefore = page.document.querySelectorAll(".message-row.assistant").length;
    input.value = "What is verified?";
    page.document.querySelector("#chat-form")!
      .dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));

    await tokenChunk;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      page.document.querySelectorAll(".message-row.assistant").length,
      assistantRowsBefore,
      "the unvalidated token was rendered",
    );

    sendFinal!();
    const deadline = Date.now() + 2_000;
    while (page.document.querySelectorAll(".message-row.assistant").length === assistantRowsBefore) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the validated answer.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const rows = [...page.document.querySelectorAll(".message-row.assistant")];
    const text = rows.at(-1)?.querySelector(".message-text")?.textContent ?? "";
    assert.match(text, /Validated answer/);
    assert.doesNotMatch(text, /Unvalidated draft/);
  });

  test("renders model Markdown, sanitizes unsafe markup, and displays working context", async () => {
    const page = await openSmePage();
    after(() => page.close());
    const statusIndicator = page.document.querySelector("#status-indicator");
    assert.equal(statusIndicator?.hasAttribute("hidden"), true);

    const sidebar = page.document.querySelector("#sidebar");
    assert.ok(sidebar);
    assert.ok(page.document.querySelector("#new-chat-btn"));
    assert.ok(page.document.querySelector("#conversations-list"));
    const toggleBtn = page.document.querySelector("#toggle-sidebar-btn") as HTMLButtonElement;
    assert.ok(toggleBtn);
    const collapseBtn = page.document.querySelector("#collapse-sidebar-btn") as HTMLButtonElement;
    assert.ok(collapseBtn);

    // Verify minimizing sidebar via collapse button
    collapseBtn.click();
    assert.equal(sidebar?.classList.contains("collapsed"), true);

    // Verify reopening sidebar via toggle button
    toggleBtn.click();
    assert.equal(sidebar?.classList.contains("collapsed"), false);

    const form = page.document.querySelector("#chat-form") as HTMLFormElement;
    const input = page.document.querySelector("#message-input") as HTMLTextAreaElement;
    input.value = "What is the latest project?";
    form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));

    const deadline = Date.now() + 2_000;
    while (!page.document.querySelector(".message-row.assistant")) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the SME assistant answer.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const assistantRow = page.document.querySelector(".message-row.assistant")!;
    const rendered = assistantRow.querySelector(".message-text")!;
    assert.equal(rendered.querySelector("h2")?.textContent, "Answer");
    assert.deepEqual(
      [...rendered.querySelectorAll("strong")].map((node) => node.textContent),
      ["Established facts", "TitanDB migration"],
    );
    assert.equal(rendered.querySelector("code")?.textContent, "/config");
    assert.doesNotMatch(rendered.textContent ?? "", /&#x20;|\*\*\*\*/);
    assert.equal(rendered.querySelector("[onerror]"), null);

    // Verify inline citation button was generated
    const citationBtn = rendered.querySelector(".inline-citation");
    assert.ok(citationBtn);
    assert.equal(citationBtn.getAttribute("data-source-id"), "CONF-ENG-239");

    // Verify working context indicators
    const contextTags = assistantRow.querySelector(".context-tags");
    assert.ok(contextTags);
    assert.match(contextTags.textContent ?? "", /Working memory updated/);
    assert.match(contextTags.textContent ?? "", /Working context referenced/);
  });

  test("an answer with evidence shows how that evidence connects, and opens it larger", async () => {
    const graph = {
      nodes: [
        { id: "query:What is the latest project?", refKey: "What is the latest project?", type: "query", label: "What is the latest project?" },
        { id: "item:titandb", refKey: "titandb", type: "item", subtype: "domain", label: "TitanDB" },
        { id: "document:CONF-ENG-239", refKey: "CONF-ENG-239", type: "document", label: "Remote config design" },
      ],
      edges: [
        { source: "query:What is the latest project?", target: "item:titandb", type: "matches" },
        { source: "query:What is the latest project?", target: "document:CONF-ENG-239", type: "matches" },
        { source: "document:CONF-ENG-239", target: "item:titandb", type: "about_domain" },
      ],
      truncated: false,
      centre: "query:What is the latest project?",
    };
    const page = await openSmePage({
      respond: (url) => url.startsWith("/api/v1/graph/query")
        ? new Response(JSON.stringify(graph), { status: 200, headers: { "content-type": "application/json" } })
        : undefined,
    });
    after(() => page.close());

    const input = page.document.querySelector("#message-input") as HTMLTextAreaElement;
    input.value = "What is the latest project?";
    page.document.querySelector("#chat-form")!
      .dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
    const deadline = Date.now() + 2_000;
    while (!page.document.querySelector(".answer-graph:not(.loading)")) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the answer's graph.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Asked for with the answer's own question and the evidence it cited.
    const asked = page.requests.map((request) => request.url).find((url) => url.startsWith("/api/v1/graph/query"))!;
    const parameters = new URLSearchParams(asked.split("?")[1]);
    assert.equal(parameters.get("q"), "What is the latest project?");
    assert.equal(parameters.get("sources"), "CONF-ENG-239");

    // Above the evidence cards, drawn: the question and the two things it points to.
    const assistantRow = page.document.querySelector(".message-row.assistant")!;
    const preview = assistantRow.querySelector(".answer-graph")!;
    const cards = assistantRow.querySelector(".sources-grid")!;
    assert.ok(preview.compareDocumentPosition(cards) & page.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(preview.querySelectorAll("svg g").length, 3);
    assert.match(preview.textContent!, /2 things it points to/);

    // Clicking opens the answer's graph page in a dialog, same question, same sources.
    (preview as HTMLButtonElement).click();
    const dialog = page.document.querySelector("#answer-graph-dialog")!;
    assert.ok(dialog.hasAttribute("open"));
    const frame = new URL(dialog.querySelector("iframe")!.getAttribute("src")!, "http://x");
    assert.equal(frame.pathname, "/graph/answer");
    assert.equal(frame.searchParams.get("q"), "What is the latest project?");
    assert.equal(frame.searchParams.get("sources"), "CONF-ENG-239");
    assert.equal(frame.searchParams.get("embed"), "1");
    assert.match(dialog.textContent!, /What is the latest project\?/);
  });

  test("an answer whose evidence places nothing on the graph shows no picture", async () => {
    const page = await openSmePage({
      respond: (url) => url.startsWith("/api/v1/graph/query")
        ? new Response(JSON.stringify({ nodes: [{ id: "query:x", type: "query", label: "x" }], edges: [], truncated: false }), { status: 200 })
        : undefined,
    });
    after(() => page.close());
    const input = page.document.querySelector("#message-input") as HTMLTextAreaElement;
    input.value = "x";
    page.document.querySelector("#chat-form")!
      .dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
    const deadline = Date.now() + 2_000;
    while (!page.document.querySelector(".sources-grid")) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the answer.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(page.document.querySelector(".answer-graph"), null);
    assert.ok(page.document.querySelector(".source-card"), "the evidence itself is still there");
  });

  test("the graph entry sits beside Working Context and leads somewhere", async () => {
    const app = buildApp({ memory: new DeterministicMemoryProvider() });
    try {
      const page = await app.inject({ method: "GET", url: "/" });
      const dom = new JSDOM(page.body);
      const document = dom.window.document;

      const link = document.querySelector('a[href="/graph"]');
      assert.ok(link, "the chat header should offer a way into the graph");
      assert.match(link!.textContent!, /Graph/);

      // In the same header row as the Working Context badge, and before it, so
      // the two read as one set of controls.
      const badge = document.querySelector(".employee-badge")!;
      assert.equal(link!.parentElement, badge.parentElement);
      assert.ok(
        Boolean(
          link!.compareDocumentPosition(badge) &
            dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        "the graph link should come before Working Context",
      );

      assert.equal((await app.inject({ method: "GET", url: "/graph" })).statusCode, 200);
      dom.window.close();
    } finally {
      await app.close();
    }
  });
});

describe("SME Assistant taking over from a meeting", () => {
  test("starts a chat with the hiring need a meeting handed over, once, and only when it is fresh", async () => {
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    const message = 'We need to hire: Backend engineer for Kafka on-call. This came up in the meeting "NOC sync".';
    const page = await openSmePage({
      respond: (url) => {
        if (url.startsWith("/api/v1/auth/me")) return json({ authenticated: true, employee: { employeeId: "jax", displayName: "Jax" } });
        if (url.startsWith("/api/v1/conversations")) return json([]);
        return undefined;
      },
      setup: (window) => window.sessionStorage.setItem("assistant-handoff", JSON.stringify({ message, at: Date.now() })),
    });
    after(() => page.close());

    const deadline = Date.now() + 2_000;
    while (!page.requests.some((request) => request.url === "/api/v1/agent/chat")) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the handed-over message to be sent.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const sent = page.requests.find((request) => request.url === "/api/v1/agent/chat")!;
    assert.equal(JSON.parse(sent.body!).message, message);
    assert.equal(page.window.sessionStorage.getItem("assistant-handoff"), null, "used once");
  });

  test("ignores a hand-over left from long ago", async () => {
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    const page = await openSmePage({
      respond: (url) => {
        if (url.startsWith("/api/v1/auth/me")) return json({ authenticated: true, employee: { employeeId: "jax", displayName: "Jax" } });
        if (url.startsWith("/api/v1/conversations")) return json([]);
        return undefined;
      },
      setup: (window) =>
        window.sessionStorage.setItem("assistant-handoff", JSON.stringify({ message: "old", at: Date.now() - 60 * 60 * 1000 })),
    });
    after(() => page.close());
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(page.requests.some((request) => request.url === "/api/v1/agent/chat"), false);
    assert.equal(page.window.sessionStorage.getItem("assistant-handoff"), null);
  });
});

describe("SME Assistant keeping candidates in view", () => {
  test("pins a role's candidates beside the chat, and stops repeating them inline", async () => {
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    const reply = (answer: string) =>
      json({ answer, runId: "r", toolCalls: [], sources: [], blocks: [{ type: "recruiting", view: "pool", roleId: "role-7" }] });
    let turn = 0;
    const page = await openSmePage({
      respond: (url) => {
        if (url.startsWith("/api/v1/auth/me")) return json({ authenticated: true, employee: { employeeId: "jax", displayName: "Jax" } });
        if (url.startsWith("/api/v1/conversations")) return json([]);
        if (url === "/api/v1/agent/chat") return reply(turn++ === 0 ? "Here is who I found." : "Two more people.");
        return undefined;
      },
    });
    after(() => page.close());
    const send = async (text: string, rows: number) => {
      const input = page.document.querySelector("#message-input") as HTMLTextAreaElement;
      input.value = text;
      page.document.querySelector("#chat-form")!.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
      const deadline = Date.now() + 2_000;
      while (page.document.querySelectorAll(".message-row.assistant").length < rows) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for the answer.");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    await send("Find me a backend engineer", 1);
    const pin = page.document.querySelector(".chat-block .pin-panel") as HTMLButtonElement;
    assert.ok(pin, "a candidate panel can be pinned");
    pin.click();

    const pinned = page.document.querySelector("#pinned-panel")!;
    assert.equal(pinned.hasAttribute("hidden"), false);
    assert.match(pinned.querySelector("iframe")!.getAttribute("src")!, /role=role-7/);

    await send("Any more?", 2);
    const latest = [...page.document.querySelectorAll(".chat-block")].at(-1)!;
    assert.equal(latest.querySelector("iframe"), null, "the pinned panel already shows them");
    assert.match(latest.textContent ?? "", /Shown on the right/);

    (pinned.querySelector(".unpin-panel") as HTMLButtonElement).click();
    assert.equal(pinned.hasAttribute("hidden"), true);
  });
});
