/** Scores results.json against the labels: node --import tsx eval/meetings/orgforge/score.ts */
import { readFile } from "node:fs/promises";
const { stats, rows } = JSON.parse(await readFile(new URL("./results.json", import.meta.url), "utf8")) as { stats: unknown; rows: Array<{ key: string; line: string; accepted: string[]; jev: { choice: string; p: number; ms: number }; qwen: { choice: string; p: number; ms: number } }> };
const CARD = (k: string) => !["none", "task", "answer_question", "ERROR", ""].includes(k);
const pct = (a: number, b: number) => `${a}/${b} (${Math.round((100 * a) / b)}%)`;
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
console.log(stats);
for (const who of ["jev", "qwen"] as const) {
  const ok = rows.filter((r) => r[who].choice !== "ERROR");
  const right = ok.filter((r) => r.accepted.includes(r[who].choice));
  const wantCard = rows.filter((r) => CARD(r.accepted[0]!));
  const gotCard = ok.filter((r) => CARD(r[who].choice));
  const falseCard = gotCard.filter((r) => !r.accepted.some(CARD));
  const wantTask = rows.filter((r) => r.accepted[0] === "task");
  const noneAsSomething = ok.filter((r) => r.accepted[0] === "none" && !r.accepted.includes(r[who].choice) && r[who].choice !== "none");
  const ms = ok.map((r) => r[who].ms);
  console.log(`\n== ${who}: errors ${rows.length - ok.length}, accuracy ${pct(right.length, ok.length)}, median ${median([...ms])}ms, p90 ${[...ms].sort((a, b) => a - b)[Math.floor(ms.length * 0.9)]}ms`);
  console.log(`  cards wanted ${wantCard.length}, caught ${wantCard.filter((r) => r.accepted.includes(r[who].choice)).length}; cards opened ${gotCard.length}, wrong ${falseCard.length}`);
  console.log(`  tasks ${wantTask.length}, called task ${wantTask.filter((r) => r[who].choice === "task").length}, called none ${wantTask.filter((r) => r[who].choice === "none").length}`);
  console.log(`  plain talk wrongly flagged: ${noneAsSomething.length}`);
  const confusion: Record<string, number> = {};
  for (const r of ok) if (!r.accepted.includes(r[who].choice)) confusion[`${r.accepted[0]}→${r[who].choice}`] = (confusion[`${r.accepted[0]}→${r[who].choice}`] ?? 0) + 1;
  console.log("  mistakes:", confusion);
  if (who === "jev") for (const t of [0.6, 0.8, 0.9]) {
    const sure = ok.filter((r) => r.jev.p >= t);
    console.log(`  p>=${t}: ${pct(sure.length, ok.length)} lines decided, ${pct(sure.filter((r) => r.accepted.includes(r.jev.choice)).length, sure.length)} right; wrong cards among them ${sure.filter((r) => CARD(r.jev.choice) && !r.accepted.some(CARD)).length}`);
  }
}
console.log("\n== card-relevant lines (label or either model says card)");
for (const r of rows) if (CARD(r.accepted[0]!) || CARD(r.jev.choice) || CARD(r.qwen.choice))
  console.log(`${r.key} [${r.accepted.join(",")}] jev=${r.jev.choice}(${r.jev.p.toFixed(2)}) qwen=${r.qwen.choice} | ${r.line.slice(0, 110)}`);
