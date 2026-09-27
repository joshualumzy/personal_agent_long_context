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
  /** The address the page opens at, after the host: "/?asOf=2026-01-06". */
  path?: string;
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
  const dom = new JSDOM(html, { url: `${base}${options.path ?? "/"}`, runScripts: "outside-only" });
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


describe("SME Assistant on a chosen day", () => {
  const DAYS = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"];
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

  /** A signed-in page whose planner answers by day: the day shows in every title. */
  async function plannerPage(options: { path?: string; conversations?: unknown; conversation?: unknown; answer?: unknown } = {}) {
    return openSmePage({
      ...(options.path ? { path: options.path } : {}),
      respond: (url, init) => {
        if (url.startsWith("/api/v1/auth/me")) return json({ authenticated: true, employee: { employeeId: "jax", displayName: "Jax" } });
        if (url.startsWith("/api/v1/conversations/")) return json(options.conversation ?? { messages: [] });
        if (url.startsWith("/api/v1/conversations")) return json(options.conversations ?? []);
        if (url.startsWith("/api/v1/planner/days")) return json({ days: DAYS, first: DAYS[0], last: DAYS.at(-1) });
        const day = new URLSearchParams(url.split("?")[1] ?? "").get("asOf");
        if (url.startsWith("/api/v1/planner/todo")) {
          return json({ asOf: day, person: "Jax", items: [
            { itemKey: "ENG-107", title: `tagging on ${day}`, status: "In Progress", relation: "assignee", since: "2026-01-02", points: 2, sprintNo: 1, sources: ["ENG-107"] },
            { itemKey: "ORG-105", title: "VPC review", status: "To Do", relation: "reporter", since: "2026-01-02", points: null, sprintNo: null, sources: [] },
          ] });
        }
        if (url.startsWith("/api/v1/planner/day")) {
          return json({ asOf: day, person: "Jax", entries: [
            { seq: 1, title: `refactor on ${day}`, activityType: "deep_work", estHours: 2, collaborators: [], deferred: false, deferReason: null, itemKey: "ENG-107", sources: ["ENG-107"] },
            { seq: 2, title: "check-in with deepa", activityType: "1on1", estHours: 1, collaborators: ["Deepa"], deferred: true, deferReason: "incident", itemKey: null, sources: [] },
          ] });
        }
        if (url === "/api/v1/agent/chat" && options.answer) {
          const asOf = JSON.parse(init?.body ?? "{}").asOf;
          return json({ ...(options.answer as object), ...(asOf ? { asOf } : {}) });
        }
        return undefined;
      },
    });
  }

  async function until(check: () => unknown, what: string) {
    const deadline = Date.now() + 2_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const plannerAsks = (page: Awaited<ReturnType<typeof openSmePage>>) =>
    page.requests.map((request) => request.url).filter((url) => /planner\/(todo|day)\?/.test(url));

  test("starts on today, and choosing a day reloads both lists for it", async () => {
    const page = await plannerPage();
    after(() => page.close());
    const doc = page.document;
    await until(() => doc.querySelector(".todo-item"), "the to-do list");

    assert.equal((doc.querySelector("#as-of") as HTMLElement).hidden, false);
    assert.equal((doc.querySelector("#as-of-input") as HTMLInputElement).value, "2026-01-07");
    assert.equal(doc.querySelector("#as-of-caption")!.textContent, "Today");
    assert.equal(page.window.location.search, "");
    assert.deepEqual(plannerAsks(page), ["/api/v1/planner/todo?asOf=2026-01-07", "/api/v1/planner/day?asOf=2026-01-07"]);

    // Grouped: what Jax works on, then what Jax raised and nobody picked up.
    const groups = [...doc.querySelectorAll("#todo-list h4")].map((heading) => heading.textContent);
    assert.deepEqual(groups, ["In progress · 1", "Raised by you, not picked up · 1"]);
    // A ticket that can be cited opens; one that cannot is plain text.
    assert.equal(doc.querySelectorAll("#todo-list button.todo-item").length, 1);
    // The plan in order, the deferred item struck through with its reason.
    const plan = [...doc.querySelectorAll("#plan-list .plan-item")];
    assert.equal(plan.length, 2);
    assert.ok(plan[1]!.classList.contains("deferred"));
    assert.match(plan[1]!.textContent!, /1:1 · 1h · with Deepa/);
    assert.match(plan[1]!.textContent!, /Deferred: incident/);

    const input = doc.querySelector("#as-of-input") as HTMLInputElement;
    input.value = "2026-01-05";
    input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await until(() => /2026-01-05/.test(doc.querySelector("#plan-list")!.textContent!), "the new day's plan");

    assert.equal(page.window.location.search, "?asOf=2026-01-05");
    assert.equal(doc.querySelector("#as-of-caption")!.textContent, "As of");
    assert.match(doc.querySelector("#today-date")!.textContent!, /As of/);
    assert.match(doc.querySelector("#todo-list")!.textContent!, /tagging on 2026-01-05/);
    assert.ok(!/2026-01-07/.test(doc.querySelector("#todo-list")!.textContent!), "nothing of the old day is left");
    assert.equal((doc.querySelector("#company-graph-link") as HTMLElement).hidden, true);

    // Stepping back a working day skips the weekend; back to now clears the address.
    (doc.querySelector("#as-of-prev") as HTMLButtonElement).click();
    await until(() => /2026-01-02/.test(doc.querySelector("#plan-list")!.textContent!), "the previous working day");
    assert.equal(page.window.location.search, "?asOf=2026-01-02");
    assert.equal((doc.querySelector("#as-of-prev") as HTMLButtonElement).disabled, true, "the record starts here");
    (doc.querySelector("#as-of-now") as HTMLButtonElement).click();
    await until(() => /2026-01-07/.test(doc.querySelector("#plan-list")!.textContent!), "today again");
    assert.equal(page.window.location.search, "");
    assert.equal((doc.querySelector("#company-graph-link") as HTMLElement).hidden, false);
  });

  test("an address with a day opens on it, a weekend on the Friday before", async () => {
    const page = await plannerPage({ path: "/?asOf=2026-01-04" });
    after(() => page.close());
    await until(() => page.document.querySelector(".todo-item"), "the to-do list");
    assert.equal((page.document.querySelector("#as-of-input") as HTMLInputElement).value, "2026-01-02");
    assert.equal(page.window.location.search, "?asOf=2026-01-02");
    assert.equal((page.document.querySelector("#today-panel") as HTMLElement).hidden, false, "a past day opens the panel");
    assert.deepEqual(plannerAsks(page), ["/api/v1/planner/todo?asOf=2026-01-02", "/api/v1/planner/day?asOf=2026-01-02"]);
  });

  test("a question asked on a past day carries it, and its answer says so and draws no graph", async () => {
    const page = await plannerPage({
      path: "/?asOf=2026-01-06",
      answer: {
        answer: "Finish ENG-107 first [source:ENG-107].",
        runId: "r", toolCalls: [],
        sources: [{ sourceId: "ENG-107", sourceType: "jira", title: "tagging", excerpt: "…" }],
      },
    });
    after(() => page.close());
    await until(() => page.document.querySelector(".todo-item"), "the to-do list");

    const input = page.document.querySelector("#message-input") as HTMLTextAreaElement;
    input.value = "What should I do first?";
    page.document.querySelector("#chat-form")!
      .dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
    await until(() => page.document.querySelector(".sources-grid"), "the answer");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const sent = page.requests.find((request) => request.url === "/api/v1/agent/chat")!;
    assert.equal(JSON.parse(sent.body!).asOf, "2026-01-06");
    assert.match(page.document.querySelector(".as-of-tag")!.textContent!, /As of 2026-01-06/);
    assert.equal(page.document.querySelector(".answer-graph"), null);
    assert.ok(!page.requests.some((request) => request.url.startsWith("/api/v1/graph/")));
  });

  test("opening a conversation moves the picker to the day it was asked on", async () => {
    const page = await plannerPage({
      conversations: [{ conversationId: "c1", title: "Back then", updatedAt: "2026-09-27T00:00:00Z" }],
      conversation: { messages: [
        { role: "user", content: "what now?", metadata: { asOf: "2026-01-05" } },
        { role: "assistant", content: "This.", metadata: { asOf: "2026-01-05", sources: [] } },
      ] },
    });
    after(() => page.close());
    await until(() => page.document.querySelector(".conversation-item"), "the conversation list");
    (page.document.querySelector(".conversation-item") as HTMLElement).click();
    await until(() => page.window.location.search === "?asOf=2026-01-05", "the conversation's day");
    assert.equal((page.document.querySelector("#as-of-input") as HTMLInputElement).value, "2026-01-05");
    await until(() => page.document.querySelector(".as-of-tag"), "the answer's day");
  });

  test("without a planner there is no date control and no panel", async () => {
    const page = await openSmePage({
      respond: (url) => {
        if (url.startsWith("/api/v1/auth/me")) return json({ authenticated: true, employee: { employeeId: "jax", displayName: "Jax" } });
        if (url.startsWith("/api/v1/conversations")) return json([]);
        if (url.startsWith("/api/v1/planner/")) return new Response("{}", { status: 503 });
        return undefined;
      },
    });
    after(() => page.close());
    await until(() => page.requests.some((request) => request.url.startsWith("/api/v1/planner/days")), "the planner check");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((page.document.querySelector("#as-of") as HTMLElement).hidden, true);
    assert.equal((page.document.querySelector("#today-toggle") as HTMLElement).hidden, true);
    assert.equal((page.document.querySelector("#today-panel") as HTMLElement).hidden, true);
  });
});
