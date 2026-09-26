# SME Employee Context Agent MVP

This document is the source of truth for the course and hackathon MVP. Earlier transcript-first code and Memora results remain in the repository as prior prototype evidence; they are not evidence for this product direction.

## Outcome

Demonstrate that an SME employee can ask a question spanning fragmented company systems and receive a concise answer supported by inspectable Company Evidence, with explicit uncertainty when evidence is insufficient, while having their personal working context tracked across sessions.

## MVP Workflow

1. Import employee-visible OrgForge Company Artifacts into PostgreSQL (4,966 records across 8 types).
2. Exclude the Evaluation Oracle by construction.
3. Authenticate the employee persona (51 colleagues, with Jax, Priya, Chloe, Marcus, Deepa pinned) and retrieve their personal context from Letta, strictly scoped to that employee.
4. Use hybrid keyword and vector retrieval over Company Evidence, followed by explicit artifact link traversal (`document_links`).
5. Run a live agent reasoning loop (via NUS SoCLaaS or AWS Bedrock) with live progress indicators and validated answer delivery over Server-Sent Events (SSE).
6. Return answers whose company factual claims cite only retrieved Company Evidence (`[source:ID]`).
7. Let the employee inspect each cited Company Artifact and inspect their separately labelled Letta Personal Memory.
8. Persist multi-turn conversations in PostgreSQL.

## Architecture

```text
Browser UI (index.html / app.js)
  │
  ├── SSE Streaming / Rest Endpoints (/api/v1/agent/chat, /questions)
  │
  ▼
Fastify Application (src/http-app.ts)
  │
  ├── Session Guard & Auth (src/auth.ts)
  │     └── HMAC-SHA256 session tokens + scrypt verification
  │
  ├── Conversation Store (src/adapters/postgres-conversations.ts)
  │     └── PostgreSQL chat threads and message history
  │
  └── Unified Agent Harness
        │
        ├── User-Scoped Personal Memory (src/adapters/letta-memory.ts)
        │     └── Letta App Server (scoped per employee_id)
        │
        └── Adaptive Chief of Staff Reasoning Loop (src/soclaas-company-agent.ts)
              ├── Model Providers: NUS SoCLaaS (Qwen) & AWS Bedrock (Claude)
              ├── Hybrid Retrieval (src/adapters/postgres-company-knowledge.ts):
              │     ├── PostgreSQL tsvector full-text search
              │     └── pgvector cosine semantic search (Titan Text Embeddings V2)
              └── Artifact Graph:
                    └── Explicit OrgForge cross-links (document_links)
```

The application is a modular monolith. PostgreSQL stores Company Evidence, chunks, explicit artifact links, conversations, and the 51-employee roster. SoCLaaS/Bedrock performs reasoning and tool selection; deterministic server code validates tools and citations during the live request.

Letta stores Personal Memory only; it never stores the OrgForge corpus. PostgreSQL with pgvector stores Company Evidence vectors alongside full-text search. The harness keeps personal-memory context visibly separate from inspectable Company Evidence and validates that company citations were retrieved in the current run.

## Runtime Data Boundary

Allowed runtime inputs are declared Company Artifact types such as Slack, Jira, Confluence, email, Zoom transcripts, pull requests, alerts, invoices, CRM artifacts, surveys, and support tickets.

The runtime database must reject:

- `sim_event` and `sim_config` rows;
- `simulation_snapshot.json`;
- `assignment_scores.parquet`;
- `domain_registry.json`;
- Datadog metric time series and any expected-answer files.

Those sources may be read only by a separate evaluation runner that cannot be called by the agent.

## MVP Acceptance Criteria

- One documented command starts PostgreSQL (`npm run db:up`) and one applies migrations (`npm run db:migrate`).
- OrgForge ingestion is repeatable and reports accepted and rejected counts (`npm run orgforge:ingest`).
- A database check finds zero Evaluation Oracle records (`npm run test:orgforge`).
- The browser asks a general company question and receives a live-model streaming response.
- The agent can use keyword search, vector search, and explicit artifact links.
- Re-running the embedding backfill is safe and records the configured model for each vector.
- The unified endpoint scopes Letta context to the active employee persona and returns Personal Memory separately from Company Evidence.
- Every returned citation was retrieved during that run and opens in the browser inspector.
- Unsupported questions produce an Insufficient Evidence response rather than invented facts.
- Existing automated tests and TypeScript checks pass without errors (`npm test`, `npm run typecheck`).

## Deferred

- Enterprise Single Sign-On (SSO) and fine-grained department-level authorization;
- Production Personal Memory correction and deletion controls;
- Proposed Action approval and execution (workplace writes like updating tickets or sending emails);
- Real live Slack, Jira, or email webhooks/integrations;
- Multi-agent orchestration and background autonomy;
- Production disaster recovery and incident-response controls.

## Claim Boundary

The MVP may claim that it retrieves across a synthetic, employee-visible company corpus and constrains answers to inspectable evidence. It must not claim validation on real SME data, production authorization, complete prompt-injection resistance, or broad reliability until those properties are separately tested.
