import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CompanyKnowledge, Evidence } from "../src/company-domain.js";
import { contactSnippets, gmailContactDirectory, personName } from "../src/meetings/contacts.js";
import { ActionDrafter } from "../src/meetings/drafter.js";
import type { CandidateAction, ContactDirectory, EmailPayload, MeetingState } from "../src/meetings/domain.js";
import { contactsMatching } from "../src/recruiting/gmail.js";
import type { JsonModel } from "../src/recruiting/llm.js";

function knowledgeWith(byQuery: (query: string) => Evidence[]): CompanyKnowledge & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async employee(employeeId) {
      return { employeeId, displayName: "Employee", currentAssignments: [] };
    },
    async search(query) {
      queries.push(query);
      return byQuery(query);
    },
    async related() {
      return [];
    },
    async sources() {
      return [];
    },
  };
}

const meeting = {
  meetingId: "m1",
  title: "Customer call",
  employeeId: "jax",
  status: "live",
  startedAt: "2026-09-25T02:00:00.000Z",
  segments: [{ index: 0, speaker: "Jax", text: "I'll email Priya Tan the root cause today." }],
  decisions: [],
  actions: [],
  trace: [],
} as unknown as MeetingState;

const candidate: CandidateAction = {
  kind: "email_draft",
  trigger: { segmentIndex: 0, speaker: "Jax", quote: "I'll email Priya Tan the root cause today." },
  summary: "Email Priya Tan the root cause",
  dedupeKey: "email_draft:priya",
  details: { recipient: "Priya Tan" },
};

/** Proposes whichever address appears in the evidence it was given, else none. */
function emailModel(): JsonModel & { calls: number } {
  const model = {
    calls: 0,
    async json<T>({ input }: { input: unknown }): Promise<T> {
      model.calls += 1;
      const evidence = (input as { evidence: Array<{ excerpt: string }> }).evidence;
      const address = evidence.map((item) => /<([^>]+)>/.exec(item.excerpt)?.[1]).find(Boolean) ?? "";
      return {
        to: address,
        subject: "Root cause",
        body: "Here is the root cause.",
        missing: address ? [] : [{ need: "Priya's email address", search: "", person: "Priya Tan" }],
      } as T;
    },
  };
  return model;
}

