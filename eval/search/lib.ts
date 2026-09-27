/**
 * Shared pieces of the search experiments: the corpus, a BM25 index over its
 * chunks, the production keyword search for comparison, and the two judges
 * (Jev and the meeting model) that decide whether a record helps a question.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.join(HERE, "out");

export interface Chunk {
  sourceId: string;
  sourceType: string;
  title: string;
  date: string | null;
  content: string;
}

/** All chunks with their document's title, cached on disk after the first read. */
export async function loadCorpus(): Promise<Chunk[]> {
  const cache = path.join(OUT, "corpus.json");
  try {
    return JSON.parse(await readFile(cache, "utf8")) as Chunk[];
  } catch {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const { rows } = await pool.query<{ source_id: string; source_type: string; title: string | null; occurred_at: Date | null; content: string }>(
      `SELECT c.source_id, d.source_type, d.title, d.occurred_at, c.content
       FROM document_chunks c JOIN source_documents d USING (source_id) ORDER BY c.source_id, c.chunk_index`,
    );
    await pool.end();
    const chunks = rows.map((row) => ({
      sourceId: row.source_id,
      sourceType: row.source_type,
      title: row.title ?? row.source_id,
      date: row.occurred_at ? row.occurred_at.toISOString().slice(0, 10) : null,
      content: row.content,
    }));
    await mkdir(OUT, { recursive: true });
    await writeFile(cache, JSON.stringify(chunks));
    return chunks;
  }
}

const STOP = new Set(
  "a an and are as at be been but by can could did do does for from had has have how i if in into is it its of on or our so that the their them then there these they this to was we were what when where which who whom why will with would you your did not no any about after before than also just still yet".split(" "),
);

/** A light stemmer: enough that "incidents" meets "incident" and "delayed" meets "delay". */
function stem(word: string): string {
  if (word.length <= 4 || /\d/.test(word)) return word;
  for (const suffix of ["ations", "ation", "ings", "ing", "edly", "ed", "ies", "es", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return suffix === "ies" ? `${word.slice(0, -3)}y` : word.slice(0, -suffix.length);
    }
  }
  return word;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []) {
    // A record ID like eng-123 is kept whole and also split, so "ENG-123" and "123" both match.
    if (raw.includes("-")) {
      out.push(raw);
      for (const part of raw.split("-")) if (part && !STOP.has(part)) out.push(stem(part));
    } else if (!STOP.has(raw)) out.push(stem(raw));
  }
  return out;
}

export interface Hit {
  sourceId: string;
  score: number;
  chunk: Chunk;
}

/** Okapi BM25 over chunks; a document scores as its best chunk. Any term may match. */
export class Bm25 {
  private readonly docs: Array<{ chunk: Chunk; tf: Map<string, number>; length: number }>;
  private readonly df = new Map<string, number>();
  private readonly postings = new Map<string, number[]>();
  private readonly avgLength: number;

  constructor(chunks: Chunk[], private readonly k1 = 1.2, private readonly b = 0.75) {
    this.docs = chunks.map((chunk, index) => {
      const tokens = tokenize(`${chunk.title} ${chunk.content}`);
      const tf = new Map<string, number>();
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
      for (const term of tf.keys()) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
        let list = this.postings.get(term);
        if (!list) this.postings.set(term, (list = []));
        list.push(index);
      }
      return { chunk, tf, length: tokens.length };
    });
    this.avgLength = this.docs.reduce((sum, doc) => sum + doc.length, 0) / this.docs.length;
  }

  search(query: string, limit: number): Hit[] {
    const terms = [...new Set(tokenize(query))];
    const scores = new Map<number, number>();
    for (const term of terms) {
      const list = this.postings.get(term);
      if (!list) continue;
      const n = this.docs.length;
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const index of list) {
        const doc = this.docs[index]!;
        const tf = doc.tf.get(term)!;
        const score = (idf * tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + (this.b * doc.length) / this.avgLength));
        scores.set(index, (scores.get(index) ?? 0) + score);
      }
    }
    const best = new Map<string, Hit>();
    for (const [index, score] of scores) {
      const chunk = this.docs[index]!.chunk;
      const current = best.get(chunk.sourceId);
      if (!current || score > current.score) best.set(chunk.sourceId, { sourceId: chunk.sourceId, score, chunk });
    }
    return [...best.values()].sort((left, right) => right.score - left.score).slice(0, limit);
  }
}

/** The search production runs today when embeddings are unavailable: every term must match. */
export async function productionKeyword(pool: pg.Pool, query: string, limit: number): Promise<string[]> {
  const { rows } = await pool.query<{ source_id: string }>(
    `WITH requested AS (SELECT websearch_to_tsquery('english', $1) AS query),
     ranked AS (
       SELECT c.source_id, ts_rank_cd(c.search_vector, requested.query) AS score,
              row_number() OVER (PARTITION BY c.source_id ORDER BY ts_rank_cd(c.search_vector, requested.query) DESC) AS source_rank
       FROM document_chunks c, requested WHERE c.search_vector @@ requested.query)
     SELECT source_id FROM ranked WHERE source_rank = 1 ORDER BY score DESC LIMIT $2`,
    [query, limit],
  );
  return rows.map((row) => row.source_id);
}

