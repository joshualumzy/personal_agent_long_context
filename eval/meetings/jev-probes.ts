/**
 * Probes of what Jev can and cannot do, beyond the meeting judgements:
 * dates, counting, arithmetic, latency against the number of questions and
 * the size of the state, repeatability, Chinese input, negated questions,
 * and the cost the gateway reports.
 *
 *   node --env-file=.env --import tsx eval/meetings/jev-probes.ts
 */

interface Answer {
  choice?: string;
  probability?: number;
  probabilities?: Record<string, number>;
}
interface Call {
  answers: Record<string, Answer>;
  ms: number;
  inputTokens: number;
  cost: string;
  attempts: number;
}

let totalCalls = 0;
let total503 = 0;

async function jev(state: unknown, questions: Record<string, unknown>): Promise<Call> {
  const started = performance.now();
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 3) await new Promise((resolve) => setTimeout(resolve, 500));
    totalCalls += 1;
    const response = await fetch("https://ai-gateway.vercel.sh/v1/evaluate", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "typesafe-ai/jev", state, questions }),
    });
    if (response.status === 503 || response.status === 429) {
      total503 += 1;
      continue;
    }
    const data = (await response.json()) as {
      answers?: Record<string, Answer>;
      usage?: { inputTokens: number };
      providerMetadata?: { gateway?: { cost?: string } };
    };
    if (!response.ok || !data.answers) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return {
      answers: data.answers,
      ms: Math.round(performance.now() - started),
      inputTokens: data.usage?.inputTokens ?? 0,
      cost: data.providerMetadata?.gateway?.cost ?? "?",
      attempts: attempt,
    };
  }
  throw new Error("unavailable after 10 tries");
}

const choice = (instructions: string, criteria: Record<string, string>) => ({ type: "choice", instructions, criteria });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const top = (a: Answer) => (a.choice ? `${a.choice} (${(a.probabilities?.[a.choice] ?? 0).toFixed(2)})` : `p=${a.probability?.toFixed(2)}`);

/** Runs one probe; a failure is reported and the rest continue. */
async function probe(run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    console.log(`| (failed: ${error instanceof Error ? error.message.slice(0, 80) : String(error)}) |`);
  }
}

function section(title: string) {
  console.log(`\n## ${title}\n`);
}

// 1. Dates ------------------------------------------------------------------
section("dates: which comes first, and does it fall in a window");
const datePairs: Array<[string, string, string]> = [
  ["2026-09-30", "2026-10-07", "first"],
  ["2026-10-07", "2026-09-30", "second"],
  ["2026-12-31", "2027-01-01", "first"],
  ["2026-02-28", "2026-03-01", "first"],
  ["2026-11-09", "2026-11-10", "first"],
  ["2026-10-01", "2026-09-30", "second"],
  ["30 Sep 2026", "7 Oct 2026", "first"],
  ["7 Oct 2026", "30 Sep 2026", "second"],
];
let dateRight = 0;
for (const [a, b, expected] of datePairs) {
  const r = await jev({ first: a, second: b }, { earlier: choice("Which date is earlier?", { first: "the first date is earlier", second: "the second date is earlier" }) });
  const got = r.answers.earlier!;
  if (got.choice === expected) dateRight++;
  console.log(`| ${a} vs ${b} | expected ${expected} | ${top(got)} |`);
}
const windows: Array<[string, string, string, string]> = [
  ["2026-10-03", "2026-09-28", "2026-10-02", "no"],
  ["2026-09-30", "2026-09-28", "2026-10-02", "yes"],
  ["2026-10-15", "2026-10-01", "2026-10-31", "yes"],
  ["2026-11-01", "2026-10-01", "2026-10-31", "no"],
];
let windowRight = 0;
for (const [d, from, to, expected] of windows) {
  const r = await jev({ date: d, windowStart: from, windowEnd: to }, { inside: choice("Does the date fall inside the window, inclusive?", { yes: "inside the window", no: "outside the window" }) });
  if (r.answers.inside!.choice === expected) windowRight++;
  console.log(`| ${d} in [${from}, ${to}] | expected ${expected} | ${top(r.answers.inside!)} |`);
}
console.log(`\ndates: earlier-of-two ${dateRight}/${datePairs.length}, inside-window ${windowRight}/${windows.length}`);

