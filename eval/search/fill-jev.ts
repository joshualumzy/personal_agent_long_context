/**
 * Collects Jev judgements for every question's 30 BM25 candidates into the
 * shared cache, one request at a time, waiting out the service's load
 * shedding. Run in the background; run.ts --jev-cached reads what is there.
 *
 *   node --env-file=.env --import tsx eval/search/fill-jev.ts [extra-questions.json]
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { Bm25, jevStats, loadCorpus, OUT } from "./lib.js";
import { JudgeCache, loadSets, type Question } from "./run.js";

const index = new Bm25(await loadCorpus());
const cache = await new JudgeCache(path.join(OUT, "judgements.json")).load();
const sets = await loadSets();
const extra = process.argv[2] ? (JSON.parse(await readFile(process.argv[2], "utf8")) as Array<{ question: string; queries?: string[] }>) : [];
const jobs: Array<{ question: string; query: string }> = [
  ...Object.values(sets).flat().map((item: Question) => ({ question: item.question, query: item.question })),
  ...extra.flatMap((item) => (item.queries ?? [item.question]).map((query) => ({ question: item.question, query }))),
];
let done = 0;
for (const job of jobs) {
  const hits = index.search(job.query, 30);
  if (cache.cached("jev", job.question, hits)) { done += 1; continue; }
  await cache.judge("jev", job.question, hits);
  await cache.save();
  done += 1;
  console.log(`${new Date().toISOString().slice(11, 19)} ${done}/${jobs.length} (retries so far ${jevStats.retries})`);
}
console.log("all judged");
