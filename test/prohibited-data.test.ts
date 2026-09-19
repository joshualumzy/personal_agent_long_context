import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { CONSENT_POLICY_VERSION } from "../src/domain.js";
import { buildApp } from "../src/http-app.js";
import { prohibitedDataRules } from "../src/prohibited-data.js";

function validSubmission(overrides: Record<string, unknown> = {}) {
  return {
    userId: "demo-user",
    sourceId: "voice-note-001",
    recordedAt: "2026-09-18T13:45:00+08:00",
    transcript: "I prefer planning the week on Sunday evening.",
    attestation: "uploader_only_identifiable_speaker",
    policyVersion: CONSENT_POLICY_VERSION,
    ...overrides,
  };
}

/** Builds an app whose Fastify log output is captured for assertions. */
function loggingApp() {
  const lines: string[] = [];
  const memory = new DeterministicMemoryProvider();
  const app = buildApp({
    memory,
    logger: {
      level: "info",
      stream: {
        write(line: string) {
          lines.push(line);
        },
      },
    },
  });
  return { app, memory, lines };
}

const blocked = [
  {
    label: "a credential",
    category: "authentication secret",
    value: "hunter2-correct-horse",
    transcript: "Reminder to myself, my password is hunter2-correct-horse.",
  },
  {
    label: "an authentication secret",
    category: "authentication secret",
    value: "sk-abcdefghijklmnopqrstuvwx",
    transcript: "The deploy token sk-abcdefghijklmnopqrstuvwx still works.",
  },
  {
    label: "a payment card",
    category: "payment or bank detail",
    value: "4111 1111 1111 1111",
    transcript: "Booking used card number: 4111 1111 1111 1111 last Tuesday.",
  },
  {
    label: "a bank account",
    category: "payment or bank detail",
    value: "1234567890",
    transcript: "Transfer to bank account number: 1234567890 on Friday.",
  },
  {
    label: "an IBAN",
    category: "payment or bank detail",
    value: "GB33BUKB20201555555555",
    transcript: "Landlord sent IBAN: GB33BUKB20201555555555 for the deposit.",
  },
  {
    label: "a SWIFT code",
    category: "payment or bank detail",
    value: "DBSSSGSG",
    transcript: "Use swift code DBSSSGSG when you send the transfer.",
  },
  {
    label: "a private key",
    category: "private key",
    value: "MIIEpAIBAAKCAQEA",
    transcript: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n",
  },
  {
    label: "a government identifier",
    category: "government identifier",
    value: "S1234567D",
    transcript: "For the form, my NRIC is S1234567D.",
  },
  {
    label: "a social security number",
    category: "government identifier",
    value: "123-45-6789",
    transcript: "Tax call needs the social security number 123-45-6789.",
  },
];

describe("Prohibited Data gate", () => {
  test("documents a rule for every covered category", () => {
    const categories = new Set(prohibitedDataRules.map((rule) => rule.category));
    assert.deepEqual(
      [...categories].sort(),
      [
        "authentication secret",
        "government identifier",
        "payment or bank detail",
        "private key",
      ],
    );
    assert.equal(
      prohibitedDataRules.every((rule) => rule.id.length > 0),
      true,
    );
  });

  for (const example of blocked) {
    test(`rejects ${example.label} before Letta receives it`, async () => {
      const { app, memory, lines } = loggingApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/transcripts",
        payload: validSubmission({ transcript: example.transcript }),
      });

      assert.equal(response.statusCode, 422);
      const body = response.json();
      assert.equal(body.code, "prohibited_data");
      assert.equal(body.category, example.category);
      assert.equal(typeof body.rule, "string");

      // The rejection names the category but never the value.
      assert.equal(response.body.includes(example.value), false);
      assert.match(body.message, new RegExp(example.category));

      // Nothing reached the Memory provider.
      assert.equal(memory.ingested.length, 0);

      // Captured logs hold neither the value nor the Transcript text.
      const log = lines.join("");
      assert.equal(log.includes(example.value), false);
      assert.equal(log.includes(example.transcript.slice(0, 24)), false);

      await app.close();
    });
  }

  test("accepts ordinary Useful Personal Context", async () => {
    const accepted = [
      "My sister Mei lives in Bukit Timah and prefers hiking over running.",
      "I need to change my password soon, it has been about a year.",
      "Flight SQ0322 lands at 0710 and my manager Priya wants the notes first.",
      "Order 4111111111111112 was delivered to the office on Tuesday.",
      "I moved my weekly planning to Sunday evening and switched to oat flat white.",
      // Found by scanning the Memora weekly corpus: the bank rules used to
      // read the Swift language and the adjective as a SWIFT/BIC code.
      "Swift, a language used for Apple's ecosystem, shares some concepts with Kotlin.",
      "The committee reached a swift resolution to the imbalance.",
      "My passport expired last winter and the renewal took six weeks.",
    ];

    for (const [index, transcript] of accepted.entries()) {
      const { app, memory } = loggingApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/transcripts",
        payload: validSubmission({ sourceId: `voice-note-1${index}`, transcript }),
      });

      assert.equal(response.statusCode, 202, `rejected: ${transcript}`);
      assert.equal(memory.ingested.length, 1);
      await app.close();
    }
  });

  test("keeps Transcript text out of the log on an accepted submission", async () => {
    const { app, lines } = loggingApp();
    const transcript = "A private detail about Sunday that must not be logged.";

    await app.inject({
      method: "POST",
      url: "/api/v1/transcripts",
      payload: validSubmission({ transcript }),
    });

    const log = lines.join("");
    assert.equal(log.includes(transcript), false);
    assert.equal(log.includes("must not be logged"), false);
    await app.close();
  });

  test("describes the gate as basic rather than comprehensive", async () => {
    const { app } = loggingApp();
    const page = await app.inject({ method: "GET", url: "/" });

    assert.match(page.body, /basic prohibited-data filtering/i);
    assert.equal(/comprehensive PII|anonymis|anonymiz/i.test(page.body), false);
    await app.close();
  });
});