// 2. Counting and arithmetic --------------------------------------------------
section("counting and arithmetic");
const counts: Array<[string, number]> = [
  ["ticket ticket ticket", 3],
  ["Open a ticket for Ben, a ticket for Deepa, and one more ticket for Jax, then close the old ticket.", 4],
  ["Alice, Bob, Carol, Dan, Erin and Frank joined the call.", 6],
  ["We paged the same three people for every incident this quarter: Ben, Deepa and Jax.", 3],
];
let countRight = 0;
const numberOptions = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`n${i}`, String(i)]));
for (const [text, expected] of counts) {
  const q = text.startsWith("ticket") || text.startsWith("Open") ? "How many times does the word 'ticket' appear?" : "How many people are named?";
  const r = await jev({ text }, { count: choice(q, numberOptions) });
  if (r.answers.count!.choice === `n${expected}`) countRight++;
  console.log(`| ${q} "${text.slice(0, 50)}" | expected ${expected} | ${top(r.answers.count!)} |`);
}
const sums: Array<[number, number]> = [[17, 26], [48, 57], [125, 250], [9, 8]];
let sumRight = 0;
for (const [a, b] of sums) {
  const right = a + b;
  const options = Object.fromEntries([right - 10, right - 1, right, right + 1, right + 10].map((v) => [`v${v}`, String(v)]));
  const r = await jev({ a, b }, { sum: choice("What is a + b?", options) });
  if (r.answers.sum!.choice === `v${right}`) sumRight++;
  console.log(`| ${a} + ${b} | expected ${right} | ${top(r.answers.sum!)} |`);
}
console.log(`\ncounting ${countRight}/${counts.length}, sums ${sumRight}/${sums.length}`);

// 2b. Harder: long counts, day gaps, multiplication with near-miss options ------
section("harder counting, day gaps and multiplication");
const paragraph =
  "The team met on the Monday after the launch. The customer asked about the outage, the fix and the timeline. The engineers explained the root cause, the patch and the plan for the next release. The manager noted the risks, the costs and the staffing gap. The meeting ended with the list of the actions for the week.";
const theCount = (paragraph.match(/\bthe\b/gi) ?? []).length;
const bigNumbers = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`n${theCount - 5 + i}`, String(theCount - 5 + i)]));
await probe(async () => {
  const r = await jev({ text: paragraph }, { count: choice("How many times does the word 'the' appear (any case)?", bigNumbers) });
  console.log(`| count 'the' in a 5-sentence paragraph | expected ${theCount} | ${top(r.answers.count!)} |`);
});
const gaps: Array<[string, string, number]> = [
  ["2026-09-26", "2026-10-07", 11],
  ["2026-09-28", "2026-11-02", 35],
  ["2026-12-20", "2027-01-09", 20],
];
for (const [a, b, days] of gaps) {
  await probe(async () => {
    const options = Object.fromEntries([days - 2, days - 1, days, days + 1, days + 2].map((d) => [`d${d}`, `${d} days`]));
    const r = await jev({ from: a, to: b }, { gap: choice("How many days from the first date to the second?", options) });
    console.log(`| days ${a} -> ${b} | expected ${days} | ${top(r.answers.gap!)} |`);
  });
}
const products: Array<[number, number]> = [[23, 47], [68, 79], [125, 36]];
for (const [a, b] of products) {
  await probe(async () => {
    const right = a * b;
    const options = Object.fromEntries([right - 10, right - 1, right, right + 1, right + 10].map((v) => [`v${v}`, String(v)]));
    const r = await jev({ a, b }, { product: choice("What is a times b?", options) });
    console.log(`| ${a} x ${b} | expected ${right} | ${top(r.answers.product!)} |`);
  });
}

// 3. Latency against the number of questions ----------------------------------
section("latency against the number of questions (5 runs each)");
const line = "Jax: I'll send a follow-up email today summarizing the root cause and the fix.";
const pool = [
  choice("Is this a commitment?", { yes: "a commitment", no: "not a commitment" }),
  choice("Who speaks?", { jax: "Jax", deepa: "Deepa", other: "someone else" }),
  choice("Is money mentioned?", { yes: "money is mentioned", no: "no money" }),
  choice("Is a date or time mentioned?", { yes: "a date or time", no: "none" }),
  choice("Is a person other than the speaker named?", { yes: "yes", no: "no" }),
  choice("Is it a question?", { yes: "a question", no: "not a question" }),
  choice("Tone?", { calm: "calm", urgent: "urgent" }),
  choice("Is a ticket mentioned?", { yes: "yes", no: "no" }),
  choice("Is email mentioned?", { yes: "yes", no: "no" }),
  choice("Is a customer mentioned?", { yes: "yes", no: "no" }),
  choice("Is a deadline set?", { yes: "yes", no: "no" }),
  choice("Is anything blocked?", { yes: "yes", no: "no" }),
  choice("Language?", { en: "English", zh: "Chinese" }),
];
for (const n of [1, 4, 8, 13]) {
  const questions = Object.fromEntries(pool.slice(0, n).map((q, i) => [`q${i}`, q]));
  const times: number[] = [];
  let tokens = 0;
  for (let run = 0; run < 5; run++) {
    await probe(async () => {
      const r = await jev({ line }, questions);
      times.push(r.ms / r.attempts);
      tokens = r.inputTokens;
    });
  }
  console.log(`| ${n} question(s) | median ${median(times)} ms | ${tokens} input tokens |`);
}

