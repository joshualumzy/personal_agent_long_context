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
      ["/meetings", "/", "/graph"],
    );
    assert.equal(page.document.querySelector('.app-nav a[aria-current="page"]')?.getAttribute("href"), "/");
    const sheets = [...page.document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.getAttribute("href"));
    assert.equal(sheets[0], "/theme.css", "the shared theme loads before the page's own styles");
  });
});

describe("SME Assistant conversational rendering", () => {
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

  test("the graph entry sits with the other apps in the sidebar and leads somewhere", async () => {
    const app = buildApp({ memory: new DeterministicMemoryProvider() });
    try {
      const page = await app.inject({ method: "GET", url: "/" });
      const dom = new JSDOM(page.body);
      const document = dom.window.document;

      // One way in from every page: the shared sidebar, next to Meetings and the assistant.
      const links = document.querySelectorAll('a[href="/graph"]');
      assert.equal(links.length, 1, "one way into the graph, not two");
      const link = links[0]!;
      assert.ok(link.closest("#sidebar .app-nav"), "the graph is one of the apps in the sidebar");
      assert.match(link.textContent!, /Graph/);

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
    assert.equal(page.document.querySelector(".chat-block a"), null, "no separate full page: the panel is the place, and it can be pinned");
    const pin = page.document.querySelector(".chat-block .pin-panel") as HTMLButtonElement;
    assert.ok(pin, "a candidate panel can be pinned");
    pin.click();
    assert.equal(page.document.querySelector(".chat-block .pin-panel:not([hidden])"), null, "a pinned role offers no second pin");

    const pinned = page.document.querySelector("#pinned-panel")!;
    assert.equal(pinned.hasAttribute("hidden"), false);
    assert.match(pinned.querySelector("iframe")!.getAttribute("src")!, /role=role-7/);

    await send("Any more?", 2);
    const latest = [...page.document.querySelectorAll(".chat-block")].at(-1)!;
    assert.equal(latest.querySelector("iframe"), null, "the pinned panel already shows them");
    assert.match(latest.textContent ?? "", /Shown on the right/);

    (pinned.querySelector(".unpin-panel") as HTMLButtonElement).click();
    assert.equal(pinned.hasAttribute("hidden"), true);
    assert.ok(page.document.querySelector(".chat-block .pin-panel:not([hidden])"), "once unpinned, it can be pinned again");
  });
});


// What the assistant page already does for a signed-in employee. The page's
// layout is about to change; these describe behaviour that has to survive it.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const JAX = { employeeId: "jax", displayName: "Jax", role: "Backend Engineer", department: "Engineering_Backend" };

async function until(check: () => unknown, what: string, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function signedIn(extra: PageOptions["respond"] = () => undefined): PageOptions["respond"] {
  return (url, init) => {
    const own = extra(url, init);
    if (own) return own;
    if (url === "/api/v1/auth/me") return json({ authenticated: true, employee: JAX });
    if (url === "/api/v1/conversations" && (!init?.method || init.method === "GET")) {
      return json([{ conversationId: "c1", title: "Was ZD-101 the same bug?", updatedAt: new Date().toISOString() }]);
    }
    if (url === "/api/v1/conversations/c1") {
      return json({ messages: [
        { role: "user", content: "Was ZD-101 the same bug?" },
        { role: "assistant", content: "Related, not the same bug.", metadata: {} },
      ] });
    }
    return undefined;
  };
}

describe("SME Assistant keeps what it already does", () => {
  test("lists the employee's saved conversations and opens one", async () => {
    const page = await openSmePage({ respond: signedIn() });
    after(() => page.close());
    await until(() => page.document.querySelector(".conversation-item"), "the saved conversations");

    const item = page.document.querySelector(".conversation-item") as HTMLButtonElement;
    assert.match(item.textContent!, /Was ZD-101 the same bug\?/);
    item.click();
    await until(() => page.document.querySelector(".message-row.assistant"), "the conversation to load");
    assert.match(page.document.querySelector("#chat-messages")!.textContent!, /Related, not the same bug\./);
  });

  test("a new chat clears the conversation on screen", async () => {
    const page = await openSmePage({ respond: signedIn() });
    after(() => page.close());
    await until(() => page.document.querySelector(".conversation-item"), "the saved conversations");
    (page.document.querySelector(".conversation-item") as HTMLButtonElement).click();
    await until(() => page.document.querySelector(".message-row.assistant"), "the conversation to load");

    (page.document.querySelector("#new-chat-btn") as HTMLButtonElement).click();
    assert.equal(page.document.querySelector("#chat-messages")!.children.length, 0);
  });

  test("clearing all conversations asks first, then deletes them", async () => {
    const page = await openSmePage({
      respond: signedIn((url, init) => (url === "/api/v1/conversations" && init?.method === "DELETE" ? json({ ok: true }) : undefined)),
      setup: (window) => { (window as unknown as { confirm: () => boolean }).confirm = () => true; },
    });
    after(() => page.close());
    await until(() => page.document.querySelector(".conversation-item"), "the saved conversations");

    const clear = page.document.querySelector("#clear-all-conversations-btn") as HTMLButtonElement;
    assert.equal(clear.hidden, false);
    clear.click();
    // The first request loaded the list; the next one is the delete.
    await until(() => page.requests.filter((request) => request.url === "/api/v1/conversations").length >= 2, "the delete");
  });

  test("clicking the signed-in employee opens the directory to switch persona", async () => {
    const page = await openSmePage({ respond: signedIn((url) => (url === "/api/v1/auth/personas" ? json([JAX, { employeeId: "deepa", displayName: "Deepa", role: "Infra Lead", department: "Engineering_Backend" }]) : undefined)) });
    after(() => page.close());
    await until(() => page.document.querySelector(".conversation-item"), "sign-in to finish");
    assert.equal(page.document.querySelector("#login-dialog")!.hasAttribute("open"), false);

    (page.document.querySelector("#sidebar-user-container") as HTMLElement).click();
    await until(() => page.document.querySelector("#login-dialog")!.hasAttribute("open"), "the directory");
    await until(() => /Deepa/.test(page.document.querySelector("#persona-grid")!.textContent!), "the personas");
  });

  test("logging out ends the session and asks to sign in again", async () => {
    const page = await openSmePage({ respond: signedIn((url) => (url === "/api/v1/auth/logout" ? json({ ok: true }) : undefined)) });
    after(() => page.close());
    await until(() => page.document.querySelector(".conversation-item"), "sign-in to finish");

    (page.document.querySelector("#logout-btn") as HTMLButtonElement).click();
    await until(() => page.requests.some((request) => request.url === "/api/v1/auth/logout"), "the logout request");
    await until(() => page.document.querySelector("#login-dialog")!.hasAttribute("open"), "the sign-in dialog");
  });

  test("a cited source opens in a dialog with its full text", async () => {
    const page = await openSmePage({
      respond: signedIn((url) => (url === "/api/v1/company/sources/CONF-ENG-239"
        ? json({ sourceId: "CONF-ENG-239", sourceType: "confluence", title: "Remote config design", body: "The whole page.", department: "Engineering" })
        : undefined)),
    });
    after(() => page.close());
    await until(() => page.document.querySelector(".conversation-item"), "sign-in to finish");
    const input = page.document.querySelector("#message-input") as HTMLTextAreaElement;
    input.value = "What is the latest project?";
    page.document.querySelector("#chat-form")!.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
    await until(() => page.document.querySelector('.message-row.assistant [data-source-id="CONF-ENG-239"]'), "the cited source");

    (page.document.querySelector('.message-row.assistant [data-source-id="CONF-ENG-239"]') as HTMLElement).click();
    await until(() => page.document.querySelector("#source-title")!.textContent === "Remote config design", "the source dialog");
  });
});
