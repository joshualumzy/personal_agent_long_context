import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { JSDOM } from "jsdom";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import type { MeetingActions, MeetingState, ProposedAction } from "../src/meetings/domain.js";
import { buildApp } from "../src/http-app.js";

// The page only needs the service for its API routes, which these tests
// answer with a fake fetch; serving the HTML and script is what matters here.
const unusedService = {} as MeetingActions;

function action(overrides: Partial<ProposedAction> & Pick<ProposedAction, "id" | "kind" | "tier" | "status" | "title">): ProposedAction {
  return {
    meetingId: "m1",
    trigger: { segmentIndex: 0, quote: "", speaker: "" },
    payload: {} as ProposedAction["payload"],
    payloadHash: `hash-${overrides.id}`,
    version: 1,
    evidence: [],
    dedupeKey: overrides.id,
    createdAt: "2026-09-27T02:00:00.000Z",
    ...overrides,
  } as ProposedAction;
}

function scenario(): MeetingState {
  return {
    meetingId: "m1",
    title: "NOC SLA escalation & weekly sync",
    employeeId: "jax",
    status: "live",
    startedAt: "2026-09-27T02:00:00.000Z",
    segments: [
      { index: 0, speaker: "Owen", text: "Wasn't there a similar Kafka offset issue in February, ENG-148?" },
      { index: 1, speaker: "Owen", text: "This is the second SLA breach this quarter." },
      { index: 2, speaker: "Jax", text: "I'll send a follow-up email today with the root cause." },
      { index: 3, speaker: "Marcus", text: "I'm going to offer a 20% discount on next quarter's fee." },
      { index: 4, speaker: "Deepa", text: "I'll open a ticket for Ben to add consumer-lag alerting." },
    ],
    decisions: [{ text: "Going with approach B", speaker: "Jax", segmentIndex: 2 }] as MeetingState["decisions"],
    assignments: [
      { owner: "Jax", task: "send Owen the root cause in writing", due: "today", segmentIndex: 2, speaker: "Jax" },
      { owner: "Deepa", task: "ticket for Ben on consumer-lag alerting", segmentIndex: 4, speaker: "Deepa" },
      // Part of the email draft, so not a promise of its own.
      { owner: "Owen", task: "fold the ZD-102 answer into the follow-up", segmentIndex: 0, speaker: "Owen", partOf: "email" },
    ] as MeetingState["assignments"],
    actions: [
      action({
        id: "answer",
        kind: "answer_question",
        tier: "auto",
        status: "executed",
        title: "ENG-148 was a different bug",
        trigger: { segmentIndex: 0, quote: "a similar Kafka offset issue", speaker: "Owen" },
        payload: { question: "Was ENG-148 the same?", answer: "No, ENG-148 was a reset policy bug.", citedSourceIds: [] },
      }),
      action({
        id: "conflict",
        kind: "flag_conflict",
        tier: "auto",
        status: "executed",
        title: "Second SLA breach this quarter",
        trigger: { segmentIndex: 1, quote: "second SLA breach", speaker: "Owen" },
        payload: { statement: "second breach", priorDecision: "credit clause", explanation: "credit applies" },
      }),
      action({
        id: "email",
        kind: "email_draft",
        tier: "approval",
        status: "proposed",
        title: "Email: Send follow-up to Owen",
        trigger: { segmentIndex: 2, quote: "I'll send a follow-up email today", speaker: "Jax" },
        payload: { to: "owen@notc.example", subject: "ZD-101 root cause", body: "Hi Owen," },
        missing: ["Email address for Owen (National Olympic Training Center)", "Owen's phone number"],
      }),
      action({
        id: "credit",
        kind: "escalation",
        tier: "escalate",
        status: "escalated",
        title: "Escalation: Approval required: 20% service credit",
        trigger: { segmentIndex: 3, quote: "offer a 20% discount", speaker: "Marcus" },
        payload: { subject: "Service credit", reason: "Pricing is outside your role", requiredApprover: "Marcus" },
      }),
      action({
        id: "invite",
        kind: "calendar_draft",
        tier: "auto",
        status: "executed",
        title: "Tuesday checkpoint",
        trigger: { segmentIndex: 3, quote: "sync next Tuesday", speaker: "Owen" },
        payload: { title: "Checkpoint", attendees: [], durationMinutes: 30 },
      }),
    ],
    trace: [],
  };
}

