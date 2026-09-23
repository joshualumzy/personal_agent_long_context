/**
 * Recruiting evaluation (docs/s3-recruiting.md, Evaluation).
 *
 *   npm run eval:recruiting:template   # writes eval/recruiting/labels.json to fill in
 *   npm run eval:recruiting            # scores the model against the labels
 *
 * (a) Verdict agreement: the model's yes/no/unclear per (candidate, criterion)
 *     against a human label.
 * (b) Feedback effectiveness: of the candidates the labeller says the founder
 *     would pass on, the share still in the top two tiers before and after the
 *     learned criterion is added. Lower after is better.
 */
import { readFile, writeFile } from "node:fs/promises";
import { judge } from "../../src/recruiting/agent.js";
import type { Candidate, CandidateProfile, Criterion, VerdictValue } from "../../src/recruiting/domain.js";
import { OpenAiCompatibleModel } from "../../src/recruiting/llm.js";
import { tierOf } from "../../src/recruiting/tiers.js";

interface LabelFile {
  criteria: { id: string; text: string; kind: "must" | "nice" }[];
  learnedCriterion: { id: string; text: string; kind: "must" | "nice" };
  candidates: {
    profile: CandidateProfile;
    /** Human verdict per criterion id, including the learned one. "" = not labelled yet. */
    labels: Record<string, VerdictValue | "">;
    founderWouldPass: boolean | null;
  }[];
}

const LABELS = "eval/recruiting/labels.json";

async function template() {
  const samples = JSON.parse(
    await readFile("src/recruiting/sample-candidates.json", "utf8"),
  ) as CandidateProfile[];
  const criteria = [
    { id: "c1", text: "Based in Singapore or able to work there", kind: "must" as const },
    { id: "c2", text: "Strong production backend experience in TypeScript and Node.js", kind: "must" as const },
    { id: "c3", text: "Has shipped a product at a startup", kind: "must" as const },
    { id: "c4", text: "Rust experience", kind: "nice" as const },
  ];
  const learnedCriterion = {
    id: "c5",
    text: "Owned a shipped product end to end, not only implementing others' designs",
    kind: "must" as const,
  };
  const file: LabelFile = {
    criteria,
    learnedCriterion,
    candidates: samples.slice(0, 30).map((profile) => ({
      profile,
      labels: Object.fromEntries([...criteria, learnedCriterion].map((c) => [c.id, ""])),
      founderWouldPass: null,
    })),
  };
  await writeFile(LABELS, JSON.stringify(file, null, 1));
  console.log(`Wrote ${LABELS}. Fill every label with yes, no, or unclear, and founderWouldPass with true or false.`);
}

function asCriteria(entries: LabelFile["criteria"]): Criterion[] {
  return entries.map((entry) => ({ ...entry, origin: "stated", active: true, createdAt: "" }));
}

async function run() {
  const file = JSON.parse(await readFile(LABELS, "utf8")) as LabelFile;
  const baseUrl = process.env.SOCLAAS_BASE_URL;
  const apiKey = process.env.SOCLAAS_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("Set SOCLAAS_BASE_URL and SOCLAAS_API_KEY.");
  const model = new OpenAiCompatibleModel({
    baseUrl,
    apiKey,
    model: process.env.RECRUITING_MODEL ?? "qwen3.8:27b",
  });
  const all = asCriteria([...file.criteria, file.learnedCriterion]);

  let agree = 0;
  let total = 0;
  const confusion: Record<string, number> = {};
  const judged: Candidate[] = [];

  for (const entry of file.candidates) {
    const verdicts = await judge(model, entry.profile, all);
    const candidate = {
      profile: entry.profile,
      verdicts: Object.fromEntries(verdicts.map((verdict) => [verdict.criterionId, verdict])),
    } as unknown as Candidate;
    judged.push(candidate);
    for (const verdict of verdicts) {
      const label = entry.labels[verdict.criterionId];
      if (!label) continue;
      total += 1;
      if (label === verdict.satisfied) agree += 1;
      const key = `${label}->${verdict.satisfied}`;
      confusion[key] = (confusion[key] ?? 0) + 1;
    }
    process.stdout.write(".");
  }
  console.log();

  const before = asCriteria(file.criteria);
  const top = (candidate: Candidate, criteria: Criterion[]) => {
    const tier = tierOf(candidate, criteria);
    return tier === 100 || tier === 75;
  };
  const wouldPass = file.candidates
    .map((entry, index) => ({ entry, candidate: judged[index]! }))
    .filter(({ entry }) => entry.founderWouldPass === true);
  const share = (criteria: Criterion[]) =>
    wouldPass.length === 0
      ? null
      : wouldPass.filter(({ candidate }) => top(candidate, criteria)).length / wouldPass.length;

  const report = {
    runAt: new Date().toISOString(),
    model: process.env.RECRUITING_MODEL ?? "qwen3.8:27b",
    verdictAgreement: total ? agree / total : null,
    labelledVerdicts: total,
    confusion,
    wouldPassCandidates: wouldPass.length,
    wouldPassInTopTiersBefore: share(before),
    wouldPassInTopTiersAfter: share(all),
  };
  console.log(JSON.stringify(report, null, 2));
  await writeFile(`docs/evaluation/recruiting-${report.runAt.slice(0, 10)}.json`, JSON.stringify(report, null, 2));
}

if (process.argv.includes("--template")) await template();
else await run();
