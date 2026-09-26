/** Re-asks Jev, one line at a time, for rows that ended in ERROR in results.json. */
import { readFile, writeFile } from "node:fs/promises";
const file = new URL("./results.json", import.meta.url);
const data = JSON.parse(await readFile(file, "utf8"));
const src = await readFile(new URL("./run.ts", import.meta.url), "utf8");
const KINDS = eval(`(${src.match(/const KINDS[^=]*= (\{[\s\S]*?\n\});/)![1]})`);
const meetings = JSON.parse(await readFile(new URL("./lines.json", import.meta.url), "utf8"));
let tries = 0, fixed = 0;
for (const row of data.rows) {
  if (row.jev.choice !== "ERROR") continue;
  const [mi, li] = row.key.split(".").map(Number);
  const m = meetings[mi];
  const state = { meeting: m.title, before: m.lines.slice(Math.max(0, li - 3), li).map((l: any) => `${l.speaker}: ${l.text}`), line: row.line };
  const started = performance.now();
  for (let attempt = 0; attempt < 30; attempt++) {
    tries += 1;
    const r = await fetch("https://ai-gateway.vercel.sh/v1/evaluate", { method: "POST", headers: { authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "typesafe-ai/jev", state, questions: { kind: { type: "choice", instructions: "What is the last line of the meeting (the line field), given the lines before it?", criteria: KINDS } } }) });
    if (r.status === 503 || r.status === 429) continue;
    const d = await r.json();
    if (!d.answers) break;
    const { choice, probabilities } = d.answers.kind;
    row.jev = { choice, p: probabilities[choice] ?? 0, ms: Math.round(performance.now() - started), attempts: attempt + 1 };
    fixed += 1;
    break;
  }
}
data.stats.rerun = { tries, fixed };
await writeFile(file, JSON.stringify(data, null, 1));
console.log({ tries, fixed });
