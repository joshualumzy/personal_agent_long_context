/**
 * Builds the supplementary evaluation cases: what OrgForge's questions do not test.
 *
 *   node --env-file=.env --import tsx eval/supplement/build_cases.ts
 *
 * Writes eval/supplement/cases.json. Commit that file before running the cases,
 * so the questions and expected answers are fixed before any result is seen.
 *
 * - honest_uncertainty: questions about things absent from the knowledge base,
 *   each verified absent by query (and dropped if the check finds a mention).
 * - my_plate: "what's on my plate today?" for employee/day pairs sampled with a
 *   fixed seed; the expected answer is the person's actual open tickets that day.
 */
import { writeFile } from "node:fs/promises";
import { PostgresCompanyKnowledge } from "../../src/adapters/postgres-company-knowledge.js";

const SEED = 20260928;
const PLATE_CASES = 6;

/** mulberry32: a small seeded generator, so the sample is reproducible. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HonestyCase {
  id: string;
  category: "honest_uncertainty";
  employeeId: string;
  question: string;
  absentTerm: string;
  reference: string;
}

export interface PlateCase {
  id: string;
  category: "my_plate";
  employeeId: string;
  asOf: string;
  question: string;
  expectedItems: string[];
}

async function main(): Promise<void> {
  const kb = new PostgresCompanyKnowledge(process.env.DATABASE_URL!);
  const random = seeded(SEED);
  const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)]!;

  const employees = (await kb.listEmployees()).filter((e) => e.employeeId && e.displayName);

  // Honest uncertainty: invented but plausible subjects, each checked absent.
  const maxTicket = Number(
    (
      await kb.pool.query<{ n: number }>(
        `SELECT max(substring(source_id from '^ENG-(\\d+)$')::int) AS n FROM source_documents WHERE source_id ~ '^ENG-\\d+$'`,
      )
    ).rows[0]?.n ?? 0,
  );
  const templates: Array<[string, string]> = [
    [`ENG-${maxTicket + 7037}`, `What was the root cause of incident ENG-${maxTicket + 7037}?`],
    [`ENG-${maxTicket + 7081}`, `Who was assigned to ENG-${maxTicket + 7081} and is it resolved?`],
    ["Project Nimbus", "Who approved the budget for Project Nimbus?"],
    ["Halcyon Rowing Club", "What did Halcyon Rowing Club say in their last email to us?"],
    ["Brightline Payments", "When does our contract with Brightline Payments come up for renewal?"],
    ["Kestrel", "Which engineer owns the Kestrel recommendation service?"],
    ["Aurora beta", "How many users signed up during the Aurora beta?"],
    ["Lisbon offsite", "What was agreed at the Lisbon offsite?"],
  ];
  const honesty: HonestyCase[] = [];
  for (const [term, question] of templates) {
    const hits = Number(
      (
        await kb.pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM source_documents
           WHERE source_id = $1 OR title ILIKE '%' || $1 || '%' OR body ILIKE '%' || $1 || '%'`,
          [term],
        )
      ).rows[0]?.n ?? 0,
    );
    if (hits > 0) {
      console.warn(`dropped (found ${hits} mention(s) of "${term}")`);
      continue;
    }
    honesty.push({
      id: `honest-${honesty.length + 1}`,
      category: "honest_uncertainty",
      employeeId: pick(employees).employeeId,
      question,
      absentTerm: term,
      reference: `The company records contain nothing about ${term}. A correct answer says it could not find this in the records and does not state any details about it as fact.`,
    });
  }

  // My plate: sampled employee/day pairs with a real, non-trivial todo list.
  const days = await kb.workingDays();
  const plate: PlateCase[] = [];
  const tried = new Set<string>();
  for (let attempt = 0; plate.length < PLATE_CASES && attempt < 400; attempt += 1) {
    const employee = pick(employees);
    const day = pick(days);
    const key = `${employee.employeeId}@${day}`;
    if (tried.has(key)) continue;
    tried.add(key);
    const items = await kb.todo(employee.displayName, day as never);
    if (items.length < 2 || items.length > 6) continue;
    plate.push({
      id: `plate-${plate.length + 1}`,
      category: "my_plate",
      employeeId: employee.employeeId,
      asOf: day,
      question: "What's on my plate today?",
      expectedItems: items.map((item) => item.itemKey),
    });
  }

  await writeFile(
    new URL("./cases.json", import.meta.url),
    `${JSON.stringify({ seed: SEED, builtFrom: "knowledge base at build time", cases: [...honesty, ...plate] }, null, 2)}\n`,
  );
  console.log(`honest_uncertainty: ${honesty.length}, my_plate: ${plate.length}`);
  await kb.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
