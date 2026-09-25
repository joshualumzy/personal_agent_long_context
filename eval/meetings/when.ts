/**
 * Compares "when" readers on eval/meetings/when-cases.json: each fills the
 * form, resolveWhen turns it into a date, and the result is scored as right,
 * left blank (asked, safe) or wrong (a date or time that is not what was said).
 *
 *   node --env-file=.env --import tsx eval/meetings/when.ts [qwen] [jev]
 */
import { readFile } from "node:fs/promises";
import { OpenAiCompatibleModel, type JsonModel } from "../../src/recruiting/llm.js";
import { JevWhenReader, ModelWhenReader, resolveWhen, type WhenReader } from "../../src/meetings/when.js";

interface Case {
  said: string;
  day: string | null;
  time: string | null;
}

const file = JSON.parse(await readFile(new URL("./when-cases.json", import.meta.url), "utf8")) as { meetingAt: string; cases: Case[] };
const meetingAt = new Date(file.meetingAt);
const meetingDay = "Friday 2026-09-25 (Singapore)";

function readers(names: string[]): WhenReader[] {
  const chosen: WhenReader[] = [];
  if (names.includes("qwen")) {
    const base = new OpenAiCompatibleModel({
      baseUrl: process.env.SOCLAAS_BASE_URL!,
      apiKey: process.env.SOCLAAS_API_KEY!,
      model: process.env.MEETINGS_MODEL ?? "qwen3.8:27b",
      timeoutMs: 90_000,
    });
    const model: JsonModel = { json: (request) => base.json({ ...request, fast: true }) };
    chosen.push(new ModelWhenReader(model));
  }
  if (names.includes("jev")) chosen.push(new JevWhenReader(process.env.AI_GATEWAY_API_KEY!));
  return chosen;
}

type Verdict = "right" | "blank" | "wrong" | "error";

function score(expected: Case, day: string | null, time: string | null): Verdict {
  const fields: Array<[string | null, string | null]> = [
    [expected.day, day],
    [expected.time, time],
  ];
  if (fields.some(([want, got]) => got !== null && got !== want)) return "wrong";
  if (fields.some(([want, got]) => want !== null && got === null)) return "blank";
  return "right";
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : ["qwen", "jev"];
for (const reader of readers(names)) {
  const tally: Record<Verdict, number> = { right: 0, blank: 0, wrong: 0, error: 0 };
  const latencies: number[] = [];
  console.log(`\n## ${reader.name}\n`);
  console.log("| said | expected | got | verdict | ms |\n|---|---|---|---|---:|");
  for (const item of file.cases) {
    const started = performance.now();
    let got = { day: null as string | null, time: null as string | null };
    let note = "";
    let failed = false;
    try {
      const form = await reader.read(item.said, meetingDay);
      const reading = resolveWhen(form, meetingAt);
      got = { day: reading.date ?? null, time: reading.start?.slice(11, 16) ?? null };
      if (form.unsure.length) note = ` (unsure: ${form.unsure.join(", ")})`;
    } catch (error) {
      failed = true;
      note = ` (error: ${error instanceof Error ? error.message.slice(0, 80) : String(error)})`;
    }
    const ms = Math.round(performance.now() - started);
    latencies.push(ms);
    const verdict: Verdict = failed ? "error" : score(item, got.day, got.time);
    tally[verdict] += 1;
    console.log(`| ${item.said} | ${item.day ?? "—"} ${item.time ?? ""} | ${got.day ?? "—"} ${got.time ?? ""}${note} | ${verdict} | ${ms} |`);
  }
  latencies.sort((a, b) => a - b);
  console.log(`\n${reader.name}: right ${tally.right}, left blank ${tally.blank}, WRONG ${tally.wrong}, errors ${tally.error} of ${file.cases.length}; median ${latencies[Math.floor(latencies.length / 2)]} ms`);
}

