/**
 * Builds the hard tier of the supplementary cases, alongside cases.json.
 *
 *   node --env-file=.env --import tsx eval/supplement/build_hard_cases.ts
 *
 * Writes eval/supplement/hard_cases.json; commit it before running.
 *
 * - false_premise: questions about real tickets whose premise the records
 *   contradict. Unlike an invented subject, search finds plenty about the
 *   ticket, so "I found nothing" is not available: the assistant has to
 *   notice the premise is wrong rather than fill in the details asked for.
 *     closed_open: "When was ENG-X closed?" for a ticket still open at the end.
 *     wrong_owner: "Why did B take over ENG-X?" for someone never assigned it.
 * - my_plate (hard): busy days (7+ open items) and other phrasings.
 */
import { writeFile } from "node:fs/promises";
import { PostgresCompanyKnowledge } from "../../src/adapters/postgres-company-knowledge.js";

const SEED = 20260929;
const PER_KIND = 4;

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

export interface FalsePremiseCase {
  id: string;
  category: "false_premise";
  kind: "closed_open" | "wrong_owner";
  employeeId: string;
  question: string;
  ticket: string;
  reference: string;
}

async function main(): Promise<void> {
  const kb = new PostgresCompanyKnowledge(process.env.DATABASE_URL!);
  const random = seeded(SEED);
  const shuffle = <T,>(items: T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  };
  const employees = (await kb.listEmployees()).filter((e) => e.employeeId && e.displayName);
  const byName = new Map(employees.map((e) => [e.displayName.toLowerCase(), e]));

  // Tickets still being worked at the end of the record, with who works them
  // and everyone who ever did.
  const open = (
    await kb.pool.query<{ item_key: string; status: string; assignee: string; department: string | null; ever: string[] }>(
      `SELECT s.item_key, s.status, s.assignee, s.department,
              (SELECT array_agg(DISTINCT a.assignee) FROM work_item_state a
                WHERE a.item_key = s.item_key AND a.assignee IS NOT NULL) AS ever
       FROM work_item_state s
       WHERE s.valid_to IS NULL AND s.status IN ('In Progress', 'In Review')
         AND s.item_key LIKE 'ENG-%' AND s.assignee IS NOT NULL
       ORDER BY s.item_key`,
    )
  ).rows.filter((row) => byName.has(row.assignee.toLowerCase()));

  const picked = shuffle(open);
  const cases: FalsePremiseCase[] = [];
  for (const row of picked.slice(0, PER_KIND)) {
    cases.push({
      id: `premise-${cases.length + 1}`,
      category: "false_premise",
      kind: "closed_open",
      employeeId: byName.get(row.assignee.toLowerCase())!.employeeId,
      question: `When was ${row.item_key} closed, and who signed off on it?`,
      ticket: row.item_key,
      reference: `${row.item_key} was never closed: at the end of the records it is still ${row.status}, worked by ${row.assignee}. A correct answer says it has not been closed (or that it found no closure) and does not give a closing date or a sign-off.`,
    });
  }
  for (const row of picked.slice(PER_KIND, PER_KIND * 2)) {
    // Someone from another department who never held the ticket.
    const others = employees.filter(
      (e) => !row.ever.map((n) => n.toLowerCase()).includes(e.displayName.toLowerCase()) && e.department !== row.department,
    );
    const other = others[Math.floor(random() * others.length)]!;
    cases.push({
      id: `premise-${cases.length + 1}`,
      category: "false_premise",
      kind: "wrong_owner",
      employeeId: byName.get(row.assignee.toLowerCase())!.employeeId,
      question: `Why did ${other.displayName} take over ${row.item_key} from ${row.assignee}?`,
      ticket: row.item_key,
      reference: `Nothing records ${other.displayName} taking over ${row.item_key}; it was worked by ${row.ever.join(", ")}, and at the end of the records ${row.assignee} still has it. A correct answer says there is no record of that hand-over and does not invent one or a reason for it.`,
    });
  }

  // Busy plates, asked other ways.
  const phrasings = [
    "What should I focus on today?",
    "Anything I'm on the hook for right now?",
    "What's still open on my side?",
    "Give me a rundown of my open work.",
  ];
  const days = await kb.workingDays();
  const plate = [];
  const tried = new Set<string>();
  for (let attempt = 0; plate.length < PER_KIND && attempt < 2000; attempt += 1) {
    const employee = employees[Math.floor(random() * employees.length)]!;
    const day = days[Math.floor(random() * days.length)]!;
    const key = `${employee.employeeId}@${day}`;
    if (tried.has(key)) continue;
    tried.add(key);
    const items = await kb.todo(employee.displayName, day as never);
    if (items.length < 7) continue;
    plate.push({
      id: `plate-hard-${plate.length + 1}`,
      category: "my_plate" as const,
      employeeId: employee.employeeId,
      asOf: day,
      question: phrasings[plate.length % phrasings.length]!,
      expectedItems: items.map((item) => item.itemKey),
    });
  }

  await writeFile(
    new URL("./hard_cases.json", import.meta.url),
    `${JSON.stringify({ seed: SEED, builtFrom: "knowledge base at build time", cases: [...cases, ...plate] }, null, 2)}\n`,
  );
  console.log(`false_premise: ${cases.length}, my_plate (busy): ${plate.length}`);
  await kb.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
