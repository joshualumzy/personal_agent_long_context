import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * OrgForge's own knowledge-gap record is the answer key benchmark questions are
 * built on (docs/mvp.md, "Knowledge gaps and hiring proposals"). Only the
 * offline backtest may read it. This keeps runtime code from starting to.
 *
 * Known exception, older than this rule: build_graph.py copies a domain's
 * documentation_coverage and is_genesis_gap, and a page's self-audit
 * gap_classification, into graph_nodes.props (migration 007 defines the
 * columns). The hiring code must not read those props either — it is in the
 * scanned set below.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const FORBIDDEN = /knowledge_gap_detected|gap_classification|detection_method|is_genesis_gap|documentation_coverage|documented_pct|days_since_departure/;

async function filesUnder(dir: string, pattern: RegExp): Promise<string[]> {
  const entries = await readdir(join(root, dir), { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name));
}

test("no runtime code reads OrgForge's knowledge-gap record", async () => {
  const runtime = [
    ...(await filesUnder("src", /\.ts$/)),
    ...(await filesUnder("public", /\.(js|html)$/)),
    // Migrations from the planner on; 007 predates the rule and defines the registry.
    ...(await filesUnder("database/migrations", /^(019|02\d|0[3-9]\d)_.*\.sql$/)),
    join(root, "orgforge_kb/build_timeline.py"),
  ];
  assert.ok(runtime.length > 20, "the scan should see the runtime sources");
  const offenders: string[] = [];
  for (const file of runtime) {
    const text = await readFile(file, "utf8");
    text.split("\n").forEach((line, index) => {
      if (FORBIDDEN.test(line)) offenders.push(`${file.replace(root, "")}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("the answer key says what it is, and holds the corpus's departures and hires", async () => {
  const truth = JSON.parse(await readFile(join(root, "eval/orgforge/gap-truth.json"), "utf8"));
  assert.match(truth.note, /OFFLINE/);
  assert.deepEqual(truth.departures.map((d: { person: string }) => d.person), ["Bill", "Sharon", "Jordan", "Morgan"]);
  assert.deepEqual(truth.hires.map((h: { person: string }) => h.person), ["Janice", "Reese", "Ethan Patel"]);
  assert.equal(truth.handovers.length, 7);
});
