/**
 * Search that learns the company's vocabulary from its own misses.
 *
 * For each question, in the order meetings would ask them:
 *   1. First pass: BM25 top 30 on the question, plus the words any learned
 *      lesson adds; the judge scores all 30.
 *   2. If nothing is judged a sure match, the meeting model rewrites the
 *      question into keyword queries in the records' own words, having seen
 *      the titles the judge turned down; the judge scores the new pool.
 *   3. When a rewrite finds a sure match, the model states the vocabulary
 *      that made the difference as a lesson ("when a question says X, the
 *      records say Y"). The lesson is kept only if it passes a check: the
 *      original question, expanded by the lesson alone, now finds a sure
 *      match on the first pass. Lessons carry use and success counts and are
 *      dropped when they keep firing without helping.
 *
 * The judge (Jev or the meeting model) is the only signal during learning.
 * The gold records are used only to score, on questions the loop never
 * learned from: the train questions teach, the test questions measure.
 *
 *   node --env-file=.env --import tsx eval/search/rsi.ts [--judge=llm|jev]
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Bm25, chat, type Hit, loadCorpus, OUT, pool } from "./lib.js";
import { arrange, JudgeCache, loadSets, type Question, SURE } from "./run.js";

interface Lesson {
  id: number;
  when: string[];
  add: string[];
  from: string;
  uses: number;
  helped: number;
}

const judgeKind = (process.argv.find((arg) => arg.startsWith("--judge="))?.split("=")[1] ?? "llm") as "llm" | "jev";
const index = new Bm25(await loadCorpus());
const cache = await new JudgeCache(path.join(OUT, "judgements.json")).load();
const judge = async (question: string, hits: Hit[]) => {
  const scores = await cache.judge(judgeKind, question, hits);
  await cache.save();
  return scores;
};

const cjk = /[一-鿿]/;
/** A lesson fires when every one of its trigger phrases is in the question. */
function fires(lesson: Lesson, question: string): boolean {
  const lower = question.toLowerCase();
  return lesson.when.every((phrase) => {
    const p = phrase.toLowerCase().trim();
    if (!p) return false;
    if (cjk.test(p)) return lower.includes(p);
    return new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(lower);
  });
}

function expand(question: string, lessons: Lesson[]): { query: string; fired: Lesson[] } {
  const fired = lessons.filter((lesson) => fires(lesson, question));
  const words = [...new Set(fired.flatMap((lesson) => lesson.add))];
  return { query: words.length ? `${question} ${words.join(" ")}` : question, fired };
}

async function firstPass(question: string, lessons: Lesson[]) {
  const { query, fired } = expand(question, lessons);
  const hits = index.search(query, 30);
  const ranked = arrange(hits, await judge(question, hits));
  return { ranked, fired, sure: ranked.some((hit) => hit.judged >= SURE) };
}

async function rewrite(question: string, rejected: Hit[]): Promise<string[]> {
  const text = await chat(
    [
      {
        role: "system",
        content: [
          "A keyword search over a company's records (Slack, email, Jira, Confluence, meeting transcripts; all in English) found nothing that answers a colleague's question. The titles it found and rejected are listed.",
          "Write up to 3 short English keyword queries (3 to 6 words each) that use the words the records themselves would use for this: the system, incident, document or event names, the people's names, and the terms the company uses, not the colleague's phrasing.",
          'Reply as JSON {"queries": ["...", "..."]}.',
        ].join("\n"),
      },
      { role: "user", content: JSON.stringify({ question, rejected: rejected.slice(0, 10).map((hit) => hit.chunk.title.slice(0, 120)) }) },
    ],
    { json: true, maxTokens: 200 },
  );
  try {
    return ((JSON.parse(text) as { queries?: string[] }).queries ?? []).filter((query) => typeof query === "string" && query.trim()).slice(0, 3);
  } catch {
    return [];
  }
}

async function secondPass(question: string, queries: string[]) {
  const merged = new Map<string, Hit>();
  for (const query of queries) for (const hit of index.search(query, 12)) if (!merged.has(hit.sourceId)) merged.set(hit.sourceId, hit);
  const hits = [...merged.values()].slice(0, 30);
  const ranked = arrange(hits, await judge(question, hits));
  return { ranked, sure: ranked.some((hit) => hit.judged >= SURE) };
}

async function distill(question: string, queries: string[], found: Hit[]): Promise<Array<{ when: string[]; add: string[] }>> {
  const text = await chat(
    [
      {
        role: "system",
        content: [
          "A search for a colleague's question failed on their wording and succeeded after rewriting it into the records' own words. State the vocabulary that made the difference as reusable lessons for FUTURE, DIFFERENT questions.",
          'Each lesson: "when" is 1 or 2 short words or phrases exactly as they appear in the question (Chinese stays Chinese) that signal the topic; "add" is 1 to 4 English words the records use for it.',
          "Only general vocabulary a future question could share: a synonym, a translation, the company's name for a system or kind of document. Never a person's name, a record ID, a date or a detail only this question has. If nothing general made the difference, return no lessons.",
          'Reply as JSON {"lessons": [{"when": ["..."], "add": ["..."]}]}, at most 2 lessons.',
        ].join("\n"),
      },
      { role: "user", content: JSON.stringify({ question, rewrittenQueries: queries, foundTitles: found.slice(0, 3).map((hit) => hit.chunk.title.slice(0, 120)) }) },
    ],
    { json: true, maxTokens: 250 },
  );
  try {
    return ((JSON.parse(text) as { lessons?: Array<{ when?: string[]; add?: string[] }> }).lessons ?? [])
      .filter((lesson) => lesson.when?.length && lesson.add?.length)
      .map((lesson) => ({ when: lesson.when!.slice(0, 2), add: lesson.add!.slice(0, 4) }))
      .slice(0, 2);
  } catch {
    return [];
  }
}

