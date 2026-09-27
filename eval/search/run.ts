/**
 * Compares the ways of finding records for a question:
 *
 *   prod       today's search on this machine: every word must match
 *   bm25       BM25 over chunks, any word may match, top 6
 *   bm25+jev   BM25 top 30, Jev judges all 30 in one request, keep >= 0.4,
 *              the >= 0.7 group first, BM25 order within a group, top 6
 *   bm25+llm   the same, with the meeting model as the judge
 *
 * on two sets: meeting questions written from records (eval/search/out/
 * meeting-questions.json) and the OrgForge benchmark questions, whose
 * evidence artifacts are the gold records.
 *
 *   node --env-file=.env --import tsx eval/search/run.ts [--no-llm]
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { loadBenchmarkQuestions } from "../orgforge/dataset.js";
import { Bm25, type Hit, jevJudge, jevStats, loadCorpus, median, modelJudge, modelStats, OUT, p95, pool, productionKeyword } from "./lib.js";

export interface Question {
  id: string;
  question: string;
  language: string;
  gold: string[];
}

const TOP = 6;
const POOL = 30;
export const KEEP = 0.4;
export const SURE = 0.7;

export async function loadSets(): Promise<Record<string, Question[]>> {
  const meeting = JSON.parse(await readFile(path.join(OUT, "meeting-questions.json"), "utf8")) as Question[];
  const orgforge = (await loadBenchmarkQuestions()).map((item) => {
    const truth = item.ground_truth;
    const gold = new Set<string>([
      ...(truth.evidence_artifacts ?? []),
      ...(truth.expected_search_space ?? []),
      ...(truth.evidence_chain_artifacts?.cause ?? []),
      ...(truth.evidence_chain_artifacts?.effect ?? []),
    ]);
    return { id: item.question_id, question: item.question_text, language: "en", gold: [...gold] };
  });
  const vague = JSON.parse(await readFile(path.join(OUT, "vague-questions.json"), "utf8")) as Question[];
  return { meeting, vague, orgforge: orgforge.filter((item) => item.gold.length > 0) };
}

/** Judgements cached by judge, question and candidate, so reruns cost nothing. */
export class JudgeCache {
  private data: Record<string, number> = {};
  constructor(private readonly file: string) {}
  async load() {
    try {
      this.data = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      this.data = {};
    }
    return this;
  }
  /** Merges with what other processes saved meanwhile, then writes atomically. */
  private saving: Promise<void> = Promise.resolve();
  save(): Promise<void> {
    // One save at a time within this process.
    this.saving = this.saving.then(() => this.write());
    return this.saving;
  }
  private async write() {
    try {
      this.data = { ...JSON.parse(await readFile(this.file, "utf8")), ...this.data };
    } catch {
      // First save.
    }
    const temporary = `${this.file}.${process.pid}.${Date.now()}`;
    await writeFile(temporary, JSON.stringify(this.data));
    await rename(temporary, this.file);
  }
  /** Cached judgements only; null when any candidate is missing. */
  cached(kind: "jev" | "llm", question: string, hits: Hit[]): number[] | null {
    const scores = hits.map((hit) => this.data[`${kind}\u0000${question}\u0000${hit.sourceId}`]);
    return scores.every((value) => typeof value === "number") ? (scores as number[]) : null;
  }
  async judge(kind: "jev" | "llm", question: string, hits: Hit[]): Promise<number[]> {
    const key = (hit: Hit) => `${kind}\u0000${question}\u0000${hit.sourceId}`;
    const missing = hits.filter((hit) => !(key(hit) in this.data));
    if (missing.length > 0) {
      const scores = kind === "jev" ? await jevJudge(question, missing) : await modelJudge(question, missing);
      missing.forEach((hit, index) => (this.data[key(hit)] = scores[index]!));
    }
    return hits.map((hit) => this.data[key(hit)]!);
  }
}

/** Keep what the judge accepts; the sure group first; within a group, keep the BM25 order. */
export function arrange(hits: Hit[], scores: number[]): Array<Hit & { judged: number }> {
  const judged = hits.map((hit, index) => ({ ...hit, judged: scores[index]! }));
  const sure = judged.filter((hit) => hit.judged >= SURE);
  const maybe = judged.filter((hit) => hit.judged >= KEEP && hit.judged < SURE);
  return [...sure, ...maybe];
}

export function score(ranked: string[], gold: string[]) {
  const set = new Set(gold);
  const top = ranked.slice(0, TOP);
  const first = top.findIndex((id) => set.has(id));
  return { hit: first >= 0 ? 1 : 0, rr: first >= 0 ? 1 / (first + 1) : 0, empty: top.length === 0 ? 1 : 0 };
}

