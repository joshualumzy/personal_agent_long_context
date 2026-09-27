/**
 * Builds the meeting-question set: for a random sample of records, the model
 * writes the question a colleague would say out loud in a meeting that the
 * record answers, in their own words (no record ID, no copied title). A
 * quarter are asked in Chinese, as they are in this team's meetings. Also
 * writes questions about things this company has no record of, which search
 * should answer with nothing.
 *
 *   node --env-file=.env --import tsx eval/search/make-questions.ts
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chat, loadCorpus, OUT, pool } from "./lib.js";

const PER_TYPE: Record<string, number> = { slack: 40, email: 25, confluence: 25, jira: 25, zoom_transcript: 15, pr: 10 };

// Deterministic shuffle, so the set can be rebuilt.
let seed = 20260927;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const corpus = await loadCorpus();
const docs = new Map<string, { sourceId: string; sourceType: string; title: string; date: string | null; body: string }>();
for (const chunk of corpus) {
  const doc = docs.get(chunk.sourceId);
  if (doc) doc.body += `\n${chunk.content}`;
  else docs.set(chunk.sourceId, { sourceId: chunk.sourceId, sourceType: chunk.sourceType, title: chunk.title, date: chunk.date, body: chunk.content });
}

const sample: Array<typeof docs extends Map<string, infer V> ? V : never> = [];
for (const [type, count] of Object.entries(PER_TYPE)) {
  const candidates = [...docs.values()].filter((doc) => doc.sourceType === type && doc.body.length > 300);
  candidates.sort(() => random() - 0.5);
  sample.push(...candidates.slice(0, count));
}

const questions = await pool(sample, 3, async (doc, index) => {
  const chinese = index % 4 === 3;
  const text = await chat(
    [
      {
        role: "system",
        content: [
          "You are in a team meeting at this company. Write ONE question a colleague would say out loud whose answer is in the record below.",
          "Say it the way someone who has not just read the record would: in your own everyday words, one or two specific details (a person, system, customer or event) so it points at this record, but do not copy the title, do not quote distinctive phrases, and never say the record's ID.",
          chinese ? "Ask it in Chinese (Mandarin), as a Chinese-speaking colleague would; keep product and system names as they are." : "Ask it in English.",
          'Reply as JSON {"question": "..."}.',
        ].join("\n"),
      },
      { role: "user", content: JSON.stringify({ type: doc.sourceType, date: doc.date, title: doc.title, body: doc.body.slice(0, 3000) }) },
    ],
    { json: true, maxTokens: 200 },
  );
  const question = (JSON.parse(text) as { question?: string }).question?.trim() ?? "";
  return { id: `m${String(index).padStart(3, "0")}`, question, language: chinese ? "zh" : "en", gold: [doc.sourceId], sourceType: doc.sourceType };
});

// The company's own names, so the "no record" questions stay clear of them.
const names = new Map<string, number>();
for (const chunk of corpus) for (const name of chunk.content.match(/\b[A-Z][a-z]+(?: [A-Z][a-z]+)?\b/g) ?? []) names.set(name, (names.get(name) ?? 0) + 1);
const common = [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 150).map(([name]) => name);
const absentText = await chat(
  [
    {
      role: "system",
      content: [
        "This company builds sports and athlete-performance analytics software. Names that DO appear in its records are listed below.",
        "Write 24 questions a colleague might ask in a meeting about specific things this company has NO record of: invented projects, vendors, offices, customers, incidents or policies with made-up proper names that are not in the list, on topics a software company could plausibly discuss (office moves, a payroll vendor, a data-center migration, a trade show booth, ...).",
        "Make them sound as real and specific as the real ones. 6 of them in Chinese. Reply as JSON {\"questions\": [\"...\"]}.",
      ].join("\n"),
    },
    { role: "user", content: common.join(", ") },
  ],
  { json: true, maxTokens: 1500 },
);
const absent = ((JSON.parse(absentText) as { questions?: string[] }).questions ?? []).map((question, index) => ({
  id: `n${String(index).padStart(3, "0")}`,
  question,
  language: /[一-鿿]/.test(question) ? "zh" : "en",
  gold: [] as string[],
  sourceType: "none",
}));

const all = [...questions.filter((item) => item.question), ...absent];
await writeFile(path.join(OUT, "meeting-questions.json"), JSON.stringify(all, null, 2));
console.log(`${questions.length} answerable, ${absent.length} with no record`);
for (const item of all.filter((_, index) => index % 12 === 0)) console.log(item.id, item.language, item.gold[0] ?? "-", "|", item.question);
