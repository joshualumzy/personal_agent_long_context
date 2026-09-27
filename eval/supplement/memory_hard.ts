/**
 * Personal memory, hard tier: several facts at once, unrelated work in
 * between, a fact changed twice, and a second employee with a look-alike fact.
 *
 *   node --env-file=.env --import tsx eval/supplement/memory_hard.ts
 *
 * Needs the app on :3000 with Letta. Every turn is a fresh conversation, so
 * anything recalled came from memory. Fixed here before any run; uses non-demo
 * accounts that the easy tier does not.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeAgainstReference, judgeOptionsFromEnvironment } from "../orgforge/judge.js";
import { chat, login, memory, memoryMatching } from "./memory-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OWNER = process.env.MEMORY_OWNER ?? "sam";
const OTHER = process.env.MEMORY_OTHER ?? "reese";

/** Ordinary company questions, asked between telling and asking back. */
const DISTRACTIONS = [
  "What's on my plate today?",
  "Who owns TitanDB these days?",
  "Summarize the latest on ENG-157.",
  "Any recent customer emails from Velox Pro Cycling?",
  "What happened in the most recent incident?",
];

interface Check {
  id: string;
  passed: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const judge = judgeOptionsFromEnvironment(process.env);
  const owner = await login(OWNER);
  const other = await login(OTHER);
  const checks: Check[] = [];
  const transcript: Array<{ who: string; message: string; answer: string; sources: string[] }> = [];
  const say = async (cookie: string, who: string, message: string) => {
    const reply = await chat(cookie, message);
    transcript.push({ who, message, answer: reply.answer, sources: reply.sources.map((s) => s.sourceId) });
    console.log(`  ${who}: ${message}\n    → ${reply.answer.replace(/\s+/g, " ").slice(0, 140)}`);
    return reply.answer;
  };
  const record = (id: string, passed: boolean, detail: string) => {
    checks.push({ id, passed, detail });
    console.log(`${passed ? "✅" : "❌"} ${id}: ${detail}`);
  };
  const judged = async (id: string, question: string, reference: string, answer: string) => {
    const verdict = await judgeAgainstReference(judge, question, reference, answer);
    record(id, verdict === "agrees", `judge: ${verdict}`);
  };

  // Three facts in one message, and a look-alike fact for someone else.
  await say(owner, OWNER, "A few things to remember about me: my dog is called Pepper, I'm on call the week of April 6, and I'd rather not have meetings before 10am.");
  await say(other, OTHER, "Something to remember about me: my dog is called Biscuit.");
  const stored = await memoryMatching(owner, /pepper/i, /april\s*6|6\s*april|apr\s*6/i, /10\s*(am|a\.m\.|:00)/i);
  record("stored-all-three", stored !== null, stored ? "all three facts in memory" : `memory after 3 min: ${(await memory(owner)).slice(0, 200)}`);
  await memoryMatching(other, /biscuit/i);

  // Unrelated work in between: each turn also runs the memory update.
  for (const question of DISTRACTIONS) await say(owner, OWNER, question);

  // Recall after the distractions.
  record("recall-dog", /pepper/i.test(await say(owner, OWNER, "What's my dog's name?")), "names Pepper");
  const oncall = await say(owner, OWNER, "When am I on call?");
  record("recall-oncall", /april\s*6|6\s*april|apr\s*6/i.test(oncall), "gives the week of April 6");
  const meetings = await say(owner, OWNER, "Is 9am a good time to put a meeting in my calendar?");
  await judged("recall-meetings", "Is 9am a good time to put a meeting in my calendar?", "No: they prefer no meetings before 10am.", meetings);

  // A fact changed twice.
  await say(owner, OWNER, "My on-call week has moved to April 13.");
  await memoryMatching(owner, /13/);
  await say(owner, OWNER, DISTRACTIONS[1]!);
  await say(owner, OWNER, "Scratch that: on-call is now the week of April 20.");
  const updated = await memoryMatching(owner, /20/);
  record("stored-second-change", updated !== null, updated ? "latest change in memory" : "not in memory after 3 min");
  const latest = await say(owner, OWNER, "When am I on call?");
  await judged(
    "update-twice",
    "When am I on call?",
    "The week of April 20. It may mention April 6 or April 13 as earlier plans, but must not present either as current.",
    latest,
  );

  // Look-alike facts stay with their owners.
  const otherDog = await say(other, OTHER, "What's my dog's name?");
  record("isolation-other", /biscuit/i.test(otherDog) && !/pepper/i.test(otherDog), "the other employee gets Biscuit, never Pepper");
  const ownerDog = await say(owner, OWNER, "Remind me what my dog is called?");
  record("isolation-owner", /pepper/i.test(ownerDog) && !/biscuit/i.test(ownerDog), "the owner gets Pepper, never Biscuit");

  const memoryCited = transcript.filter((t) => t.sources.some((id) => id === OWNER || id === OTHER || /human\.md|memory/i.test(id)));
  record("separation", memoryCited.length === 0, `${memoryCited.length} answer(s) cited personal memory as a company source`);

  const passed = checks.filter((c) => c.passed).length;
  console.log(`\nMemory (hard): ${passed}/${checks.length} checks passed`);
  const outDir = path.join(__dirname, "../../docs/evaluation");
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `memory-hard-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, `${JSON.stringify({ owner: OWNER, other: OTHER, checks, transcript, finalMemory: await memory(owner) }, null, 2)}\n`);
  console.log(`Report: ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
