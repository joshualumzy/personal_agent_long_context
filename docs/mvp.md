# SME Employee Context Agent MVP

This document is the source of truth for the course and hackathon MVP. Earlier transcript-first code and Memora results remain in the repository as prior prototype evidence; they are not evidence for this product direction.

## Outcome

Demonstrate that an SME employee can ask a question spanning fragmented company systems and receive a concise answer supported by inspectable Company Evidence, with explicit uncertainty when evidence is insufficient.

## MVP workflow

1. Import employee-visible OrgForge Company Artifacts into PostgreSQL.
2. Exclude the Evaluation Oracle by construction.
3. Retrieve the demonstration user's personal context from Letta, scoped to that user.
4. Use hybrid keyword and vector retrieval over Company Evidence, then let a live SoCLaaS model follow Related Artifacts.
5. Return an answer whose company factual claims cite only retrieved Company Evidence.
6. Let the employee inspect each cited Company Artifact and see the separately labelled personal-memory context used.

## Architecture

```text
Browser
  -> Fastify application
     -> unified agent harness
        -> Letta user-scoped Personal Memory
        -> live SoCLaaS tool loop
           -> PostgreSQL hybrid keyword + vector retrieval
           -> employee-visible OrgForge artifacts only
```

The application is a modular monolith. PostgreSQL stores Company Evidence, chunks, explicit artifact links, and employee records. SoCLaaS performs reasoning and tool selection; deterministic server code validates tools and sources during the live request without retaining agent-run history.

Letta stores Personal Memory only; it never stores the OrgForge corpus. PostgreSQL with pgvector stores Company Evidence vectors alongside full-text search. The harness keeps personal-memory context visibly separate from inspectable Company Evidence and validates that company citations were retrieved in the current run.

## Runtime data boundary

Allowed runtime inputs are declared Company Artifact types such as Slack, Jira, Confluence, email, Zoom transcripts, pull requests, alerts, invoices, CRM artifacts, surveys, and support tickets.

The runtime database must reject:

- `sim_event` and `sim_config` rows;
- `simulation_snapshot.json`;
- `assignment_scores.parquet`;
- `domain_registry.json`;
- Datadog metric time series and any expected-answer files.

Those sources may be read only by a separate evaluation runner that cannot be called by the agent.

## MVP acceptance criteria

- One documented command starts PostgreSQL and one applies migrations.
- OrgForge ingestion is repeatable and reports accepted and rejected counts.
- A database check finds zero Evaluation Oracle records.
- The browser asks a general company question and receives a live-model response.
- The agent can use keyword search, vector search, and explicit artifact links.
- Re-running the embedding backfill is safe and records the configured model for each vector.
- The unified endpoint scopes Letta context to its declared user and returns Personal Memory separately from Company Evidence.
- Every returned citation was retrieved during that run and opens in the browser.
- Unsupported questions produce an Insufficient Evidence response rather than invented facts.
- Existing non-live tests and TypeScript checks continue to pass.

## Deferred

- production authentication and department-level authorization;
- production Personal Memory correction and deletion controls;
- Proposed Action approval and execution;
- real Slack, Jira, or email integrations;
- multi-agent orchestration and background autonomy;
- production privacy, backup, and incident-response controls.

## Claim boundary

The MVP may claim that it retrieves across a synthetic, employee-visible company corpus and constrains answers to inspectable evidence. It must not claim validation on real SME data, production authorization, complete prompt-injection resistance, or broad reliability until those properties are separately tested.