// Deterministic split: the loop learns on train and is measured on test.
const sets = await loadSets();
let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const meeting = [...sets.vague!].sort(() => random() - 0.5);
const train = meeting.slice(0, Math.floor(meeting.length / 2));
const test = meeting.slice(Math.floor(meeting.length / 2));

const lessons: Lesson[] = [];
const log: Array<Record<string, unknown>> = [];
let nextId = 1;
let rewrites = 0;
let verifiedLessons = 0;
let rejectedLessons = 0;

// Learning: one question at a time, as meetings happen.
for (const [position, item] of train.entries()) {
  const first = await firstPass(item.question, lessons);
  for (const lesson of first.fired) {
    lesson.uses += 1;
    if (first.sure) lesson.helped += 1;
  }
  // Lessons that keep firing without leading to a sure match are dropped.
  for (let i = lessons.length - 1; i >= 0; i -= 1) {
    const lesson = lessons[i]!;
    if (lesson.uses >= 3 && lesson.helped / lesson.uses < 0.34) lessons.splice(i, 1);
  }
  const entry: Record<string, unknown> = { position, id: item.id, question: item.question, firstSure: first.sure, fired: first.fired.map((lesson) => lesson.id) };
  if (!first.sure) {
    rewrites += 1;
    const queries = await rewrite(item.question, first.ranked.length ? first.ranked : index.search(item.question, 10));
    const second = await secondPass(item.question, queries);
    entry.queries = queries;
    entry.secondSure = second.sure;
    if (second.sure) {
      const proposed = await distill(item.question, queries, second.ranked);
      entry.proposed = proposed;
      for (const candidate of proposed) {
        const lesson: Lesson = { id: nextId++, ...candidate, from: item.id, uses: 0, helped: 0 };
        // The check: does the lesson alone turn this question's first pass into a sure match?
        const check = await firstPass(item.question, [lesson]);
        if (check.fired.length && check.sure) {
          lessons.push(lesson);
          verifiedLessons += 1;
        } else rejectedLessons += 1;
      }
    }
  }
  log.push(entry);
  console.log(`train ${position + 1}/${train.length} ${item.id} first=${first.sure ? "sure" : "-"} ${entry.secondSure === undefined ? "" : `rewrite=${entry.secondSure ? "sure" : "-"}`} lessons=${lessons.length}`);
}

// Measurement on questions the loop never saw, against the gold records.
type Mode = "plain" | "lessons" | "plain+rewrite" | "lessons+rewrite";
async function answer(item: Question, withLessons: boolean, withRewrite: boolean) {
  const first = await firstPass(item.question, withLessons ? lessons : []);
  if (first.sure || !withRewrite) return { ids: first.ranked.map((hit) => hit.sourceId), rewrote: false };
  const queries = await rewrite(item.question, first.ranked.length ? first.ranked : index.search(item.question, 10));
  const second = await secondPass(item.question, queries);
  const ids = second.ranked.length ? second.ranked.map((hit) => hit.sourceId) : first.ranked.map((hit) => hit.sourceId);
  return { ids, rewrote: true };
}

const evaluate = async (name: string, questions: Question[]) => {
  const modes: Array<[Mode, boolean, boolean]> = [
    ["plain", false, false],
    ["lessons", true, false],
    ["plain+rewrite", false, true],
    ["lessons+rewrite", true, true],
  ];
  const rows: Array<Record<string, unknown>> = [];
  for (const [mode, withLessons, withRewrite] of modes) {
    const results = await pool(questions, 3, (item) => answer(item, withLessons, withRewrite));
    const answerable = questions.map((item, i) => ({ item, result: results[i]! })).filter(({ item }) => item.gold.length > 0);
    const absent = questions.map((item, i) => ({ item, result: results[i]! })).filter(({ item }) => item.gold.length === 0);
    const hit = (list: typeof answerable) => list.filter(({ item, result }) => result.ids.slice(0, 6).some((id) => item.gold.includes(id))).length;
    const zh = answerable.filter(({ item }) => item.language === "zh");
    rows.push({
      set: name,
      mode,
      "hit@6": `${hit(answerable)}/${answerable.length}`,
      "hit@6 zh": `${hit(zh)}/${zh.length}`,
      "no-record kept empty": absent.length ? `${absent.filter(({ result }) => result.ids.length === 0).length}/${absent.length}` : "-",
      "needed a rewrite": `${results.filter((result) => result.rewrote).length}/${results.length}`,
    });
  }
  return rows;
};

const rows = [...(await evaluate("vague meeting test (unseen)", test)), ...(await evaluate("orgforge (unseen)", sets.orgforge!))];
await writeFile(path.join(OUT, `rsi-${judgeKind}.json`), JSON.stringify({ lessons, log, rows, rewrites, verifiedLessons, rejectedLessons }, null, 1));
console.log(`\nlearning: ${train.length} questions, ${rewrites} rewrites, ${verifiedLessons} lessons verified, ${rejectedLessons} rejected, ${lessons.length} kept after pruning`);
for (const lesson of lessons) console.log(`  #${lesson.id} when ${JSON.stringify(lesson.when)} add ${JSON.stringify(lesson.add)} (from ${lesson.from}, ${lesson.helped}/${lesson.uses})`);
for (const row of rows) console.log(JSON.stringify(row));