async function main() {
  const withLlm = !process.argv.includes("--no-llm");
  // --jev-cached: use only Jev judgements already in the cache (the filler
  // script collects them while the service sheds load); others count as missing.
  const jevCachedOnly = process.argv.includes("--jev-cached");
  const corpus = await loadCorpus();
  const started = performance.now();
  const index = new Bm25(corpus);
  console.log(`BM25 index: ${corpus.length} chunks in ${Math.round(performance.now() - started)} ms`);
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const cache = await new JudgeCache(path.join(OUT, "judgements.json")).load();
  const only = process.argv.find((arg) => arg.startsWith("--sets="))?.split("=")[1]?.split(",");
  const sets = Object.fromEntries(Object.entries(await loadSets()).filter(([name]) => !only || only.includes(name)));
  const rows: Array<Record<string, unknown>> = [];
  const bm25Ms: number[] = [];

  for (const [name, questions] of Object.entries(sets)) {
    const results = await pool(questions, 3, async (item) => {
      const prod = await productionKeyword(db, item.question, TOP);
      const t0 = performance.now();
      const candidates = index.search(item.question, POOL);
      bm25Ms.push(performance.now() - t0);
      const jevScores = jevCachedOnly ? cache.cached("jev", item.question, candidates) : await cache.judge("jev", item.question, candidates);
      const llmScores = withLlm ? await cache.judge("llm", item.question, candidates) : null;
      await cache.save();
      return {
        item,
        prod,
        bm25: candidates.slice(0, TOP).map((hit) => hit.sourceId),
        pool: candidates.map((hit) => hit.sourceId),
        jev: jevScores ? arrange(candidates, jevScores).map((hit) => hit.sourceId) : null,
        jevTop: jevScores ? Math.max(0, ...jevScores) : null,
        llm: llmScores ? arrange(candidates, llmScores).map((hit) => hit.sourceId) : null,
        llmTop: llmScores ? Math.max(0, ...llmScores) : null,
      };
    });

    const answerable = results.filter((result) => result.item.gold.length > 0);
    const absent = results.filter((result) => result.item.gold.length === 0);
    const summarize = (subset: typeof results, label: string) => {
      const arms: Record<string, (result: (typeof results)[number]) => string[] | null> = {
        prod: (result) => result.prod,
        bm25: (result) => result.bm25,
        "bm25+jev": (result) => result.jev,
        ...(withLlm ? { "bm25+llm": (result: (typeof results)[number]) => result.llm } : {}),
      };
      const line: Record<string, unknown> = { set: name, subset: label, n: subset.length };
      // Arms are compared on the questions every arm has an answer for.
      const covered = subset.filter((result) => result.jev !== null);
      line.jevCovered = covered.length;
      for (const [arm, pick] of Object.entries(arms)) {
        const scores = (arm === "bm25+jev" ? covered : subset).map((result) => score(pick(result) ?? [], result.item.gold));
        line[`${arm} hit@6`] = pct(scores.map((s) => s.hit));
        line[`${arm} empty`] = pct(scores.map((s) => s.empty));
      }
      line["bm25 hit@30"] = pct(subset.map((result) => (result.pool.some((id) => result.item.gold.includes(id)) ? 1 : 0)));
      rows.push(line);
    };
    summarize(answerable, "answerable");
    for (const language of ["en", "zh"]) {
      const subset = answerable.filter((result) => result.item.language === language);
      if (subset.length && name !== "orgforge") summarize(subset, `answerable ${language}`);
    }
    if (absent.length) {
      // For a question the company has no record of, the right result is nothing.
      rows.push({
        set: name,
        subset: "no record",
        n: absent.length,
        "prod empty": pct(absent.map((result) => (result.prod.length === 0 ? 1 : 0))),
        "bm25 empty": pct(absent.map((result) => (result.bm25.length === 0 ? 1 : 0))),
        "bm25+jev empty": pct(absent.filter((result) => result.jev).map((result) => (result.jev!.length === 0 ? 1 : 0))),
        ...(withLlm ? { "bm25+llm empty": pct(absent.map((result) => (result.llm?.length === 0 ? 1 : 0))) } : {}),
      });
    }
    await writeFile(path.join(OUT, `results-${name}.json`), JSON.stringify(results, null, 1));
  }
  await db.end();

  for (const row of rows) console.log(JSON.stringify(row));
  console.log(`BM25 search: median ${median(bm25Ms).toFixed(1)} ms, p95 ${p95(bm25Ms).toFixed(1)} ms`);
  console.log(`Jev: ${jevStats.calls} calls, ${jevStats.retries} retries, median ${median(jevStats.ms)} ms, p95 ${p95(jevStats.ms)} ms, ${jevStats.inputTokens} input tokens, $${jevStats.cost.toFixed(4)}`);
  console.log(`LLM judge: ${modelStats.calls} calls, median ${median(modelStats.ms)} ms, p95 ${p95(modelStats.ms)} ms`);
}

const pct = (values: number[]) => `${Math.round((100 * values.reduce((a, b) => a + b, 0)) / Math.max(values.length, 1))}%`;

if (import.meta.url === `file://${process.argv[1]}`) await main();