// 4. State size ----------------------------------------------------------------
section("latency and answer against the size of the state");
const filler = Array.from({ length: 40 }, (_, i) => `Speaker${i % 5}: We discussed item ${i} of the backlog and agreed to revisit it later.`);
const kindQ = { kind: choice("Is the last line a commitment to send an email?", { yes: "yes, it promises an email", no: "no" }) };
for (const size of [0, 3, 10, 40]) {
  const times: number[] = [];
  let answer = "";
  let tokens = 0;
  for (let run = 0; run < 3; run++) {
    await probe(async () => {
      const r = await jev({ earlierLines: filler.slice(0, size), line }, kindQ);
      times.push(r.ms / r.attempts);
      answer = top(r.answers.kind!);
      tokens = r.inputTokens;
    });
  }
  console.log(`| ${size} earlier lines | median ${median(times)} ms | ${tokens} input tokens | ${answer} |`);
}

// 5. Repeatability -------------------------------------------------------------
section("repeatability: the same ambiguous question 10 times");
const ambiguous = "Deepa: I'll ping you if the ticket status changes.";
const seen: string[] = [];
for (let run = 0; run < 10; run++) {
  await probe(async () => {
  const r = await jev({ line: ambiguous }, { kind: choice("What is this line?", { none: "not a commitment", message: "a promise to send someone a chat message with specific content", ticket: "a promise to open a ticket" }) });
  seen.push(top(r.answers.kind!));
  });
}
console.log(seen.join(" · "));

// 6. Chinese -------------------------------------------------------------------
section("Chinese lines, English options");
const zh: Array<[string, string]> = [
  ["Jax：我今天会发一封跟进邮件，把根因和修复方案写清楚。", "email_draft"],
  ["Deepa：我去给 Ben 开个工单，先把消费延迟的告警加上。", "ticket_draft"],
  ["Marcus：我打算给他们下季度的服务费打八折。", "escalation"],
  ["Owen：上次二月那个 Kafka 位点问题，是不是跟这次一样？", "answer_question"],
  ["Priya：我们也许以后可以考虑重写整个服务。", "none"],
  ["Jax：下周二我们再约个时间对一下，我来发邀请。", "calendar_draft"],
  ["Deepa：值班的人手不够，我们得再招一个后端工程师。", "hiring_request"],
  ["Morgan：好的，没问题。", "none"],
];
let zhRight = 0;
const kinds = {
  none: "not a commitment: discussion, an idea, small talk",
  answer_question: "a direct question about a past fact in company records",
  email_draft: "a promise to send an email",
  calendar_draft: "a commitment to set up a meeting invite",
  ticket_draft: "a commitment to open a ticket",
  hiring_request: "says the company needs to hire someone",
  escalation: "offers money: a discount, refund, credit or payment",
};
for (const [text, expected] of zh) {
  await probe(async () => {
    const r = await jev({ line: text }, { kind: choice("What is this meeting line?", kinds) });
    if (r.answers.kind!.choice === expected) zhRight++;
    console.log(`| ${text} | expected ${expected} | ${top(r.answers.kind!)} |`);
  });
}
console.log(`\nChinese: ${zhRight}/${zh.length}`);

// 7. Negated question ------------------------------------------------------------
section("the same fact asked plainly and negated");
for (const text of ["Jax: I'll send the follow-up email today.", "Priya: Maybe we could rewrite the service someday."]) {
  await probe(async () => {
  const plain = await jev({ line: text }, { q: { type: "boolean", instructions: "Is this line a commitment to do something?" } });
  const negated = await jev({ line: text }, { q: { type: "boolean", instructions: "Is this line NOT a commitment to do something?" } });
  console.log(`| ${text} | plain p=${plain.answers.q!.probability?.toFixed(2)} | negated p=${negated.answers.q!.probability?.toFixed(2)} |`);
  });
}

// 8. Cost ---------------------------------------------------------------------------
section("cost reported by the gateway");
await probe(async () => {
  const c = await jev({ line }, { kind: choice("What is this line?", kinds) });
  console.log(`one screening call: ${c.inputTokens} input tokens, gateway cost ${c.cost} USD`);
});

console.log(`\nHTTP calls ${totalCalls}, 503/429 ${total503} (${((100 * total503) / totalCalls).toFixed(1)}%)`);
