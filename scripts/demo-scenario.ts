/**
 * The demonstration scenario: life-administration plans that get created,
 * revised, cancelled, contradicted out of order, and finally questioned.
 *
 * It drives the same application interface the browser uses, so what it
 * proves is what a person would see. Run it against a server connected to a
 * real Letta App Server:
 *
 *   npm start                       # in one terminal
 *   npm run demo:scenario           # in another
 *
 * It writes a timestamped record under docs/evidence/ so the observed
 * behavior can be cited rather than described from memory.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { CONSENT_POLICY_VERSION } from "../src/domain.js";

const base = process.env.DEMO_BASE_URL ?? "http://127.0.0.1:3000";
const userId = process.env.DEMO_USER_ID ?? `demo-${new Date().toISOString().slice(0, 10)}`;

interface Step {
  kind: "transcript" | "question";
  label: string;
  sourceId?: string;
  recordedAt?: string;
  text: string;
  expect: string;
}

const steps: Step[] = [
  {
    kind: "transcript",
    label: "Create",
    sourceId: "plan-001",
    recordedAt: "2026-09-01T09:00:00+08:00",
    text: "Note to self. I booked the dentist for Thursday the 24th at 9am, and I signed up for the Tuesday evening pottery class.",
    expect: "accepted",
  },
  {
    kind: "transcript",
    label: "Revise",
    sourceId: "plan-002",
    recordedAt: "2026-09-08T09:00:00+08:00",
    text: "Quick update. I moved the dentist appointment to Friday the 25th at 2pm.",
    expect: "accepted",
  },
  {
    kind: "transcript",
    label: "Cancel",
    sourceId: "plan-003",
    recordedAt: "2026-09-15T09:00:00+08:00",
    text: "I cancelled the pottery class, I am not going to continue with it.",
    expect: "accepted",
  },
  {
    kind: "question",
    label: "Query after update and cancellation",
    text: "What is currently on my calendar?",
    expect: "Friday the 25th at 2pm, no Thursday slot, no pottery class",
  },
  {
    kind: "transcript",
    label: "Late older upload",
    sourceId: "plan-004",
    recordedAt: "2026-09-05T09:00:00+08:00",
    text: "Confirming the dentist is Thursday the 24th at 9am.",
    expect: "accepted, but recorded earlier than the revision",
  },
  {
    kind: "question",
    label: "Query after the late older upload",
    text: "When is my dentist appointment?",
    expect: "still Friday the 25th at 2pm",
  },
  {
    kind: "transcript",
    label: "Ambiguous contradiction",
    sourceId: "plan-005",
    recordedAt: "2026-09-18T09:00:00+08:00",
    text: "I might switch the dentist to a morning slot, I am not sure yet.",
    expect: "accepted",
  },
  {
    kind: "question",
    label: "Query after the ambiguous contradiction",
    text: "When is my dentist appointment?",
    expect: "surfaces the unresolved conflict rather than picking one",
  },
];

async function post(path: string, body: unknown) {
  const started = Date.now();
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    elapsedMs: Date.now() - started,
  };
}

const record: unknown[] = [];

console.log(`Scenario user: ${userId}`);
console.log(`Application:   ${base}\n`);

for (const step of steps) {
  process.stdout.write(`[${step.label}] `);
  const result =
    step.kind === "transcript"
      ? await post("/api/v1/transcripts", {
          userId,
          sourceId: step.sourceId,
          recordedAt: step.recordedAt,
          transcript: step.text,
          attestation: "uploader_only_identifiable_speaker",
          policyVersion: CONSENT_POLICY_VERSION,
        })
      : await post("/api/v1/questions", { userId, question: step.text });

  console.log(`${result.status} in ${(result.elapsedMs / 1000).toFixed(0)}s`);
  if (step.kind === "question") {
    console.log(`   Q: ${step.text}`);
    console.log(`   A: ${String(result.body.answer ?? result.body.message)}`);
    const sources = result.body.sources as { sourceId: string }[] | undefined;
    console.log(`   sources: ${sources?.map((s) => s.sourceId).join(", ") || "none"}`);
  }
  console.log(`   expected: ${step.expect}\n`);
  record.push({ ...step, result });
}

process.stdout.write("[Memory inspection] ");
const inspectionStarted = Date.now();
const inspection = await fetch(
  `${base}/api/v1/users/${encodeURIComponent(userId)}/memory`,
).then((response) => response.json());
console.log(`${((Date.now() - inspectionStarted) / 1000).toFixed(0)}s\n`);
for (const item of inspection.items ?? []) {
  console.log(`--- ${item.label}`);
  console.log(item.content);
}
record.push({ kind: "inspection", result: inspection });

await mkdir("docs/evidence", { recursive: true });
const out = `docs/evidence/demo-scenario-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await writeFile(out, `${JSON.stringify({ userId, base, record }, null, 2)}\n`);
console.log(`\nRecorded to ${out}`);
