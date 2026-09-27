/**
 * Aggregates chaos transcripts.
 *
 *   node --import tsx eval/recruiting/chaos/summarize.mts transcripts/full-run1.json transcripts/full-run2.json
 *   node --import tsx eval/recruiting/chaos/summarize.mts --dump transcripts/full-run1.json   # readable turns
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const dump = args.includes("--dump");
const filter = args.includes("--filter") ? new RegExp(args[args.indexOf("--filter") + 1]!, "i") : null;
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--filter");

type Turn = any;

/** Mechanism checks computed from the recorded model calls (see README in the report). */
function derived(turn: Turn): Array<{ invariant: string; detail: string }> {
  const out: Array<{ invariant: string; detail: string }> = [];
  const calls = turn.modelCalls ?? [];
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const answer = norm(turn.answer ?? "");
  // Text the model wrote in the same step as a tool call never reaches the user.
  for (const call of calls) {
    const content = norm(call.content ?? "");
    if ((call.toolCalls ?? []).length && content.length > 40 && !answer.includes(content.slice(0, 40)))
      out.push({ invariant: "substance-lost-text", detail: `dropped: "${content.slice(0, 160)}" | shown: "${answer.slice(0, 100)}"` });
  }
  // The same reply twice in one answer.
  const head = answer.slice(0, 24);
  if (head.length === 24 && answer.indexOf(head, 24) > 0)
    out.push({ invariant: "substance-duplicated", detail: answer.slice(0, 120) });
  // Citation repair rewrote an answer built from recruiting tools.
  const repaired = calls.some((c: any) => /pass the source-citation check/.test(c.lastMessage ?? ""));
  const recruited = (turn.toolCalls ?? []).some((t: any) => /^recruiting_|^show_recruiting/.test(t.name));
  if (repaired && recruited)
    out.push({ invariant: "substance-citation-repair", detail: `recruiting answer rewritten by the company-citation repair: "${answer.slice(0, 140)}"` });
  // A pool candidate is named but the recruiting state was never read.
  const names = (turn.before?.detail ?? []).flatMap((r: any) => r.candidates.map((c: any) => c.name));
  const named = names.filter((n: string) => (turn.question ?? "").includes(n));
  if (named.length && !(turn.toolCalls ?? []).some((t: any) => t.name === "recruiting_status"))
    out.push({ invariant: "substance-routing", detail: `names ${named.join(", ")} but never read recruiting state` });
  // Claims checked against state (same rule as run.mts invariant 8, for transcripts recorded before it existed).
  const closed = (state: any) => new Set((state?.detail ?? []).flatMap((r: any) => r.candidates.filter((c: any) => c.stage === "closed").map((c: any) => c.id)));
  const before = closed(turn.before), after = closed(turn.after);
  const reopened = [...before].some((id) => !after.has(id));
  const newlyClosed = [...after].some((id) => !before.has(id));
  for (const sentence of (turn.answer ?? "").split(/(?<=[.!?。！？])\s*|\n+/)) {
    if (/\b(not|n't|never|cannot|can't|no|won't|if|once|before)\b|没|不|无法|未|如果/i.test(sentence)) continue;
    if (/\b(undone|reverted|reversed|taken back|back in (?:the running|play)|no longer (?:marked as )?passed)\b|已撤销|撤销了|已恢复/i.test(sentence) && !reopened && before.size)
      out.push({ invariant: "8-false-claim", detail: `undone, but still closed: "${sentence.trim().slice(0, 180)}"` });
    if (/\b(?:i(?:'ve| have)? passed on|passed on \*{0,2}[A-Z][a-z]+|is (?:now )?passed on)\b/.test(sentence) && !newlyClosed)
      out.push({ invariant: "8-false-claim", detail: `passed, but nobody closed: "${sentence.trim().slice(0, 180)}"` });
  }
  return out;
}
const tally = new Map<string, { runs: Set<string>; examples: string[] }>();
const scenarioRuns = new Map<string, { clean: number; total: number }>();

for (const file of files) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  for (const record of data.records) {
    if (filter && !filter.test(record.scenario)) continue;
    const s = scenarioRuns.get(record.scenario) ?? { clean: 0, total: 0 };
    s.total += 1;
    let clean = !record.setupError && !record.harnessError;
    if (dump) {
      console.log(`\n######## ${record.scenario} (${file}) setup=${record.setup}`);
      if (record.setupError) console.log("SETUP ERROR", record.setupError);
      if (record.backgroundErrors?.length) console.log("BACKGROUND ERRORS", record.backgroundErrors);
    }
    for (const turn of (record.turns ?? []) as Turn[]) {
      turn.violations = [...turn.violations, ...derived(turn)];
      if (turn.violations.length) clean = false;
      for (const v of turn.violations) {
        const key = `${record.scenario} | #${turn.index} | ${v.invariant}`;
        const entry = tally.get(key) ?? { runs: new Set(), examples: [] };
        entry.runs.add(file);
        if (entry.examples.length < 2) entry.examples.push(v.detail);
        tally.set(key, entry);
      }
      if (dump) {
        console.log(`\n> [#${turn.index}] ${turn.question.slice(0, 300)}`);
        console.log(`  tools: ${turn.toolCalls.map((t: any) => `${t.name}(${JSON.stringify(t.arguments).slice(0, 160)})`).join("\n         ")}`);
        console.log(`  blocks: ${JSON.stringify(turn.blocks)} changed=${turn.stateChanged} roles ${turn.before.roles.length}->${turn.after.roles.length}`);
        for (const role of turn.after.detail) {
          const open = role.candidates.filter((c: any) => c.stage !== "closed");
          console.log(
            `  role ${role.id} "${role.title}" confirmed=${role.confirmed} cands=${role.candidates.length} tiers=${open.map((c: any) => `${c.name}:${c.tier}${c.kept ? "*" : ""}`).join(",")} closed=${role.candidates.filter((c: any) => c.stage === "closed").map((c: any) => c.name).join(",")}`,
          );
          console.log(`    criteria: ${role.criteria.map((c: any) => `${c.kind}:${c.text}`).join(" | ")}`);
          if (role.proposals.length) console.log(`    proposals: ${JSON.stringify(role.proposals)}`);
        }
        if (turn.error) console.log(`  ERROR ${turn.error}`);
        console.log(`  answer (${turn.ms}ms): ${turn.answer.replace(/\n+/g, "\n    ")}`);
        if (turn.violations.length) console.log(`  VIOLATIONS: ${JSON.stringify(turn.violations)}`);
      }
    }
    if (clean) s.clean += 1;
    scenarioRuns.set(record.scenario, s);
  }
}

if (!dump) {
  console.log("Violations (scenario | turn | invariant): runs hit / runs total");
  for (const [key, entry] of [...tally].sort()) {
    const scenario = key.split(" | ")[0]!;
    console.log(`${key}: ${entry.runs.size}/${scenarioRuns.get(scenario)?.total}`);
    for (const example of entry.examples) console.log(`    ${example.slice(0, 260)}`);
  }
  console.log("\nClean in every run:");
  console.log(
    [...scenarioRuns]
      .filter(([, s]) => s.clean === s.total)
      .map(([name]) => name)
      .join(", "),
  );
}
