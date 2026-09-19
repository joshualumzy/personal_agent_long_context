# Memora benchmark assessment

Research date: 2026-09-19

Primary sources only:

- [Memora paper, arXiv v1](https://arxiv.org/html/2604.20006) (accepted to ACL 2026 Findings)
- [Official `geniesinc/Memora` repository](https://github.com/geniesinc/Memora), inspected at commit [`a649318`](https://github.com/geniesinc/Memora/commit/a6493188efc836d6511ed5e4163fe3ba87da30ff)
- Official repository documentation for the [dataset](https://github.com/geniesinc/Memora/blob/a6493188efc836d6511ed5e4163fe3ba87da30ff/data/README.md), [evaluation pipeline](https://github.com/geniesinc/Memora/blob/a6493188efc836d6511ed5e4163fe3ba87da30ff/evals/README.md), and [data-generation pipeline](https://github.com/geniesinc/Memora/blob/a6493188efc836d6511ed5e4163fe3ba87da30ff/data_generation/README.md)

## Current MVP decision

The current evaluation scope is defined in [`docs/mvp.md`](../mvp.md). Start with approximately 15–25 mutation-heavy questions against native Letta memory. A complete weekly persona is an optional next step; the full benchmark, multiple baselines, custom audio evaluation, and broad configuration sweeps are deferred.

The broader evaluation plan below remains useful for later development and stronger research claims, but it is not the MVP completion checklist.

## Bottom line

Memora is a strong evaluation foundation for this project’s central technical claim: a personal agent should consolidate information spread across many conversations while applying later updates and not resurfacing superseded or deleted information. It directly tests additions, revisions, deletions, long dependency chains, and current-state answers. It is much closer to the proposed product than ordinary retrieval benchmarks. [Paper §§1 and 3](https://arxiv.org/html/2604.20006#S1)

It is not an audio-ingestion benchmark. Its inputs are clean, synthetic, two-party text conversations with explicit dates and controlled memory transitions. It does not test speech recognition, diarization, noisy or implicit corrections, consent, data retention, or privacy deletion. For a broader evaluation after the MVP, use Memora unchanged as the **memory-system evaluation lane**, then add a smaller **audio/transcript lane** that measures the extra failure modes introduced before the memory system. This is an adaptation of the benchmark, not a claim that Memora itself validates the complete product.

## What Memora tests

Memora treats long-term memory as an evolving state rather than a static store. Ten synthetic professional personas interact with an assistant over weekly, monthly, and quarterly timelines. Sessions can add, update, or delete a memory, or be memory-neutral. The simulator records the memory state before and after every session, and evaluation questions are derived from those traces. [Paper §3](https://arxiv.org/html/2604.20006#S3)

### Tasks

| Task | Capability under test | Representative behavior |
| --- | --- | --- |
| Remembering | Directly retrieve and use the currently valid facts or artifacts accumulated across sessions. | Return the tasks still on a to-do list or reconstruct the current version of a document. |
| Reasoning | Combine multiple temporally distributed facts and/or compare activities against a persistent goal. | Aggregate expenses and determine remaining budget. |
| Recommending | Make a personalized suggestion from the user’s current preferences while excluding superseded preferences. | Recommend media after the user’s tastes have changed. |

All three tasks require evidence from non-contiguous sessions. The benchmark describes consolidation as the number of prior sessions relevant to a query, and mutation as the number of updates or deletions encountered before the query. [Paper §§1 and 3.5](https://arxiv.org/html/2604.20006#S3.SS5)

### Update, conflict, and cancellation coverage

- **Updates are first-class.** An update replaces an earlier value; the earlier value becomes forgetting evidence and the new value becomes the current memory.
- **Deletes are first-class.** Deleted items become forgetting evidence and should be absent from the answer.
- **Repeated change is covered.** The benchmark contains much longer update/delete chains than the comparison benchmarks: average mutation counts are 2.7, 8.8, and 14.8 for weekly, monthly, and quarterly questions, with maxima of 11, 43, and 94. [Paper Table 1](https://arxiv.org/html/2604.20006#S1.T1)
- **Long consolidation chains are covered.** The average query depends on 5.3, 17.3, and 28.4 prior sessions for weekly, monthly, and quarterly histories, with maxima of 26, 99, and 309. [Paper Table 1](https://arxiv.org/html/2604.20006#S1.T1)
- **Noise is covered in a limited way.** Memory-neutral conversations are interleaved with memory-bearing sessions so useful facts are not densely packed.
- **Conflict is controlled rather than ambiguous.** A later explicit update defines the valid state. Memora does not appear to model uncertain, implicit, or mutually contradictory claims where the system must ask for clarification.
- **Cancellation is represented through deletion, not as a separate benchmark category.** The released data contains at least one natural-language calendar deletion—“cancel my Sprint planning meeting”—encoded as `operation: "delete"`. See the official [session example](https://github.com/geniesinc/Memora/blob/a6493188efc836d6511ed5e4163fe3ba87da30ff/data/quarterly/software_engineer/conversations/session_1098.json). However, a cancellation is not guaranteed to receive its own evaluation question, so the project should add explicit create → reschedule → cancel → query cases.

That same cancellation session repeats the user’s cancellation sentence once as an assistant utterance and once as a user utterance. This is a concrete synthetic-generation artifact despite the benchmark’s validation pipeline. Screen any sessions selected for a voice demo or audio-derived test rather than converting them blindly.

Operational rules prevent impossible transitions such as updating before adding. Preference and work-content memories support add/update/delete; to-do and calendar activities support deletion; expense and step logs are primarily append-only; goals are set and updated. [Paper Appendix A.3](https://arxiv.org/html/2604.20006#A3) and [generation README](https://github.com/geniesinc/Memora/blob/a6493188efc836d6511ed5e4163fe3ba87da30ff/data_generation/README.md#memory-model)

## Input assumptions

The released benchmark assumes:

- A single synthetic persona/user per timeline, identified consistently across sessions.
- Chronologically ordered, dated sessions.
- Text dialogues between a user and an AI assistant, averaging roughly 16 turns per session.
- Memory-bearing statements expressed explicitly enough for the generated dialogue to be validated against a known operation.
- Three controlled memory families: preferences, activities, and goals. Activity includes personal tracking and work artifacts such as proposals, emails, meeting notes, and social posts.
- At query time, a direct LLM receives as much of the text history as fits its context window; older sessions are dropped when necessary. A memory agent instead ingests sessions incrementally and retrieves stored memories under the same user identifier. [Paper §§3.1, 4.1, and Appendix E](https://arxiv.org/html/2604.20006#S4.SS1)

The dataset files expose operation metadata, memory evidence, and `share_memory` flags for auditing, but the official evaluators use the conversation text as model/agent input and use the structured evidence for scoring. The [dataset schema](https://github.com/geniesinc/Memora/blob/a6493188efc836d6511ed5e4163fe3ba87da30ff/data/README.md#session-file-conversationssession_nnnnjson) documents both layers.

Important gaps for this product are audio decoding, segmentation of a long recording into sessions, speaker identity, bystander speech, transcription uncertainty, implicit or hedged changes (“maybe move it”), and cross-user memory. Memora’s authors explicitly describe the synthetic benchmark as a controlled lower bound on real-world difficulty and exclude social relationships and multi-user coordination. [Paper limitations](https://arxiv.org/html/2604.20006#S7)

## Dataset scale and composition

| Dimension | Weekly | Monthly | Quarterly |
| --- | ---: | ---: | ---: |
| Personas | 10 | 10 | 10 |
| Average sessions per persona | 155 | 615 | 1,991 |
| Average turns per session | 16.1 | 15.6 | 15.7 |
| Average memory operations per persona | 103.2 | 374.3 | 1,171.4 |
| Add / update / delete share | 68% / 13% / 19% | 63% / 16% / 21% | 63% / 18% / 19% |
| Evaluation questions | 150 | 150 | 300 |
| Evaluation criteria reported in paper | 749 | 1,421 | 4,884 |

Source: [paper Table 2](https://arxiv.org/html/2604.20006#S3.T2).

The 600 total questions are balanced by task: weekly and monthly each have 5 questions per task per persona (50 per task), and quarterly has 10 per task per persona (100 per task). Personas span researcher, executive, writer, designer, analyst, consultant, marketing, sales, software engineering, and startup-founder roles. The memory inventory includes preferences for movies/books/music/travel; activities such as tasks, schedules, expenses, fitness, proposals, email, meeting notes, and social posts; and financial/fitness goals. [Dataset README](https://github.com/geniesinc/Memora/blob/a6493188efc836d6511ed5e4163fe3ba87da30ff/data/README.md#layout) and [paper Appendix A](https://arxiv.org/html/2604.20006#A1)

For generation quality, three LLM evaluators must unanimously accept a conversation’s intended memory grounding; the authors also manually inspect 5% of generated conversations per persona and reject an affected batch if an inconsistency is found. This checks alignment to the synthetic trace, though it does not eliminate every conversational artifact. [Paper §3.3](https://arxiv.org/html/2604.20006#S3.SS3)

### Release/paper discrepancy to pin before reporting results

The released data at commit `a649318` contains 1,551 weekly, 6,150 monthly, and 19,913 quarterly session files (27,614 total), consistent with the paper’s rounded session averages. A direct count of the released evaluation sub-questions gives 735 weekly, 1,315 monthly, and 4,365 quarterly criteria, which does **not** match the paper’s 749/1,421/4,884. The question counts still match 150/150/300.

This may reflect post-paper dataset cleanup or regeneration; the official sources do not explain it. Pin the exact repository commit and report the actual criterion counts from the data used. Before claiming to reproduce Table 3, verify whether the published result files correspond to the released revision.

## Metrics

Each answer is evaluated against atomic yes/no criteria of two types:

- **Memory Presence Accuracy (MPA):** fraction of currently valid facts that the answer includes.
- **Forgetting Absence Accuracy (FAA):** fraction of invalidated/deleted facts that the answer successfully excludes.

For each question, the headline score is:

```text
FAMA = max(0, MPA - lambda * (1 - FAA))
lambda = N_forget / (N_presence + N_forget)
```

Per-question FAMA lies in `[0, 1]`; task/period results are the mean multiplied by 100. Three judges—GPT-4.1, Claude Haiku 4.5, and Gemini 2.5 Flash—score each criterion independently at temperature 0, with majority vote. The reported LLM–human agreement is 88.3%; human inter-annotator Cohen’s kappa ranges from 0.86 to 0.90. [Paper §4.2 and Appendix C](https://arxiv.org/html/2604.20006#S4.SS2)

FAMA is valuable because ordinary inclusion accuracy can reward an answer that contains the current fact while also repeating an obsolete one. It should not be used alone:

- Report MPA and FAA separately so a single combined score cannot hide stale-memory errors.
- Report a direct stale-memory violation rate for high-risk facts.
- Most reasoning questions in the release have no forgetting criteria, so `lambda = 0` and their FAMA is just MPA. [Dataset README, reasoning caveat](https://github.com/geniesinc/Memora/blob/a6493188efc836d6511ed5e4163fe3ba87da30ff/data/README.md#reasoning-task-caveat)
- FAMA evaluates answer content, not whether the memory database physically erased a record or whether the system obeyed a privacy-deletion request.

## Baselines and reported results

The paper evaluates four direct-context LLMs, each with and without reasoning tokens, and six memory agents. All memory agents use GPT-4o-mini for final answer generation. Their stores range from local ChromaDB/JSON to cloud-managed services and hybrid vector/BM25 retrieval. [Paper §§4.1 and Appendix E](https://arxiv.org/html/2604.20006#S4.SS1)

Task-level FAMA from paper Table 3 (weekly/monthly/quarterly):

| System | Remembering | Recommending | Reasoning |
| --- | --- | --- | --- |
| Qwen3-32B, no reasoning | 26.12 / 21.14 / 19.24 | 50.16 / 50.30 / 48.88 | 6.00 / 2.00 / 6.00 |
| Claude Sonnet 4.5, no reasoning | 27.50 / 19.42 / 21.25 | 43.62 / 39.00 / 44.02 | 6.66 / 3.00 / 5.50 |
| Gemini 3 Pro Preview, no reasoning | 20.36 / 21.44 / 17.28 | 45.12 / 45.94 / 52.56 | 6.66 / 4.00 / 4.00 |
| GPT-5.2, no reasoning | 25.32 / 19.92 / 23.39 | 54.80 / 51.12 / 53.36 | 4.66 / 0.00 / 1.00 |
| Qwen3-32B, reasoning | 23.86 / 25.62 / 17.14 | 50.04 / 53.06 / 47.71 | 6.66 / 9.00 / 3.00 |
| Claude Sonnet 4.5, reasoning | 26.56 / 21.40 / 19.13 | 52.40 / 60.90 / 51.78 | 4.00 / 0.00 / 2.50 |
| Gemini 3 Pro Preview, reasoning | 21.02 / 23.26 / 18.12 | 43.36 / 44.92 / 50.83 | 6.00 / 10.00 / 8.50 |
| GPT-5.2, reasoning | 25.70 / 19.22 / 22.16 | 53.40 / 51.60 / 53.36 | 4.66 / 0.00 / 2.00 |
| A-Mem | 71.82 / 41.90 / 40.78 | 35.04 / 37.52 / 34.95 | 2.00 / 2.00 / 5.00 |
| LangMem | 71.16 / 42.00 / 39.14 | 48.88 / 44.08 / 33.85 | 30.00 / 14.00 / 11.00 |
| Mem-0 | 40.42 / 21.08 / 19.90 | 52.58 / 36.20 / 38.47 | 16.00 / 0.00 / 2.00 |
| MemoBase | 43.60 / 20.08 / 15.18 | 68.94 / 58.46 / 45.62 | 18.00 / 7.00 / 1.00 |
| MemoryOS | 51.84 / 29.78 / 25.05 | 62.64 / 48.54 / 44.02 | 20.66 / 6.00 / 5.50 |
| Nemori | 65.06 / 44.08 / 33.83 | 52.84 / 45.90 / 41.66 | 18.66 / 0.00 / 6.50 |

Source: [paper Table 3](https://arxiv.org/html/2604.20006#S5.T3) and the [official repository results table](https://github.com/geniesinc/Memora#results).

Key findings:

- Explicit memory systems substantially improve remembering, but performance usually falls as the timeline lengthens.
- Direct-context LLMs remain competitive on recommendation, probably because plausible persona-aligned recommendations can receive partial credit without perfect retrieval.
- Reasoning is poor for every approach; LangMem is the strongest reported agent, yet scores only 30/14/11 across the three horizons.
- Reasoning tokens give inconsistent and generally small benefits.
- Forgetting-aware penalties grow with timeline length for memory agents, showing that keeping more stored facts without reconciling them can make stale-memory reuse worse.
- In the manual error analysis, 64% of recommendation errors involved failure to forget outdated information; 72% of remembering errors involved incomplete retrieval; all sampled reasoning errors involved incomplete retrieval. [Paper §§5–6](https://arxiv.org/html/2604.20006#S6)

These results justify a system architecture that treats mutation, supersession, and retrieval completeness as explicit mechanisms rather than assuming a vector database solves memory.

## Reproducibility assets and licensing

The official repository releases:

- All conversations and evaluation questions for every period/persona.
- The structured session/evidence schema.
- Generation code for session simulation, conversation generation, question generation, and quality checks.
- Direct-LLM and six-agent evaluators, common result schemas, aggregation scripts, requirements, `pyproject.toml`, and `uv.lock`.
- One-command examples for a single run and shell scripts for sweeps. [Repository README](https://github.com/geniesinc/Memora#quick-start-uv)

The repository and dataset are Apache-2.0 licensed; the arXiv paper is CC BY 4.0. [Repository license](https://github.com/geniesinc/Memora/blob/a6493188efc836d6511ed5e4163fe3ba87da30ff/LICENSE) and [arXiv license](https://arxiv.org/html/2604.20006#license)

Reproduction limitations:

- Exact data regeneration is not deterministic by default: the simulator does not set a random seed, and released conversations were generated with Gemini 2.5 Flash at its default temperature. The official generation README recommends adding a seed and pinning model/temperature. [Generation README, reproducibility](https://github.com/geniesinc/Memora/blob/a6493188efc836d6511ed5e4163fe3ba87da30ff/data_generation/README.md#reproducibility)
- Evaluation requires paid API access through OpenRouter; agent runs also require OpenAI and, for some systems, vendor-specific accounts. Some baselines are proprietary cloud services.
- Model versions and hosted APIs can drift, so exact score reproduction may change even with the same code.
- The repository’s criterion-count discrepancy with the paper must be resolved or transparently reported.
- The paper does not report runtime, latency, or efficiency metrics, which this product should measure separately.

The released, pinned dataset is therefore the reproducible artifact to build on; regenerating the synthetic corpus should be optional.

## Fit for this project

### Strong fit

- The project’s core scenario—state stated once, revised later, possibly cancelled, then correctly retrieved—maps directly to add/update/delete plus forgetting-aware evaluation.
- Memora covers both personal and work information, including tasks, calendar items, meeting notes, preferences, and long-term goals.
- It produces a defensible quantitative evaluation rather than a hand-picked demo.
- The memory traces support observability: the UI can show which transcript fragments created, superseded, or deleted a memory.
- The benchmark naturally supports a comparison between long-context prompting and an explicit memory store, which is useful for both the course’s technical evaluation and the hackathon’s memory/observability criteria.

### Weak fit or missing coverage

- No audio, ASR errors, speaker diarization, or long continuous recording.
- Synthetic assistant conversations are cleaner and more explicit than natural speech.
- No bystander/privacy model or consent workflow.
- No ambiguous conflict resolution; the last explicit valid operation wins.
- No relational or multi-user memory.
- “Forgetting” means not using stale semantic content, not securely deleting source audio/transcripts and every derived record.
- No latency, cost, storage growth, or deletion-completeness measurements.

## Extended evaluation plan after the MVP gate

### 1. Keep an unmodified Memora evaluation lane

Convert each session’s dialogue into the project’s transcript-ingestion contract, ingest sessions in date order, answer the released questions, and score with the official criteria. Do not use operation metadata, `share_memory`, or evidence fields as system input. Compare at least:

1. Recent-window/no persistent-memory baseline.
2. Direct long-context baseline.
3. The project’s memory system.

If budget is limited, run the full weekly set first, then a declared mutation-heavy sample from monthly and quarterly. Pin the dataset commit, random/sample seed, model IDs, prompts, and evaluator version.

### 2. Add an explicit update/cancellation suite

Create small, auditable scenarios around the intended product demo:

- Create commitment → change date/owner → ask for current commitment.
- Create event → reschedule → cancel → ask what remains scheduled.
- Express preference → reverse preference → request recommendation.
- Draft plan → amend fields across transcripts → request current summary.
- Delete something → later re-add it → ensure the newest state wins.
- Give a hedged or contradictory correction → ensure the agent asks for clarification instead of silently overwriting.

For every scenario, record the valid state and the specific facts that must be absent. Reuse Memora’s presence/absence criterion schema.

### 3. Add an audio/transcript evaluation lane

Use the same semantic scenarios in three conditions:

1. **Clean text:** the original ground-truth transcript.
2. **Synthetic audio:** text-to-speech versions of user utterances, including controlled noise and speaking-rate variants.
3. **Consented first-party audio:** short, deliberately uploaded recordings made by the user or staged participants who consent to processing.

Run audio through transcription, then the identical memory pipeline. This isolates how much quality is lost at ingestion versus memory consolidation. Store provenance such as source audio ID, time span, speaker label, ASR confidence, transcript revision, and the memory records derived from each span.

Report:

- Word error rate or character error rate, plus entity/slot accuracy for dates, names, amounts, negation, and cancellation phrases.
- Memory-operation extraction precision/recall for add/update/delete.
- MPA, FAA, FAMA, and stale-memory violation rate.
- Answer provenance accuracy: whether cited transcript spans actually support the answer.
- End-to-end latency, token/API cost, and storage growth.

Negation and correction errors deserve a dedicated slice: an ASR system dropping “not,” confusing a date, or missing “cancel” can invert the memory state even when word error rate looks acceptable.

### 4. Keep the privacy boundary explicit

For the course prototype:

- Accept only deliberate upload of synthetic, staged-consent, or first-party recordings.
- Do not implement or imply always-on/covert recording.
- Avoid real bystander conversations in the dataset and demo.
- Make audio retention configurable; delete raw audio after transcription by default if it is not needed.
- Provide user-visible deletion and trace it through raw audio, transcript, embeddings, extracted memories, caches, and backups as far as the prototype supports.
- Treat consent and Singapore recording/data-protection compliance as production risks outside the evaluated prototype, not as solved by the benchmark.

Most importantly, distinguish two commands:

- **Semantic invalidation:** “That plan is cancelled; do not use it as current truth.” The source may remain for history/audit, but retrieval must treat it as superseded.
- **Privacy deletion:** “Erase this recording and all derived data.” This requires physical deletion and cannot be demonstrated by FAMA alone.

### Recommended claim

A defensible project claim is:

> The prototype transforms deliberately submitted audio or transcripts into provenance-linked personal memories, reconciles explicit updates and cancellations over time, and is evaluated for both recall of current information and exclusion of superseded information.

Avoid claiming that Memora validates real-world always-on recording, legal compliance, or unconstrained personal assistance. It validates the memory-consolidation core under controlled text conditions; the project-specific audio and privacy tests cover the remaining MVP boundary.