const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/** What a judge sees of a candidate: the same short card for Jev and for the model. */
export function card(hit: Hit, index: number) {
  return {
    i: index,
    id: hit.sourceId,
    type: hit.chunk.sourceType,
    ...(hit.chunk.date ? { date: hit.chunk.date } : {}),
    title: clip(hit.chunk.title, 160),
    excerpt: clip(hit.chunk.content.replace(/\s+/g, " "), 420),
  };
}

const JUDGE_QUESTION = (index: number) =>
  `The record \`candidates[${index}]\` contains information that helps answer \`question\`, about the people, project, incident or event the question refers to.`;

export interface JevStats {
  calls: number;
  retries: number;
  ms: number[];
  inputTokens: number;
  cost: number;
}
export const jevStats: JevStats = { calls: 0, retries: 0, ms: [], inputTokens: 0, cost: 0 };

/**
 * Jev judges every candidate in one request: one yes/no question per
 * candidate over a shared state. Returns the probability of "yes" for each.
 * The gateway sheds load with 429/503; those are retried with backoff.
 */
export async function jevJudge(question: string, hits: Hit[]): Promise<number[]> {
  if (hits.length === 0) return [];
  const questions = Object.fromEntries(hits.map((_, index) => [`c${index}`, { type: "boolean", instructions: JUDGE_QUESTION(index) }]));
  const body = JSON.stringify({ model: "typesafe-ai/jev", state: { question, candidates: hits.map(card) }, questions });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const started = performance.now();
    const response = await fetch("https://ai-gateway.vercel.sh/v1/evaluate", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!response || response.status === 429 || response.status >= 500) {
      jevStats.retries += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4))));
      continue;
    }
    const data = (await response.json()) as {
      answers?: Record<string, { probability?: number; probabilities?: Record<string, number> }>;
      usage?: { inputTokens?: number };
      providerMetadata?: { gateway?: { cost?: string } };
      error?: { message?: string };
    };
    if (!response.ok || !data.answers) throw new Error(`Jev HTTP ${response.status}: ${data.error?.message ?? "no answers"}`);
    jevStats.calls += 1;
    jevStats.ms.push(Math.round(performance.now() - started));
    jevStats.inputTokens += data.usage?.inputTokens ?? 0;
    jevStats.cost += Number(data.providerMetadata?.gateway?.cost ?? 0);
    return hits.map((_, index) => yes(data.answers![`c${index}`]));
  }
  throw new Error("Jev unavailable after 40 attempts");
}

function yes(answer: { probability?: number; probabilities?: Record<string, number> } | undefined): number {
  if (typeof answer?.probability === "number") return answer.probability;
  if (!answer?.probabilities) return 0;
  const key = Object.keys(answer.probabilities).find((name) => /^(true|yes)$/i.test(name));
  return key ? answer.probabilities[key]! : 0;
}

/** The meeting model, for writing questions, rewriting queries, and as the judge Jev is compared with. */
export async function chat(messages: Array<{ role: string; content: string }>, options: { json?: boolean; maxTokens?: number } = {}): Promise<string> {
  const base = (process.env.SOCLAAS_BASE_URL ?? "").replace(/\/$/, "");
  const model = process.env.SOCLAAS_MODEL ?? "qwen3.8:27b";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.SOCLAAS_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: options.maxTokens ?? 800,
        thinking: { type: "disabled" },
        chat_template_kwargs: { enable_thinking: false },
        ...(options.json ? { response_format: { type: "json_object" } } : {}),
        messages,
      }),
      signal: AbortSignal.timeout(90_000),
    }).catch(() => null);
    if (!response || !response.ok) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(20_000, 2000 * (attempt + 1))));
      continue;
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return (data.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  }
  throw new Error("model unavailable");
}

export const modelStats = { calls: 0, ms: [] as number[] };

/** The meeting model as a judge: the same cards and the same question, one call, a 0 to 1 score each. */
export async function modelJudge(question: string, hits: Hit[]): Promise<number[]> {
  if (hits.length === 0) return [];
  const started = performance.now();
  const text = await chat(
    [
      {
        role: "system",
        content:
          'For each candidate record, give the probability (0 to 1) that it contains information that helps answer the question, about the people, project, incident or event the question refers to. Reply as JSON {"scores": {"0": p, "1": p, ...}} with one entry per candidate index.',
      },
      { role: "user", content: JSON.stringify({ question, candidates: hits.map(card) }) },
    ],
    { json: true, maxTokens: 900 },
  );
  modelStats.calls += 1;
  modelStats.ms.push(Math.round(performance.now() - started));
  try {
    const scores = (JSON.parse(text) as { scores?: Record<string, number> }).scores ?? {};
    return hits.map((_, index) => Number(scores[String(index)] ?? 0));
  } catch {
    return hits.map(() => 0);
  }
}

export async function pool<T, R>(items: T[], size: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await run(items[index]!, index);
      }
    }),
  );
  return out;
}

export const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
export const p95 = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] ?? 0;
};