async function openMeetingsPage(path = "/meetings") {
  const app = buildApp({ memory: new DeterministicMemoryProvider(), meetings: { service: unusedService } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    return await loadMeetingsPage(app, path);
  } catch (error) {
    // A page that fails to load must not leave the server holding the test run open.
    await app.close();
    throw error;
  }
}

async function loadMeetingsPage(app: ReturnType<typeof buildApp>, pagePath: string) {
  const { port } = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const [html, markedScript, domPurifyScript, plateScript, shellScript, script] = await Promise.all(
    [pagePath, "/vendor/marked.js", "/vendor/dompurify.js", "/plate.js", "/shell.js", "/meetings/app.js"].map((path) =>
      fetch(`${base}${path}`).then((response) => response.text()),
    ),
  );
  const dom = new JSDOM(html, { url: `${base}${pagePath}`, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;

  const posts: Array<{ path: string; body: unknown }> = [];
  const loaded = new Set<string>();
  const meeting = scenario();
  Object.defineProperty(window, "fetch", {
    writable: true,
    value: async (path: string, init?: { method?: string; body?: string }) => {
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
      if (init?.method === "POST") {
        const body = init.body ? JSON.parse(init.body) : {};
        posts.push({ path, body });
        const approved = path.match(/actions\/([^/]+)\/approve$/);
        const edited = path.match(/actions\/([^/]+)\/edit$/);
        if (edited) {
          const current = meeting.actions.find((candidate) => candidate.id === edited[1])!;
          const payload = (body as { payload: ProposedAction["payload"] }).payload;
          return json({ ...current, payload, version: 2, payloadHash: `hash-${edited[1]}-v2` });
        }
        const rejected = path.match(/actions\/([^/]+)\/reject$/);
        if (rejected) {
          const current = meeting.actions.find((candidate) => candidate.id === rejected[1])!;
          return json({ ...current, status: "rejected" });
        }
        if (approved) {
          const current = meeting.actions.find((candidate) => candidate.id === approved[1])!;
          return json({ ...current, status: "executed", result: { summary: "Sent", simulated: true } });
        }
        return json({});
      }
      loaded.add(path);
      if (path === "/api/v1/meetings") return json([{ meetingId: "m1", title: meeting.title, status: "live" }]);
      if (path === "/api/v1/meetings/replays") return json([]);
      if (path === "/api/v1/meetings/integrations") return json({ google: null });
      if (path === "/api/v1/auth/me") {
        return json({ authenticated: true, employee: { employeeId: "priya", displayName: "Priya", role: "Product Designer" } });
      }
      // The plate's own reads: what needs Priya (none, in this scenario) and her planner.
      if (path === "/api/v1/meetings/m1") return json({ meetingId: "m1", title: meeting.title, status: "live", actions: [] });
      if (path === "/api/v1/planner/days") return json({ days: [] });
      return json({});
    },
  });

  const sources: Array<{ url: string; emit(type: string, data: unknown): void }> = [];
  class FakeEventSource {
    private listeners = new Map<string, Array<(event: { data: string }) => void>>();
    onerror: unknown = null;
    constructor(readonly url: string) {
      sources.push({
        url,
        emit: (type, data) => {
          for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
        },
      });
    }
    addEventListener(type: string, listener: (event: { data: string }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    close() {}
  }
  Object.defineProperty(window, "EventSource", { value: FakeEventSource, writable: true });
  window.HTMLElement.prototype.scrollIntoView = () => {};

  window.eval(markedScript);
  window.eval(domPurifyScript);
  window.eval(plateScript);
  window.eval(shellScript);
  window.eval(script);
  // jsdom fires DOMContentLoaded itself while the document is still loading;
  // firing it again would run the page's setup twice.
  if (window.document.readyState !== "loading") window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

  const document = window.document;
  const until = async (check: () => unknown, what: string) => {
    const deadline = Date.now() + 2_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  // What the page and its plate both fetch on start: the meeting list, the
  // replays and integrations offered by the page itself, who is signed in,
  // and the plate's own "needs you" and planner reads.
  const FIRST_LOADS = [
    "/api/v1/meetings",
    "/api/v1/meetings/replays",
    "/api/v1/meetings/integrations",
    "/api/v1/auth/me",
    "/api/v1/meetings/m1",
    "/api/v1/planner/days",
  ];
  // Closing the page before they land would leave their renders running against a closed window.
  await until(
    () => FIRST_LOADS.every((path) => loaded.has(path)) && document.querySelector("#meeting-list button"),
    "the page's first loads",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  return {
    window,
    document,
    posts,
    until,
    /** Picks the meeting in the sidebar and delivers its snapshot. */
    async open() {
      (document.querySelector("#meeting-list button") as HTMLButtonElement).click();
      sources.at(-1)!.emit("snapshot", meeting);
    },
    sources,
    /** Sends a server event on the open meeting's stream. */
    emit(type: string, data: unknown) {
      sources.at(-1)!.emit(type, data);
    },
    async close() {
      window.close();
      await app.close();
    },
  };
}

const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("Meetings page", () => {
  test("one entry: the plate with Kaki that leads home, and no sidebar", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());

    const brand = page.document.querySelector("#plate .brand")!;
    assert.equal(brand.getAttribute("href"), "/");
    assert.match(brand.textContent!, /Kaki/);
    assert.equal(page.document.querySelector(".app-nav"), null, "no app links: one entry");
    assert.equal(page.document.querySelector("aside.shell-side"), null, "no sidebar");
    assert.ok(page.document.querySelector('link[href="/theme.css"]'));
    assert.doesNotMatch(page.document.body.innerHTML, /Apex Athletics/);
  });

  test("with no meeting open, offers the meetings and a new one in the page itself", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());

    const picker = page.document.querySelector("#picker")!;
    assert.ok(picker.closest(".shell-main"), "the list sits in the page, not in a sidebar");
    assert.ok(picker.querySelector("#meeting-list"));
    assert.ok(picker.querySelector("#new-meeting-form"));
    // Replaying an OrgForge meeting is for testing: kept, but out of sight.
    assert.equal(page.document.querySelector("#replay-box")!.hasAttribute("hidden"), true);
    assert.ok(page.document.querySelector("#replay-box #replay-select"));
  });

  test("shows whoever is signed in on the plate, with their initial", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());

    await page.until(() => text(page.document.querySelector("#plate .shell-user .shell-name")) === "Priya", "the signed-in person");
    assert.equal(text(page.document.querySelector("#plate .shell-user .shell-avatar")), "P");
  });

  test("puts what needs you in the tray, what it found in the notes, and the words in the side panel", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());
    await page.open();

    const tray = page.document.querySelector("#tray");
    assert.equal(text(page.document.querySelector("#tray-title")), "1 thing needs you");
    assert.match(text(tray), /Send follow-up to Owen/);
    // Kaki speaks in the tray under its own mark.
    assert.match(page.document.querySelector("#tray-toggle img")!.getAttribute("src")!, /^\/assets\/kaki-logo/);
    assert.equal(page.document.querySelector("#tray-toggle svg.sobo"), null);
    assert.doesNotMatch(text(tray), /ENG-148 was a different bug|Second SLA breach/);
    assert.doesNotMatch(text(tray), /20% service credit/, "the tray holds only what you can act on");
    assert.equal(page.document.querySelector("#handled-count"), null, "nothing is handled without you, so there is no such count");
    assert.ok(page.document.querySelector(".tray-foot")!.hasAttribute("hidden"), "no foot while nothing was blocked");

    const notes = page.document.querySelector("#doc");
    assert.match(text(notes), /ENG-148 was a different bug/);
    assert.match(text(notes), /Second SLA breach this quarter/);
    const headsUp = page.document.querySelector('.tier-group[data-tier="alerts"]');
    assert.doesNotMatch(text(headsUp), /20% service credit/, "a call for someone else is a promise, listed with the others");
    assert.match(text(notes), /Going with approach B/);
    assert.equal(text(page.document.querySelector("#doc-title")), "NOC SLA escalation & weekly sync");

    const lines = page.document.querySelectorAll(".transcript-panel #transcript li");
    assert.equal(lines.length, 5);
    assert.match(text(lines[3]!), /Marcus/);
  });

  test("shows the line an item came from when you pick it in the tray", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());
    await page.open();

    const quote = page.document.querySelector('#tray [data-action-id="email"] .trigger-quote')!;
    quote.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));

    assert.ok(page.document.querySelector("#segment-2")?.classList.contains("highlighted"));
    const row = page.document.querySelector('#tray [data-action-id="email"]')!;
    assert.ok(row.classList.contains("selected"), "the picked item opens to show its draft");
    assert.ok(row.querySelector("textarea"), "the opened draft can be edited");
  });

  test("approves the unchanged draft straight from the tray", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());
    await page.open();

    (page.document.querySelector('#tray [data-action-id="email"] .approve-btn') as HTMLButtonElement).click();
    await page.until(() => page.posts.length, "the approval request");

    assert.deepEqual(page.posts[0], { path: "/api/v1/meetings/m1/actions/email/approve", body: { payloadHash: "hash-email" } });
    await page.until(() => text(page.document.querySelector("#tray-title")) !== "1 thing needs you", "the tray to update");
    assert.equal(text(page.document.querySelector("#tray-title")), "Nothing needs you right now");
  });

  test("saves your edits and approves them in one step", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());
    await page.open();

    page.document.querySelector('#tray [data-action-id="email"] .trigger-quote')!.dispatchEvent(
      new page.window.MouseEvent("click", { bubbles: true }),
    );
    const subject = page.document.querySelector('#tray [data-action-id="email"] [data-field="subject"]') as HTMLInputElement;
    subject.value = "ZD-101: root cause and fix";
    subject.dispatchEvent(new page.window.Event("input", { bubbles: true }));

    const approve = page.document.querySelector('#tray [data-action-id="email"] .approve-btn') as HTMLButtonElement;
    assert.equal(approve.disabled, false, "an edited draft can still be approved");
    assert.equal(text(approve), "Save and approve");
    approve.click();
    await page.until(() => page.posts.length === 2, "the save and the approval");

    assert.equal(page.posts[0]!.path, "/api/v1/meetings/m1/actions/email/edit");
    assert.equal((page.posts[0]!.body as { payload: { subject: string } }).payload.subject, "ZD-101: root cause and fix");
    assert.deepEqual(page.posts[1], { path: "/api/v1/meetings/m1/actions/email/approve", body: { payloadHash: "hash-email-v2" } });
    await page.until(() => text(page.document.querySelector("#tray-title")) === "Nothing needs you right now", "the tray to update");
  });

  test("rejects a draft with an optional reason", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());
    await page.open();

    page.document.querySelector('#tray [data-action-id="email"] .trigger-quote')!.dispatchEvent(
      new page.window.MouseEvent("click", { bubbles: true }),
    );
    (page.document.querySelector('#tray [data-action-id="email"] .reject-btn') as HTMLButtonElement).click();
    const reason = page.document.querySelector('#tray [data-action-id="email"] .reject-row input') as HTMLInputElement;
    reason.value = "Marcus is writing to Owen himself";
    (page.document.querySelector('#tray [data-action-id="email"] .confirm-reject') as HTMLButtonElement).click();
    await page.until(() => page.posts.length, "the rejection");

    assert.deepEqual(page.posts[0], {
      path: "/api/v1/meetings/m1/actions/email/reject",
      body: { reason: "Marcus is writing to Owen himself" },
    });
    await page.until(() => text(page.document.querySelector("#tray-title")) === "Nothing needs you right now", "the tray to update");
  });

  test("keeps a folded draft to two lines: its title without the kind repeated, and one line on what is missing", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());
    await page.open();

    const row = page.document.querySelector('#tray [data-action-id="email"]')!;
    assert.equal(text(row.querySelector(".card-title")), "Send follow-up to Owen");
    assert.equal(row.getAttribute("data-kind"), "email_draft");
    assert.equal(
      text(row.querySelector(".missing-summary")),
      "Still needed: Email address for Owen (National Olympic Training Center) +1 more",
    );
    assert.equal(row.querySelectorAll(".missing li").length, 2, "the full list is there once the draft is opened");
  });

  test("folds the tray down to its title and back, so the notes can have the room", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());
    await page.open();

    const toggle = page.document.querySelector("#tray-toggle") as HTMLButtonElement;
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    toggle.click();
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.ok(page.document.querySelector(".tray-body")!.hasAttribute("hidden"));
    assert.ok(page.document.querySelector(".tray-foot")!.hasAttribute("hidden"));
    assert.equal(text(page.document.querySelector("#tray-title")), "1 thing needs you", "the count stays visible");

    toggle.click();
    assert.equal(page.document.querySelector(".tray-body")!.hasAttribute("hidden"), false);
  });

  test("lists every promise made in the meeting, who made it, and where it stands", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());
    await page.open();

    const rows = [...page.document.querySelectorAll("#ledger-list > li")].map((row) => ({
      who: text(row.querySelector(".promise-who")),
      what: text(row.querySelector(".promise-what")),
      status: text(row.querySelector(".promise-status")),
    }));
    assert.deepEqual(rows, [
      { who: "Jax", what: "Send follow-up to Owen", status: "Draft ready for you · 2 details missing" },
      { who: "Marcus", what: "20% service credit", status: "Needs Marcus" },
      { who: "Owen", what: "Tuesday checkpoint", status: "Done" },
      { who: "Deepa", what: "ticket for Ben on consumer-lag alerting", status: "Noted" },
    ]);
  });

  test("opens a promise's draft in the tray and shows the line it came from", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());
    await page.open();

    (page.document.querySelector("#ledger-list > li") as HTMLElement).click();
    assert.ok(page.document.querySelector("#segment-2")!.classList.contains("highlighted"));
    assert.ok(page.document.querySelector('#tray [data-action-id="email"]')!.classList.contains("selected"));
  });

  test("once the meeting is over, leads with its summary in a sentence or two, not the whole minutes", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());
    await page.open();
    assert.equal(page.document.querySelector("#doc-lead")!.hasAttribute("hidden"), true);

    page.emit("minutes", {
      minutes: {
        status: "ready",
        at: "2026-09-27T03:00:00.000Z",
        markdown:
          "# NOC SLA escalation & weekly sync\n\n2026-09-27\n\n## Summary\n\nENG-210 caused the breach. Approach B ships. A 20% credit was agreed.\n\n## Decisions\n\n- Go with approach B (Jax)\n- Offer 20% off next quarter (Marcus)\n",
      },
    });

    assert.equal(text(page.document.querySelector("#doc-lead")), "ENG-210 caused the breach. Approach B ships.", "two sentences at most");
    const decided = [...page.document.querySelectorAll("#notes li")].map((item) => text(item));
    assert.deepEqual(decided, ["Go with approach B (Jax)", "Offer 20% off next quarter (Marcus)"], "the final decisions, not the running log");
    assert.doesNotMatch(text(page.document.querySelector("#doc")), /## |Decisions\s*- /);
    assert.equal(page.document.querySelector("#minutes-copy")!.hasAttribute("hidden"), false, "the full minutes are a copy away");
    assert.match(page.document.querySelector("#minutes-download")!.getAttribute("href")!, /^data:text\/markdown/);
  });

  test("gives each meeting its own address, so a refresh or a shared link comes back to it", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());
    await page.open();
    assert.equal(page.window.location.pathname, "/meetings/m1");

    const direct = await openMeetingsPage("/meetings/m1");
    after(() => direct.close());
    await direct.until(() => direct.sources.length, "the meeting to open by itself");
    assert.equal(direct.sources[0]!.url, "/api/v1/meetings/m1/events");
    assert.equal(direct.document.querySelector("#board")!.hasAttribute("hidden"), false);
  });

  test("offers one recording control at a time, and none once the meeting is over", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());
    await page.open();
    const shown = (selector: string) => {
      const element = page.document.querySelector(selector);
      return Boolean(element) && !element!.closest("[hidden]");
    };

    assert.equal(shown("#mic-start"), true, "a live meeting can start recording");
    assert.equal(shown("#end-meeting-btn"), false, "ending replaces starting once recording, not beside it");
    assert.equal(page.document.querySelector("#mic-lang"), null, "the language is recognised, not picked");
    const sources = [...page.document.querySelectorAll("#mic-start sl-menu-item")].map((item) => item.getAttribute("value"));
    assert.deepEqual(sources, ["tab", "mic"], "what to record is asked when starting");

    page.emit("meeting", { status: "ended" });
    assert.equal(shown("#mic-start"), false);
    assert.equal(shown("#end-meeting-btn"), false);
  });

  test("an approved hiring need continues in the assistant's chat, carrying the requirement over", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());
    await page.open();

    page.emit("action", {
      action: action({
        id: "hire",
        kind: "hiring_request",
        tier: "approval",
        status: "executed",
        title: "Hiring: Backend engineer for Kafka on-call",
        trigger: { segmentIndex: 2, quote: "I'll send a follow-up email today", speaker: "Jax" },
        payload: { requirement: "Backend engineer for Kafka on-call" },
        result: { summary: "Continues in the assistant: Backend engineer for Kafka on-call", simulated: false, handoffUrl: "/" },
      }),
    });

    const link = page.document.querySelector('#tray [data-action-id="hire"] .handoff a') as HTMLAnchorElement;
    assert.equal(link.getAttribute("href"), "/");
    assert.equal(link.getAttribute("target"), null, "the assistant is this app, so it opens here");
    assert.match(text(link), /Continue in the assistant/);

    link.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    const handed = JSON.parse(page.window.sessionStorage.getItem("assistant-handoff") ?? "null");
    assert.match(handed.message, /Backend engineer for Kafka on-call/);
    assert.match(handed.message, /NOC SLA escalation & weekly sync/, "the assistant knows which meeting it came from");
  });

  test("shows what the guard refused only when it refused something", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());
    await page.open();

    page.emit("action", {
      action: action({
        id: "password",
        kind: "blocked",
        tier: "blocked",
        status: "blocked",
        title: "Not stored: a password was shared",
        trigger: { segmentIndex: 1, quote: "second SLA breach", speaker: "Owen" },
        payload: { reason: "Passwords are never stored." },
      }),
    });

    assert.equal(page.document.querySelector(".tray-foot")!.hasAttribute("hidden"), false);
    const toggle = page.document.querySelector("#blocked-toggle") as HTMLButtonElement;
    assert.equal(text(toggle), "Blocked · 1");
    toggle.click();
    assert.equal(page.document.querySelector("#blocked-list")!.hasAttribute("hidden"), false);
    assert.match(text(page.document.querySelector("#blocked-list")), /Not stored: a password was shared/);
  });

  test("a final decision in the minutes leads back to the line in the transcript where it was settled", async () => {
    const page = await openMeetingsPage();
    after(() => page.close());
    await page.open();

    page.emit("minutes", {
      minutes: {
        status: "ready",
        at: "2026-09-27T03:00:00.000Z",
        markdown: "# NOC\n\n## Summary\n\nShort.\n\n## Decisions\n\n- Go with approach B\n- Review costs monthly\n",
        decisions: [{ text: "Go with approach B", segmentIndex: 2 }, { text: "Review costs monthly" }],
      },
    });

    const [settled, unplaced] = [...page.document.querySelectorAll("#notes li")] as HTMLElement[];
    assert.ok(settled!.classList.contains("jumps"));
    assert.equal(unplaced!.classList.contains("jumps"), false, "a decision with no line does not pretend to lead anywhere");
    settled!.dispatchEvent(new page.window.MouseEvent("mouseenter"));
    assert.ok(page.document.querySelector("#segment-2")!.classList.contains("highlighted"), "pointing at it is enough");

    const promise = page.document.querySelector("#ledger-list > li") as HTMLElement;
    page.document.querySelector("#segment-2")!.classList.remove("highlighted");
    promise.dispatchEvent(new page.window.MouseEvent("mouseenter"));
    assert.ok(page.document.querySelector("#segment-2")!.classList.contains("highlighted"), "a promise shows its line the same way");
  });
});
