# SME Employee Context Agent MVP

This document is the source of truth for the course and hackathon MVP. Earlier transcript-first code and Memora results remain in the repository as prior prototype evidence; they are not evidence for this product direction.

## Outcome

Demonstrate that an SME employee can ask a question spanning fragmented company systems and receive a concise answer supported by inspectable Company Evidence, with explicit uncertainty when evidence is insufficient, while having their personal working context tracked across sessions.

## MVP Workflow

1. Import employee-visible OrgForge Company Artifacts into PostgreSQL (4,988 records across 12 types).
2. Exclude raw Evaluation Oracle records from the runtime evidence, chunk, embedding, and citation surfaces.
3. Build a deterministic property-graph projection offline and deploy only its approved `graph_nodes` and `graph_edges` snapshot to the shared runtime PostgreSQL database.
4. Authenticate the employee persona (51 colleagues, with Jax, Priya, Chloe, Marcus, Deepa pinned) and retrieve their personal context from Letta, strictly scoped to that employee.
5. Use hybrid keyword and vector retrieval over Company Evidence, explicit artifact links (`document_links`), and bounded property-graph traversal.
6. Run a live agent reasoning loop (via NUS SoCLaaS or AWS Bedrock) with live progress indicators and validated answer delivery over Server-Sent Events (SSE).
7. Return answers whose company factual claims cite only retrieved Company Evidence (`[source:ID]`); graph nodes and edges may guide traversal but are not citations.
8. Let the employee inspect each cited Company Artifact, the approved graph views, and their separately labelled Letta Personal Memory.
9. Persist multi-turn conversations in PostgreSQL.

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
              └── Company Context Graph:
                    ├── Explicit OrgForge artifact cross-links (document_links)
                    └── Deterministic property graph (graph_nodes / graph_edges)
```

The application is a modular monolith. PostgreSQL stores Company Evidence, chunks, explicit artifact links, the deployed property-graph snapshot, conversations, and the 51-employee roster. SoCLaaS/Bedrock performs reasoning and tool selection; deterministic server code validates tools and citations during the live request.

Letta stores Personal Memory only; it never stores the OrgForge corpus. PostgreSQL with pgvector stores Company Evidence vectors alongside full-text search. The graph snapshot is built deterministically outside the shared runtime database and deployed as `graph_nodes` and `graph_edges`; raw graph-build inputs are not copied with it. The harness keeps Personal Memory and graph context visibly separate from inspectable Company Evidence and validates that company citations were retrieved in the current run.

## Runtime Data Boundary

Allowed runtime evidence inputs are declared Company Artifact types such as Slack, Jira, Confluence, email, Zoom transcripts, pull requests, alerts, invoices, CRM artifacts, surveys, and support tickets.

The shared runtime database may additionally contain an approved deterministic graph projection in `graph_nodes` and `graph_edges`. The projection may be built offline from structural OrgForge relationships, including simulation-event relationships and the domain and resolved-incident registries, provided that:

- only the projected nodes, edges, relationship metadata, and artifact natural keys are deployed;
- raw Oracle rows and files are not deployed with the projection;
- graph traversal returns employee-visible Company Artifacts before any result can become answer evidence; and
- graph nodes and edges never satisfy the citation requirement by themselves.

The runtime evidence store must reject:

- `sim_event` and `sim_config` rows;
- `simulation_snapshot.json`;
- `assignment_scores.parquet`;
- `domain_registry.json`;
- Datadog metric time series and any expected-answer files.

Those raw sources may be read only by the offline graph builder or a separate evaluation runner. Neither component is callable by the runtime agent. Expected answers, scores, and evaluation-only labels must never influence the deployed graph projection.

### Date-view planner projection

The date-view planner (to-do list and day plan as of a chosen simulated day) may display rows from an approved offline projection, `day_plan_entry` and `work_item_state`, built by `orgforge_kb/build_timeline.py` from daily department plans and ticket progress simulation events. The same rules as the graph projection apply: only the projected rows are deployed, never the raw `sim_event` rows, and a projected row is never Company Evidence. It may be shown to the employee and handed to the agent as planning context, but a company factual claim still cites only retrieved Company Evidence; a projected row links to citable artifacts through its `derived_from` keys where they exist, and is otherwise labelled as coming from the plan record. The planner shows only the signed-in employee's own rows.

## MVP Acceptance Criteria

- One documented command starts PostgreSQL (`npm run db:up`) and one applies migrations (`npm run db:migrate`).
- OrgForge ingestion is repeatable and reports accepted and rejected counts (`npm run orgforge:ingest`).
- Runtime retrieval, chunks, embeddings, and citations contain zero raw Evaluation Oracle records (`npm run test:orgforge`).
- Database migrations create the current `graph_nodes` and `graph_edges` schema before a graph snapshot is restored.
- Graph snapshot deployment is repeatable, preserves the existing Company Evidence embeddings, and produces zero dangling edges.
- The browser asks a general company question and receives a live-model streaming response.
- The agent can use keyword search, vector search, explicit artifact links, and bounded graph traversal.
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
