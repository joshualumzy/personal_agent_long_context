/**
 * Asks Jev and the meeting model (qwen) to classify every sampled OrgForge
 * line, with the three lines before it as context, and scores both against
 * the hand labels in labels.txt. Results go to results.json.
 *
 *   node --env-file=.env --import tsx eval/meetings/orgforge/run.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import { OpenAiCompatibleModel } from "../../../src/recruiting/llm.js";

const KINDS: Record<string, string> = {
  none: "not a commitment: discussion, an idea being floated, a report of work already done, small talk, or a question asking colleagues for their opinion",
  task: "someone takes on, or is given, a piece of their own work (build, test, update, review, draft a design) that needs nothing sent on their behalf",
  answer_question: "a direct question about a fact recorded in company systems (a past ticket, incident, version, customer, or decision) that someone asks now",
  email_draft: "someone promises to send an email or a written follow-up or summary to people",
  message_draft: "someone promises a quick chat message (WhatsApp, Teams) carrying a specific date, number or decision to someone not in the meeting",
  calendar_draft: "someone commits to setting up or sending an invite for a meeting",
  ticket_draft: "someone commits to opening a ticket or task for work to be done",
  doc_draft: "someone promises to write up a new internal document such as notes, a spec or a checklist",
  sheet_draft: "someone promises to put together a new table or spreadsheet",
  hiring_request: "someone says the company needs to hire a new person",
  escalation: "someone offers or commits money: a discount, refund, credit, payment, price change, or signing a contract",
};
const CODE: Record<string, string> = { N: "none", T: "task", Q: "answer_question", E: "email_draft", M: "message_draft", C: "calendar_draft", K: "ticket_draft", D: "doc_draft", S: "sheet_draft", H: "hiring_request", X: "escalation" };
const INSTRUCTIONS = "What is the last line of the meeting (the line field), given the lines before it?";

const meetings = JSON.parse(await readFile(new URL("./lines.json", import.meta.url), "utf8")) as Array<{ title: string; lines: Array<{ speaker: string; text: string }> }>;
const labels = new Map(
  (await readFile(new URL("./labels.txt", import.meta.url), "utf8"))
    .split("\n").filter((l) => l && !l.startsWith("#"))
    .map((l) => { const [key, ...codes] = l.split(" "); return [key!, codes.map((c) => CODE[c]!)] as const; }),
);

const items = meetings.flatMap((m, mi) => m.lines.map((line, li) => ({
  key: `${mi}.${li}`,
  accepted: labels.get(`${mi}.${li}`)!,
  state: {
    meeting: m.title,
    before: m.lines.slice(Math.max(0, li - 3), li).map((l) => `${l.speaker}: ${l.text}`),
    line: `${line.speaker}: ${line.text}`,
  },
})));

const stats = { jev503: 0, qwenRetries: 0 };

async function jev(state: unknown) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch("https://ai-gateway.vercel.sh/v1/evaluate", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "typesafe-ai/jev", state, questions: { kind: { type: "choice", instructions: INSTRUCTIONS, criteria: KINDS } } }),
    });
    if (response.status === 503 || response.status === 429) { stats.jev503 += 1; continue; }
    const data = (await response.json()) as { answers?: { kind: { choice: string; probabilities: Record<string, number> } } };
    if (!data.answers) throw new Error(`Jev HTTP ${response.status}`);
    const { choice, probabilities } = data.answers.kind;
    return { choice, p: probabilities[choice] ?? 0 };
  }
  throw new Error("Jev unavailable");
}

const model = new OpenAiCompatibleModel({ baseUrl: process.env.SOCLAAS_BASE_URL!, apiKey: process.env.SOCLAAS_API_KEY!, model: process.env.MEETINGS_MODEL ?? "qwen3.8:27b", timeoutMs: 90_000 });
async function qwen(state: unknown) {
  for (let attempt = 0; ; attempt++) {
    try {
      const reply = await model.json<{ kind?: string }>({
        task: "judgement", fast: true,
        system: 'Answer the question about the state with exactly one of its option keys.\nReply as {"kind": string}.',
        input: { state, question: INSTRUCTIONS, options: KINDS },
      });
      return { choice: String(reply?.kind ?? ""), p: 1 };
    } catch (error) {
      if (attempt >= 3) throw error;
      stats.qwenRetries += 1;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

async function timed(run: () => Promise<{ choice: string; p: number }>) {
  const started = performance.now();
  try { return { ...(await run()), ms: Math.round(performance.now() - started) }; }
  catch (error) { return { choice: "ERROR", p: 0, ms: Math.round(performance.now() - started), error: String(error).slice(0, 100) }; }
}

/** Runs `work` over items with at most `limit` in flight. */
async function pool<T, R>(list: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (next < list.length) { const i = next++; out[i] = await work(list[i]!); } }));
  return out;
}

const started = Date.now();
const [jevAnswers, qwenAnswers] = await Promise.all([
  pool(items, 4, (item) => timed(() => jev(item.state))),
  pool(items, 4, (item) => timed(() => qwen(item.state))),
]);
const rows = items.map((item, i) => ({ key: item.key, line: item.state.line, accepted: item.accepted, jev: jevAnswers[i]!, qwen: qwenAnswers[i]! }));
await writeFile(new URL("./results.json", import.meta.url), JSON.stringify({ stats, rows }, null, 1));
console.log(`done in ${Math.round((Date.now() - started) / 1000)}s`, stats);
