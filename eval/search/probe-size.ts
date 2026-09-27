import { Bm25, card, loadCorpus } from "./lib.js";
const index = new Bm25(await loadCorpus());
const question = "What was the root cause of the Kafka leader election incident on the telemetry stream?";
const hits = index.search(question, 30);
for (const size of [2, 10, 30, 2, 10, 30, 2, 10, 30]) {
  const part = hits.slice(0, size);
  const questions = Object.fromEntries(part.map((_, i) => [`c${i}`, { type: "boolean", instructions: `The record \`candidates[${i}]\` helps answer \`question\`.` }]));
  let ok = 0, tries = 0; const t0 = performance.now();
  for (; tries < 15 && !ok; tries++) {
    const r = await fetch("https://ai-gateway.vercel.sh/v1/evaluate", { method: "POST", headers: { authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "typesafe-ai/jev", state: { question, candidates: part.map(card) }, questions }) });
    if (r.ok) ok = 1; else { await r.text(); await new Promise((s) => setTimeout(s, 700)); }
  }
  console.log(`size ${size}: ${ok ? "ok" : "FAIL"} after ${tries} tries, ${Math.round(performance.now() - t0)} ms`);
}
