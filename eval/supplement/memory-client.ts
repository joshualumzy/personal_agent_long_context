/** The running app's chat and memory endpoints, as the memory evals use them. */

export const BASE = process.env.APP_URL ?? "http://127.0.0.1:3000";
const MEMORY_WAIT_MS = 180_000;

export interface ChatReply {
  answer: string;
  sources: Array<{ sourceId: string }>;
  personalMemory?: { status: string };
}

export async function login(employeeId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ employeeId, password: process.env.MEMORY_EVAL_PASSWORD ?? "password" }),
  });
  if (!res.ok) throw new Error(`login ${employeeId}: ${res.status}`);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

/** One turn in a fresh conversation: no conversationId, so no chat history. */
export async function chat(cookie: string, message: string): Promise<ChatReply> {
  const res = await fetch(`${BASE}/api/v1/agent/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`chat: ${res.status} ${await res.text()}`);
  return (await res.json()) as ChatReply;
}

export async function memory(cookie: string): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/me/memory`, { headers: { cookie } });
  return ((await res.json()) as { workingContext?: string }).workingContext ?? "";
}

/** Waits for the background memory update to write something matching every pattern. */
export async function memoryMatching(cookie: string, ...patterns: RegExp[]): Promise<string | null> {
  const deadline = Date.now() + MEMORY_WAIT_MS;
  while (Date.now() < deadline) {
    const text = await memory(cookie);
    if (patterns.every((p) => p.test(text))) return text;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return null;
}
