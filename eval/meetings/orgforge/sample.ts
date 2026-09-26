/**
 * Samples OrgForge meetings for the line-screening study and writes their
 * lines, unlabelled, to lines.json. Labels are added by hand in labels.json
 * before any model output is looked at.
 *
 *   node --env-file=.env --import tsx eval/meetings/orgforge/sample.ts [count]
 */
import { writeFile } from "node:fs/promises";
import pg from "pg";
import { parseTranscript } from "../../../src/meetings/transcript.js";

const count = Number(process.argv[2] ?? 20);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// setseed makes the random order repeatable.
await pool.query("SELECT setseed(0.26)");
const rows = (
  await pool.query<{ source_id: string; title: string; body: string }>(
    "SELECT source_id, title, body FROM source_documents WHERE source_type = 'zoom_transcript' ORDER BY random() LIMIT $1",
    [count],
  )
).rows;
await pool.end();
const meetings = rows.map((row) => ({
  sourceId: row.source_id,
  title: row.title,
  lines: parseTranscript(row.body).map(({ speaker, text }, index) => ({ id: `${row.source_id}#${index}`, speaker, text })),
}));
await writeFile(new URL("./lines.json", import.meta.url), JSON.stringify(meetings, null, 1));
console.log(`${meetings.length} meetings, ${meetings.reduce((n, m) => n + m.lines.length, 0)} lines`);
for (const m of meetings) console.log(`- ${m.title} (${m.lines.length})`);
