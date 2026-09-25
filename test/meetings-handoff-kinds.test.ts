import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CompanyKnowledge, Evidence } from "../src/company-domain.js";
import { ActionDrafter } from "../src/meetings/drafter.js";
import type {
  CandidateAction,
  DocPayload,
  MeetingState,
  MessagePayload,
  ProposedAction,
} from "../src/meetings/domain.js";
import { DispatchingExecutor } from "../src/meetings/executor.js";
import { tierFor } from "../src/meetings/policy.js";
import type { JsonModel } from "../src/recruiting/llm.js";

const knowledge: CompanyKnowledge = {
  async employee(employeeId) {
    return { employeeId, displayName: "Employee", currentAssignments: [] };
  },
  async search(): Promise<Evidence[]> {
    return [{ sourceId: "ev1", sourceType: "doc", title: "Supplier sheet", excerpt: "Ops lead mobile: +65 9123 4567" }];
  },
  async related() {
    return [];
  },
  async sources() {
    return [];
  },
};

function modelReplying(reply: unknown): JsonModel {
  return { json: async <T>() => reply as T };
}

function meeting(text: string): MeetingState {
  return {
    meetingId: "m1",
    title: "Standup",
    employeeId: "jax",
    status: "live",
    startedAt: "2026-09-25T02:00:00.000Z",
    segments: [{ index: 0, speaker: "Jax", text }],
    decisions: [],
    actions: [],
    trace: [],
  } as MeetingState;
}

function candidate(kind: CandidateAction["kind"], quote: string): CandidateAction {
  return {
    kind,
    trigger: { segmentIndex: 0, speaker: "Jax", quote },
    summary: quote,
    dedupeKey: `${kind}:x`,
    details: {},
  };
}

function action(kind: ProposedAction["kind"], payload: ProposedAction["payload"]): ProposedAction {
  return {
    id: "a1",
    meetingId: "m1",
    kind,
    tier: "approval",
    status: "executing",
    title: "t",
    trigger: { segmentIndex: 0, speaker: "Jax", quote: "q" },
    payload,
    payloadHash: "h",
    version: 1,
    evidence: [],
    dedupeKey: "k",
    createdAt: "2026-09-25T02:00:00.000Z",
  } as ProposedAction;
}

describe("message_draft and doc_draft", () => {
  test("both need approval", () => {
    assert.equal(tierFor("message_draft", {}), "approval");
    assert.equal(tierFor("doc_draft", {}), "approval");
  });

  test("a phone number found in evidence is kept, digits only", async () => {
    const drafter = new ActionDrafter({
      model: modelReplying({ recipient: "Ops lead", address: "+65 9123-4567", text: "Stock arrives Monday." }),
      knowledge,
    });
    const result = await drafter.draft(candidate("message_draft", "I'll ping the ops lead"), meeting("I'll ping the ops lead"));
    assert.equal((result.payload as MessagePayload).address, "+6591234567");
  });

  test("an invented phone number or email is dropped", async () => {
    for (const address of ["+65 8000 0000", "ops@made-up.test"]) {
      const drafter = new ActionDrafter({
        model: modelReplying({ recipient: "Ops lead", address, text: "Stock arrives Monday." }),
        knowledge,
      });
      const result = await drafter.draft(candidate("message_draft", "I'll ping the ops lead"), meeting("I'll ping the ops lead"));
      assert.equal((result.payload as MessagePayload).address, "");
    }
  });

  test("a document draft drops citations it never retrieved", async () => {
    const drafter = new ActionDrafter({
      model: modelReplying({ title: "Launch notes", body: "- Supplier confirmed [source:ev1]\n- Price set [source:ghost]" }),
      knowledge,
    });
    const result = await drafter.draft(candidate("doc_draft", "I'll write up the notes"), meeting("I'll write up the notes"));
    const payload = result.payload as DocPayload;
    assert.equal(payload.title, "Launch notes");
    assert.match(payload.body, /\[source:ev1\]/);
    assert.doesNotMatch(payload.body, /ghost/);
  });

  test("message opens WhatsApp by default, straight to the chat when a phone is known", async () => {
    const executor = new DispatchingExecutor({});
    const result = await executor.execute(
      action("message_draft", { recipient: "Ops lead", address: "+6591234567", text: "Stock arrives Monday." }),
      meeting(""),
    );
    assert.equal(result.summary, "Ready in WhatsApp: message to Ops lead");
    const url = new URL(result.handoffUrl!);
    assert.equal(url.origin + url.pathname, "https://wa.me/6591234567");
    assert.equal(url.searchParams.get("text"), "Stock arrives Monday.");
  });

  test("Teams is used when chosen and a work email is known, else WhatsApp", async () => {
    const executor = new DispatchingExecutor({ chat: "teams" });
    const withEmail = await executor.execute(
      action("message_draft", { recipient: "Priya", address: "priya@acme.test", text: "Done." }),
      meeting(""),
    );
    const url = new URL(withEmail.handoffUrl!);
    assert.equal(url.pathname, "/l/chat/0/0");
    assert.equal(url.searchParams.get("users"), "priya@acme.test");
    assert.equal(url.searchParams.get("message"), "Done.");

    const withoutEmail = await executor.execute(
      action("message_draft", { recipient: "Priya", address: "", text: "Done." }),
      meeting(""),
    );
    assert.equal(new URL(withoutEmail.handoffUrl!).host, "wa.me");
  });

  test("a document opens a blank Google Doc or Word document with the draft to paste", async () => {
    const payload = { title: "Launch notes", body: "- Supplier confirmed" };
    const google = await new DispatchingExecutor({}).execute(action("doc_draft", payload), meeting(""));
    assert.equal(google.handoffUrl, "https://docs.new");
    assert.equal(google.handoffCopy, "# Launch notes\n\n- Supplier confirmed");

    const microsoft = await new DispatchingExecutor({ suite: "microsoft" }).execute(action("doc_draft", payload), meeting(""));
    assert.equal(microsoft.handoffUrl, "https://word.new");
  });

  test("the Microsoft suite sends calendar invites and unconnected email to Outlook", async () => {
    const executor = new DispatchingExecutor({ suite: "microsoft" });
    const invite = await executor.execute(
      action("calendar_draft", { title: "Sync", attendees: [], durationMinutes: 30 }),
      meeting(""),
    );
    assert.equal(new URL(invite.handoffUrl!).pathname, "/calendar/deeplink/compose");
    const email = await executor.execute(
      action("email_draft", { to: "a@acme.test", subject: "Hi", body: "Body" }),
      meeting(""),
    );
    assert.equal(new URL(email.handoffUrl!).pathname, "/mail/deeplink/compose");
  });
});
