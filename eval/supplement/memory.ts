/**
 * Personal memory (Letta) through the running app: does the assistant keep
 * what an employee tells it, replace it when they correct it, keep it to that
 * employee, and keep it apart from Company Evidence?
 *
 *   npm start   # app on :3000, with Letta on :4500 (npm run letta:server)
 *   node --env-file=.env --import tsx eval/supplement/memory.ts
 *
 * Every question is asked in a fresh conversation (no conversationId), so a
 * recalled fact can only have come from memory, not from the chat history.
 * The facts below are invented and absent from the company records; they are
 * fixed here, before any run, like cases.json. Uses non-demo accounts so the
 * demo personas' memory is left alone.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeAgainstReference, judgeOptionsFromEnvironment } from "../orgforge/judge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.APP_URL ?? "http://127.0.0.1:3000";
const OWNER = "mona";
const OTHER = "yusuf";
const MEMORY_WAIT_MS = 180_000;

interface Check {
  id: string;
  kind: "stored" | "recall" | "update" | "isolation" | "separation";
  passed: boolean;
  detail: string;
}

interface ChatReply {
  answer: string;
  sources: Array<{ sourceId: string }>;
  personalMemory?: { status: string };
}

async function login(employeeId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ employeeId, password: process.env.MEMORY_EVAL_PASSWORD ?? "password" }),
  });
  if (!res.ok) throw new Error(`login ${employeeId}: ${res.status}`);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

async function chat(cookie: string, message: string): Promise<ChatReply> {
  const res = await fetch(`${BASE}/api/v1/agent/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`chat: ${res.status} ${await res.text()}`);
  return (await res.json()) as ChatReply;
}

async function memory(cookie: string): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/me/memory`, { headers: { cookie } });
  return ((await res.json()) as { workingContext?: string }).workingContext ?? "";
}

/** Waits for the background memory update to write something matching `pattern`. */
async function memoryMatching(cookie: string, pattern: RegExp): Promise<string | null> {
  const deadline = Date.now() + MEMORY_WAIT_MS;
  while (Date.now() < deadline) {
    const text = await memory(cookie);
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return null;
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
    console.log(`  ${who}: ${message}\n    → ${reply.answer.replace(/\s+/g, " ").slice(0, 160)}`);
    return reply;
  };
  const record = (check: Check) => {
    checks.push(check);
    console.log(`${check.passed ? "✅" : "❌"} ${check.id}: ${check.detail}`);
  };

  // 1. Tell it two personal facts.
  await say(owner, OWNER, "For future chats: I leave early at 4:30pm on Thursdays for physio appointments. Also, my side project at the moment is the Juniper migration checklist.");
  const stored = await memoryMatching(owner, /juniper/i);
  record({ id: "stored-side-project", kind: "stored", passed: stored !== null, detail: stored ? "written to memory" : "not in memory after 3 min" });
  const storedThursday = /4[:.]?30/.test(stored ?? (await memory(owner)));
  record({ id: "stored-thursday", kind: "stored", passed: storedThursday, detail: storedThursday ? "written to memory" : "not in memory" });

  // 2. Recall in fresh conversations.
  const thursday = await say(owner, OWNER, "What time do I leave on Thursdays?");
  record({ id: "recall-thursday", kind: "recall", passed: /4[:.]?30/.test(thursday.answer), detail: "answer gives 4:30" });
  const project = await say(owner, OWNER, "What's my side project at the moment?");
  record({ id: "recall-side-project", kind: "recall", passed: /juniper/i.test(project.answer), detail: "answer names Juniper" });

  // 3. Correct both facts; the new ones must replace the old.
  await say(owner, OWNER, "Update: physio has finished, so I no longer leave early on Thursdays. And I've dropped the Juniper checklist; my side project is now the Larkspur dashboard.");
  const updated = await memoryMatching(owner, /larkspur/i);
  record({ id: "stored-update", kind: "stored", passed: updated !== null, detail: updated ? "correction written to memory" : "not in memory after 3 min" });

  const newProject = await say(owner, OWNER, "What's my side project at the moment?");
  const projectVerdict = await judgeAgainstReference(
    judge,
    "What's my side project at the moment?",
    "The side project is now the Larkspur dashboard. It may mention Juniper as a past project, but must not present Juniper as current.",
    newProject.answer,
  );
  record({ id: "update-side-project", kind: "update", passed: projectVerdict === "agrees", detail: `judge: ${projectVerdict}` });
  const newThursday = await say(owner, OWNER, "Do I still leave early on Thursdays?");
  const thursdayVerdict = await judgeAgainstReference(
    judge,
    "Do I still leave early on Thursdays?",
    "No: physio has finished, so they no longer leave early on Thursdays.",
    newThursday.answer,
  );
  record({ id: "update-thursday", kind: "update", passed: thursdayVerdict === "agrees", detail: `judge: ${thursdayVerdict}` });

  // 4. Another employee must not see any of it.
  const otherProject = await say(other, OTHER, "What's my side project at the moment?");
  const otherMemory = await memory(other);
  const leaked = /juniper|larkspur|physio/i.test(`${otherProject.answer}\n${otherMemory}`);
  record({ id: "isolation", kind: "isolation", passed: !leaked, detail: leaked ? "the other employee saw the owner's facts" : "nothing leaked" });

  // 5. Memory is context, never Company Evidence: no answer cites it as a source.
  const memoryCited = transcript.filter((t) => t.sources.some((id) => id === OWNER || id === OTHER || /human\.md|memory/i.test(id)));
  record({ id: "separation", kind: "separation", passed: memoryCited.length === 0, detail: `${memoryCited.length} answer(s) cited personal memory as a company source` });

  const passed = checks.filter((c) => c.passed).length;
  console.log(`\nMemory: ${passed}/${checks.length} checks passed`);
  const outDir = path.join(__dirname, "../../docs/evaluation");
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `memory-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, `${JSON.stringify({ owner: OWNER, other: OTHER, checks, transcript, finalMemory: await memory(owner) }, null, 2)}\n`);
  console.log(`Report: ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
