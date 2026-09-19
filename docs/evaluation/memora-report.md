# Memora evaluation: native Letta Memory

Run `weekly-2026-09-20`, started 2026-09-19T17:21:18.300Z, finished 2026-09-19T18:10:15.202Z.

This is the MVP's evaluation gate. It asks one question: is Letta-owned
Memory good enough to keep, or does the product need its own memory store?
It is not a reproduction of the published Memora results and must not be
read as one.

## What was run

- Dataset: `geniesinc/Memora` at commit `a6493188efc836d6511ed5e4163fe3ba87da30ff`, `weekly` split, used as released and not regenerated.
- Timelines: `software_engineer`, `academic_researcher`, each against its own user identifier and therefore its own Letta agent and Memory.
- Questions: 20.
- Agent model: `openai-compatible/qwen3.8:27b`; Letta Agent SDK `0.8.12`, Letta Code `0.32.13`.
- Grader: `qwen3.6:35b`, 1 judge at temperature 0.
- Transcript grouping: one Transcript per persona day, split at 20000 characters.

## Selection

The weekly split is the shortest published horizon and fits the compute budget. Within each persona every question that carries forgetting_absence criteria is selected, because such criteria exist only where the timeline added something and later updated or deleted it.

Selected question identifiers:

- `software_engineer`: `activity_calendar_163`, `activity_todos_163`, `content_email_writeup_163_email_writeup_1`, `content_meeting_notes_163_meeting_notes_2`, `content_project_proposal_163_project_proposal_1`, `pref_books_general_163`, `pref_movies_general_163`, `pref_movies_genres_163`, `pref_music_general_163`, `pref_travel_general_163`
- `academic_researcher`: `activity_todos_158`, `content_email_writeup_158_email_writeup_1`, `content_meeting_notes_158_meeting_notes_2`, `content_project_proposal_158_project_proposal_1`, `content_project_proposal_158_project_proposal_2`, `pref_books_general_158`, `pref_books_topics_158`, `pref_movies_general_158`, `pref_music_general_158`, `pref_travel_general_158`

## Results

| Scope | Questions | MPA | FAA | FAMA |
| --- | --- | --- | --- | --- |
| All | 20 | 89.2 | 80.8 | 82.8 |
| remembering | 10 | 81.7 | 75.0 | 74.9 |
| recommending | 10 | 96.7 | 86.7 | 90.7 |
| software_engineer | 10 | 84.2 | 71.7 | 75.7 |
| academic_researcher | 10 | 94.2 | 90.0 | 89.9 |

MPA is Memory Presence Accuracy, FAA is Forgetting Absence Accuracy, and
FAMA is `max(0, MPA - lambda * (1 - FAA))` with `lambda = N_forget / (N_presence + N_forget)`.
MPA and FAA are reported separately because a combined score can hide stale
memory behind correct recall.

Stale-memory violations: 10 of 55 forgetting criteria, where the answer surfaced something the timeline had updated or deleted.
Recall criteria: 71 of 79 satisfied.

## Latency and cost

- Ingestion: 40 Transcripts, median 123s, p90 231s, for 625k characters of conversation.
- Questions: median 31s, p90 102s.
- Wall clock for the whole run: 49 minutes, with the timelines ingesting concurrently against their own agents.
- Money cost: none. Inference ran on the NUS School of Computing SoCLaaS gateway, which is free for SoC users and rate limited rather than billed.
- The practical constraint is wall clock, not money. Ingestion dominates it, because every Transcript is an agent turn that reads and rewrites Memory.

## Verdict

Native Letta Memory is adequate for the MVP. Keep it, and do not build an application-owned memory store.

## Failures worth naming

### `activity_todos_163` (FAMA 0.0)

- Question: What tasks remain on my todo list this week?
- Answer: My durable memory notes that you use the assistant to maintain a personal to-do list (adding and removing tasks), but I kept the individual tasks as one-off transients — logged for provenance, not recorded as durable current facts. So I don't have a reliable current list of what remains this week, and I'd be guessing to name specific tasks. If you'd like, I can start recording standing to-do items
- MPA 0.0, FAA 100.0
- Correlation `c2b900dd-3b4c-48db-ad89-4c9b0dc75ad8`, run `local-run-228`

### `content_project_proposal_163_project_proposal_1` (FAMA 41.7)

- Question: Write a project proposal for 'Real-Time Order Orchestration Engine with Intelligent Routing'
- Answer: # Real-Time Order Orchestration Engine with Intelligent Routing **Project proposal** ## Overview A high-performance microservices architecture for real-time driver assignment with ML-based predictions, built to handle peak traffic across North American markets. The engine orchestrates order-to-driver matching in real time, using machine-learning predictions to optimize routing under load. ## Objec
- MPA 66.7, FAA 0.0
- Correlation `e42e8355-1f00-496c-bdd5-d663b50d7112`, run `local-run-235`

### `pref_books_general_158` (FAMA 66.7)

- Question: What book would you recommend?
- Answer: Retained memory doesn't contain a specific book title I can recommend to you, so I won't guess at one. What it does record about your current taste: - **Books (current as of 2025-06-07):** lately drawn to **tragedy** (a shift away from social-dynamics books). - **Book genres (current as of 2025-06-03):** more drawn to **contemporary fiction**, less to modernism. - **Author affinity:** a big fan of
- MPA 66.7, FAA 100.0
- Correlation `9a0b0483-46ea-46aa-9d91-623fbb73fd55`, run `local-run-248`

### `content_meeting_notes_163_meeting_notes_2` (FAMA 75.0)

- Question: Write meeting notes for: Accessibility Compliance Review for VR Navigation Module
- Answer: # Accessibility Compliance Review — VR Navigation Module **Meeting notes** **Agenda / items reviewed** - Performance bottlenecks in the assistive-technology API layer. - Screen-reader compatibility with the AR overlay rendering pipeline. **Decisions** - Defer voice-command integration to the next cycle (resource constraints). - Adopt WebXR accessibility extensions as the primary framework for spat
- MPA 75.0, FAA 100.0
- Correlation `72fc2be9-756d-4f11-8a95-a118efef8487`, run `local-run-234`

### `pref_music_general_163` (FAMA 75.0)

- Question: What music would you recommend?
- Answer: Here's what I have on your music taste right now: you're leaning **upbeat electronic** (you've outgrown Bonobo's downtempo/trip-hop), you **love deep house** now, and you prefer **melodic structure and variety** over the overly experimental / repetitive end (the Autechre *Tri Repetae* reaction). So I'd aim for the melodic, varied middle of electronic and house: **Upbeat + melodic electronic** - **
- MPA 100.0, FAA 50.0
- Correlation `8d6daa8e-b1b6-4778-94fc-eff0ca32e2f9`, run `local-run-249`

## Deviations from the published protocol

- One judge, not three with a majority vote.
- A declared subset of one split, not the full 600-question benchmark.
- Conversations are grouped into dated Transcripts, because the product's unit is a Transcript rather than a chat session.
- Both speakers' turns are submitted as the Transcript text.

Operation labels, `share_memory` flags, memory evidence, forgetting evidence,
and expected answers never reach the agent. They are read by
`eval/memora/dataset.ts` and used only by the grader.

## Reproducing

See `docs/evaluation/README.md`. The raw run, including every answer,
correlation identifier, and judged criterion, is in `memora-run-weekly-2026-09-20.json`.

