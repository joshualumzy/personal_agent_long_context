# Personal Context Agent MVP

[English](./mvp.md) | [简体中文](./mvp.zh-CN.md)

This document is the current source of truth for the course and hackathon MVP. Research notes under `docs/research/` explore broader production options; when they recommend more infrastructure than this document, this document takes precedence for the MVP.

## Outcome

Demonstrate that a personal agent can ingest deliberately submitted transcripts, retain useful context over time, apply later updates or cancellations, and answer using the user's current information without resurfacing stale information.

The same product supports two submission narratives:

- **IT5007:** a working full-stack application with meaningful backend integration, testing, documentation, and evaluation.
- **Show Me Your Agents:** an SME-relevant personal context workflow with explicit memory, safety boundaries, inspectability, and measurable results.

## Architecture

```text
Frontend
   |
Thin server-side adapter
   |
Self-hosted Letta App Server on AWS
   |
Configured model provider
```

Letta owns persistent memory in the MVP. The application does not add a separate canonical memory database, typed memory state machine, deletion ledger, or provider-neutral memory service unless evaluation demonstrates a concrete need.

The thin adapter is limited to responsibilities required at the application boundary:

- keep credentials and Letta administration away from the browser;
- accept a transcript with `user_id`, `recorded_at`, and a source identifier;
- enforce the consent attestation and basic prohibited-data gate;
- route each request to the correct Letta agent;
- expose transcript ingestion, querying, memory inspection, and evaluation traces.

Local Letta may be used during development and evaluation. AWS deployment is a delivery concern and does not change the product boundary.

## User flow

1. A demonstration user confirms the consent attestation and submits a dated transcript.
2. The adapter rejects obvious prohibited data and sends the accepted transcript to that user's Letta agent.
3. The user can inspect the context Letta retained and ask questions about it.
4. A later transcript may update or cancel earlier information.
5. The agent answers with the current information and excludes superseded information.

The MVP is transcript-first. Audio upload and transcription are stretch goals after the memory workflow works end to end.

## Evaluation gate

Memora is the first evaluation contract for native Letta memory, not the product interface.

1. Build the minimal Letta ingestion and query adapter.
2. Run approximately 15–25 mutation-heavy Memora questions covering updates, cancellations, long histories, and stale-information exclusion.
3. Keep benchmark operation labels, expected answers, and scoring evidence outside the agent input.
4. Report the applicable Memora presence and forgetting scores, plus obvious latency or cost constraints.
5. Continue with Letta-owned memory when the result is adequate for the demo. Investigate application-owned memory only when a recurring, product-relevant failure justifies it.

A complete weekly persona, the full 600-question benchmark, multiple Letta memory configurations, audio evaluation, and additional baselines are optional extensions rather than MVP gates.

## In scope

- one demonstration user, with `user_id` present on every request;
- deliberate upload of synthetic, staged-consent, or first-party transcripts;
- persistent native Letta memory;
- later updates and cancellations;
- querying and memory inspection;
- a consent attestation and basic prohibited-data filtering;
- a small, declared Memora evaluation slice;
- enough traces and screenshots to explain the system's behavior.

## Deferred

- direct Recording Necklace synchronization;
- always-on, covert, ambient, or unknown-speaker recording;
- production multi-user authentication, administration, or sharing;
- a custom memory database or explicit memory state machine;
- per-memory approve, edit, and reject workflows;
- comprehensive PII classification, sensitive-memory vaults, or verified deletion cascades;
- production-grade privacy, backup, incident-response, and cross-border governance controls;
- a full Memora reproduction or broad configuration sweep;
- audio transcription and ASR evaluation unless the core transcript workflow is already complete.

## Claim boundary

The MVP may claim that it demonstrates continuity over deliberately submitted transcripts and measures whether native Letta memory handles later updates and cancellations. It must not claim production privacy compliance, secure erasure across every system, reliable processing of ambient recordings, or validation of the complete consumer product.