describe("looking up what a draft is missing", () => {
  test("a name in From/To/Cc headers is matched, the owner is skipped, most frequent first", () => {
    const contacts = contactsMatching(
      [
        '"Priya Tan" <priya.tan@acme.test>, Jax <jax@stellar.test>',
        "Priya Tan <priya.tan@acme.test>",
        "priya@other.test",
        "Tan Wei <wei@acme.test>",
      ],
      "Priya Tan",
      "jax@stellar.test",
    );
    assert.deepEqual(
      contacts.map((contact) => [contact.email, contact.count]),
      [
        ["priya.tan@acme.test", 2],
        ["priya@other.test", 1],
      ],
    );
  });

  test("an address found in the employee's Gmail fills the recipient on a second draft", async () => {
    const lookedUp: string[] = [];
    const contacts: ContactDirectory = {
      connected: async () => true,
      lookup: async (name) => {
        lookedUp.push(name);
        return [{ sourceId: "gmail:priya.tan@acme.test", sourceType: "gmail_contact", title: "Gmail contact: Priya Tan", excerpt: "Priya Tan <priya.tan@acme.test>" }];
      },
    };
    const model = emailModel();
    const drafter = new ActionDrafter({ model, knowledge: knowledgeWith(() => []), contacts });
    const result = await drafter.draft(candidate, meeting);

    assert.equal((result.payload as EmailPayload).to, "priya.tan@acme.test");
    assert.equal(result.missing, undefined);
    assert.deepEqual(lookedUp, ["Priya Tan"]);
    assert.equal(model.calls, 2);
    assert.ok(result.evidence.some((item) => item.sourceId === "gmail:priya.tan@acme.test"));
    assert.ok(result.lookups?.some((line) => line.includes("Gmail")));
  });

  test("someone on the meeting's invite is addressed from it, before any mailbox or record is searched", async () => {
    const invited = {
      ...meeting,
      participants: [
        { name: "Priya Tan", email: "priya.tan@acme.test", org: "Acme" },
        { name: "Jax", email: "jax@stellar.test" },
      ],
    } as MeetingState;
    const knowledge = knowledgeWith(() => []);
    const model = emailModel();
    const drafter = new ActionDrafter({ model, knowledge });
    const result = await drafter.draft(candidate, invited);

    assert.equal((result.payload as EmailPayload).to, "priya.tan@acme.test");
    assert.equal(result.missing, undefined);
    assert.ok(result.evidence.some((item) => item.sourceId === "participant:priya.tan@acme.test"));
    assert.ok(result.lookups?.some((line) => line.includes("invite")));
    assert.equal(knowledge.queries.includes("Priya Tan"), false, "she was not searched for by name");
  });

  test("a participant named with their company in the transcript is still found by name", async () => {
    const invited = { ...meeting, participants: [{ name: "Owen", email: "owen@notc.example", org: "National Olympic Training Center" }] } as MeetingState;
    const owenModel: JsonModel = {
      async json<T>({ input }: { input: unknown }): Promise<T> {
        const evidence = (input as { evidence: Array<{ excerpt: string }> }).evidence;
        const address = evidence.map((item) => /<([^>]+)>/.exec(item.excerpt)?.[1]).find(Boolean) ?? "";
        return {
          to: address,
          subject: "Follow-up",
          body: "Hi Owen",
          missing: address ? [] : [{ need: "Owen's email address", search: "", person: "Owen (National Olympic Training Center)" }],
        } as T;
      },
    };
    const drafter = new ActionDrafter({ model: owenModel, knowledge: knowledgeWith(() => []) });
    const result = await drafter.draft({ ...candidate, details: { recipient: "Owen" } }, invited);
    assert.equal((result.payload as EmailPayload).to, "owen@notc.example");
  });

  test("an invite whose every guest has an address is not held up by a vague request for one", async () => {
    const vague: JsonModel = {
      async json<T>(): Promise<T> {
        return {
          title: "Checkpoint",
          attendees: ["owen@notc.example", "marcus@apexathletics.com"],
          durationMinutes: 30,
          missing: [
            { need: "email address", search: "", person: "" },
            { need: "Agenda for the checkpoint", search: "", person: "" },
          ],
        } as T;
      },
    };
    const invite: CandidateAction = {
      kind: "calendar_draft",
      trigger: { segmentIndex: 0, speaker: "Jax", quote: "I'll email Priya Tan the root cause today." },
      summary: "Checkpoint",
      dedupeKey: "calendar_draft:checkpoint",
      details: {},
    };
    const drafter = new ActionDrafter({ model: vague, knowledge: knowledgeWith(() => []) });
    const result = await drafter.draft(invite, meeting);
    assert.equal(result.missing?.some((need) => /e-?mail|address/i.test(need)), false, "no address is asked for");
    assert.ok(result.missing?.includes("Agenda for the checkpoint"), "what is really missing is still asked for");
  });

  test("company records are searched too, and what is still not found is reported, not guessed", async () => {
    const knowledge = knowledgeWith(() => []);
    const model = emailModel();
    const drafter = new ActionDrafter({ model, knowledge });
    const result = await drafter.draft(candidate, meeting);

    assert.equal((result.payload as EmailPayload).to, "");
    assert.deepEqual(result.missing, ["Email address for Priya Tan"]);
    assert.equal(model.calls, 1, "nothing new was found, so no second draft");
    assert.ok(knowledge.queries.includes("Priya Tan"), "a person is searched by name alone");
  });

  test("a disconnected mailbox is never read", async () => {
    let read = false;
    const contacts: ContactDirectory = {
      connected: async () => false,
      lookup: async () => {
        read = true;
        return [];
      },
    };
    await new ActionDrafter({ model: emailModel(), knowledge: knowledgeWith(() => []), contacts }).draft(candidate, meeting);
    assert.equal(read, false);
  });

  test("Gmail contacts become evidence the draft can cite", async () => {
    const directory = gmailContactDirectory({
      connected: async () => true,
      contactsNamed: async () => [{ name: "Priya Tan", email: "priya.tan@acme.test", count: 2 }],
    });
    const [item] = await directory.lookup("Priya");
    assert.equal(item!.sourceId, "gmail:priya.tan@acme.test");
    assert.match(item!.excerpt, /<priya\.tan@acme\.test>/);
  });

  test("company records: a signature under the name is found, a colleague's address next to it is not", () => {
    const signature = "Thanks,  \nLena Gomez  \nCustomer Success Manager, Datadog  \nlena.gomez@datadog.com | +1 (555) 123‑4567";
    assert.equal(contactSnippets(signature, "Lena Gomez").length, 1);
    assert.match(contactSnippets(signature, "Lena Gomez")[0]!, /lena\.gomez@datadog\.com/);

    const colleague = "Priya’s side: Maya Patel (Finance Manager) maya.patel@apexathletics.com";
    assert.deepEqual(contactSnippets(colleague, "Priya"), []);

    const dated = "Priya **Date:** 2026-01-02 ## Problem Statement";
    assert.deepEqual(contactSnippets(dated, "Priya"), [], "a date is not a phone number");

    assert.equal(contactSnippets("Ask Wei Ling on 9123 4567 about stock.", "Wei Ling").length, 1);
  });

  test("a recipient named with their company is looked up by name", () => {
    assert.equal(personName("Lena Gomez at Datadog"), "Lena Gomez");
    assert.equal(personName("Mona Li from Kafka"), "Mona Li");
    assert.equal(personName("Priya (ops)"), "Priya");
  });
});

describe("draft titles", () => {
  test("a hiring draft is titled by the commitment, and a long title ends on a whole word", async () => {
    const longRequirement =
      "Hire a Backend Engineer to cover the Kafka on-call load. The role requires strong backend skills, specifically in Kafka operations and incident response, to relieve the current team.";
    const model: JsonModel = { json: async <T>() => ({ requirement: longRequirement }) as T };
    const drafter = new ActionDrafter({ model, knowledge: knowledgeWith(() => []) });
    const hiring: CandidateAction = {
      kind: "hiring_request",
      trigger: { segmentIndex: 0, speaker: "Jax", quote: "I'll email Priya Tan the root cause today." },
      summary: "Hire a backend engineer for Kafka on-call",
      dedupeKey: "hiring_request:kafka",
      details: {},
    };
    const short = await drafter.draft(hiring, meeting);
    assert.equal(short.title, "Hiring: Hire a backend engineer for Kafka on-call");

    const long = await drafter.draft({ ...hiring, summary: longRequirement }, meeting);
    assert.ok(long.title.length <= 120);
    assert.ok(long.title.endsWith("…"));
    const lastWord = long.title.slice(0, -1).trim().split(" ").at(-1)!;
    assert.ok(longRequirement.split(/\s+/).includes(lastWord), `"${lastWord}" is a whole word`);
  });
});

