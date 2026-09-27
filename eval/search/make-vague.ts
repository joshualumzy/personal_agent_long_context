/**
 * The same records as meeting-questions.json, asked the way people actually
 * ask in meetings: from vague memory, at most one name, systems and events
 * described in plain words rather than by their names. Same gold records.
 *
 *   node --env-file=.env --import tsx eval/search/make-vague.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chat, loadCorpus, OUT, pool } from "./lib.js";
import type { Question } from "./run.js";

const base = JSON.parse(await readFile(path.join(OUT, "meeting-questions.json"), "utf8")) as Question[];
const corpus = await loadCorpus();
const bodies = new Map<string, string>();
for (const chunk of corpus) bodies.set(chunk.sourceId, `${bodies.get(chunk.sourceId) ?? `${chunk.title}\n`}${chunk.content}\n`);

const vague = await pool(base, 3, async (item) => {
  if (item.gold.length === 0) return { ...item, id: `v${item.id}` };
  const text = await chat(
    [
      {
        role: "system",
        content: [
          "You are in a team meeting and vaguely remember something from the record below. Ask ONE question about it out loud, the way people really talk in meetings.",
          "Rules: at most ONE proper name (a person OR a customer OR a product), never a record ID; describe systems, incidents, documents and events in plain everyday words instead of their names or jargon; do not reuse the record's wording.",
          item.language === "zh" ? "Ask it in Chinese (Mandarin) only; no English words except at most one name." : "Ask it in English.",
          'Reply as JSON {"question": "..."}.',
        ].join("\n"),
      },
      { role: "user", content: (bodies.get(item.gold[0]!) ?? "").slice(0, 3000) },
    ],
    { json: true, maxTokens: 200 },
  );
  return { ...item, id: `v${item.id}`, question: (JSON.parse(text) as { question?: string }).question?.trim() ?? "" };
});
await writeFile(path.join(OUT, "vague-questions.json"), JSON.stringify(vague.filter((item) => item.question), null, 2));
for (const item of vague.filter((_, i) => i % 10 === 0)) console.log(item.id, item.language, "|", item.question);
