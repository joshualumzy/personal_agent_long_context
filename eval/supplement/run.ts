/**
 * Runs the pre-registered supplementary cases (eval/supplement/cases.json).
 *
 *   node --env-file=.env --import tsx eval/supplement/run.ts
 *
 * - honest_uncertainty: the fixed judge compares the answer with the case's
 *   reference; it passes only on "agrees" (said it could not find it, stated
 *   nothing about it as fact).
 * - my_plate: scored mechanically, no judge. An expected item is covered when
 *   its id appears in the answer or among the cited sources; the case passes
 *   when at least half its items are covered. Any cited ticket or outreach id
 *   that is not on the list counts as an extra, reported but not failed.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresCompanyKnowledge } from "../../src/adapters/postgres-company-knowledge.js";
import type { AsOf } from "../../src/as-of.js";
import { embeddingProviderFromEnvironment } from "../../src/embeddings.js";
import { SoCLaaSCompanyAgent } from "../../src/soclaas-company-agent.js";
import { judgeAgainstReference, judgeOptionsFromEnvironment, type Verdict } from "../orgforge/judge.js";
import type { HonestyCase, PlateCase } from "./build_cases.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_ITEM = /^(?:ENG|OUTREACH)-\d+$/;

/** An item's ticket id without a per-person suffix: OUTREACH-4-marcus -> OUTREACH-4. */
const baseId = (id: string) => id.replace(/^((?:ENG|OUTREACH)-\d+)-[a-z]+$/, "$1");

/** Ticket ids an answer names, including lists written "OUTREACH-4, 9 and 17". */
function namedIds(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(/\b(ENG|OUTREACH)-(\d+)((?:\s*(?:,|and|&|\/)\s*\d+\b)*)/g)) {
    for (const n of [m[2], ...(m[3]!.match(/\d+/g) ?? [])]) ids.push(`${m[1]}-${n}`);
  }
  return ids;
}

interface CaseResult {
  id: string;
  category: string;
  employeeId: string;
  question: string;
  answer: string;
  cited: string[];
  toolCalls: Array<{ name: string; arguments: unknown }>;
  latencyMs: number;
  passed: boolean;
  verdict?: Verdict;
  covered?: string[];
  missed?: string[];
  extras?: string[];
  error?: string;
}

async function main(): Promise<void> {
  const { cases } = JSON.parse(await readFile(path.join(__dirname, "cases.json"), "utf-8")) as {
    cases: Array<HonestyCase | PlateCase>;
  };
  const knowledge = new PostgresCompanyKnowledge(process.env.DATABASE_URL!, embeddingProviderFromEnvironment(process.env));
  const agent = new SoCLaaSCompanyAgent(knowledge, {
    apiKey: process.env.SOCLAAS_API_KEY!,
    baseUrl: process.env.SOCLAAS_BASE_URL ?? "https://soclaas-api.comp.nus.edu.sg/v1",
    model: process.env.SOCLAAS_COMPANY_MODEL ?? "qwen3.8:27b",
    corporateDate: "2026-03-25",
  });
  const judge = judgeOptionsFromEnvironment(process.env);
  const results: CaseResult[] = [];

  try {
    for (const [i, c] of cases.entries()) {
      process.stdout.write(`[${i + 1}/${cases.length}] ${c.id.padEnd(10)} ${c.question.slice(0, 56).padEnd(56)} `);
      const started = Date.now();
      const base = { id: c.id, category: c.category, employeeId: c.employeeId, question: c.question };
      try {
        const reply = await agent.answer({
          employeeId: c.employeeId,
          question: c.question,
          ...(c.category === "my_plate" ? { asOf: c.asOf as AsOf } : {}),
        });
        const cited = reply.sources.map((s) => s.sourceId);
        const common = { ...base, answer: reply.answer, cited, toolCalls: reply.toolCalls, latencyMs: Date.now() - started };
        if (c.category === "honest_uncertainty") {
          const verdict = await judgeAgainstReference(judge, c.question, c.reference, reply.answer);
          results.push({ ...common, verdict, passed: verdict === "agrees" });
        } else {
          const mentioned = new Set([...namedIds(reply.answer), ...cited].map(baseId));
          const covered = c.expectedItems.filter((item) => mentioned.has(baseId(item)));
          const missed = c.expectedItems.filter((item) => !mentioned.has(baseId(item)));
          const expectedBases = new Set(c.expectedItems.map(baseId));
          const extras = [...mentioned].filter((id) => IS_ITEM.test(id) && !expectedBases.has(id));
          results.push({ ...common, covered, missed, extras, passed: covered.length * 2 >= c.expectedItems.length });
        }
      } catch (error) {
        results.push({
          ...base, answer: "", cited: [], toolCalls: [], latencyMs: Date.now() - started, passed: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const r = results.at(-1)!;
      const detail = r.error ? `error: ${r.error}` : r.verdict ?? `${r.covered!.length}/${r.covered!.length + r.missed!.length} items`;
      console.log(`${r.passed ? "✅" : "❌"} ${detail} [${(r.latencyMs / 1000).toFixed(1)}s]`);
    }
  } finally {
    await knowledge.close();
  }

  console.log("\nSupplement scorecard");
  for (const category of ["honest_uncertainty", "my_plate"]) {
    const rows = results.filter((r) => r.category === category);
    console.log(`  ${category.padEnd(20)} ${rows.filter((r) => r.passed).length}/${rows.length} passed`);
  }
  const plates = results.filter((r) => r.category === "my_plate" && !r.error);
  const expected = plates.reduce((n, r) => n + r.covered!.length + r.missed!.length, 0);
  const covered = plates.reduce((n, r) => n + r.covered!.length, 0);
  console.log(`  plate item recall     ${covered}/${expected}`);

  const outDir = path.join(__dirname, "../../docs/evaluation");
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `supplement-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, `${JSON.stringify({ model: process.env.SOCLAAS_COMPANY_MODEL ?? "qwen3.8:27b", judge: judge.model, results }, null, 2)}\n`);
  console.log(`\nReport: ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
