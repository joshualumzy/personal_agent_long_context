# SME Employee Context Agent

## Start here

Before planning or changing the product, read:

1. `docs/mvp.md` — MVP source of truth and architecture specifications.
2. `CONTEXT.md` — canonical domain glossary and language boundaries.
3. `README.md` — local commands, configuration, and developer quickstart.

The goal is a read-only workplace assistant: an SME employee (with a directory of 51 authentic colleagues and 1-click persona switching among Jax, Priya, Chloe, Marcus, Deepa, etc.) asks a question, receives a concise answer grounded strictly in inspectable OrgForge Company Evidence, and sees their user-scoped Personal Memory displayed separately.

---

## Active Product Surface

### Frontend Interface
- **Browser Route**: Root page `GET /` (and `GET /sme` redirects to `/`).
- **Assets**: `public/index.html`, `public/app.js`, `public/styles.css`.
- **Features**:
  - **Corporate Persona Switcher**: Seamless switching among 51 OrgForge employees (with Jax, Priya, Chloe, Marcus, Deepa pinned at the top for 1-click demo access). Switching persona switches the active Letta memory context.
  - **AI Model Selector**: Toggle between **Qwen 2.5 32B (NUS SoCLaaS)** and **Claude 3.5 Sonnet (AWS Bedrock)**.
  - **Live Progress with Validated Answer Delivery**: Low-latency SSE streaming via `POST /api/v1/agent/chat` with dynamic reasoning status indicators (*"Consulting company knowledge base…"*, *"Investigating additional company evidence…"*, *"Synthesizing answer from gathered evidence…"*, etc.) followed by authoritative validated answer delivery.
  - **Conversations Sidebar**: Persistent chat history backed by PostgreSQL (`/api/v1/conversations`).
  - **Evidence & Working Context Drawers**: Source citation inspection modal and Letta memory viewer.

### Backend Endpoints
- **Agent Chat Streaming**: `POST /api/v1/agent/chat` (SSE token stream, status events, citation metadata).
- **Unified Agent Query**: `POST /api/v1/agent/questions` (synchronous JSON response with answer, sources, and personal memory).
- **Company-Only Query**: `POST /api/v1/company/questions` (answers without personal memory injection).
- **Authentication**: `GET /api/v1/auth/personas`, `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`.
- **Conversation History**: `GET /api/v1/conversations`, `POST /api/v1/conversations`, `GET /api/v1/conversations/:id`, `DELETE /api/v1/conversations/:id`.
- **Available Models**: `GET /api/v1/models`.

### Core Modules
- **Agent Reasoning Loop**: `src/soclaas-company-agent.ts` (Adaptive Chief of Staff prompt, multi-step tool execution loop with `search_company_knowledge` and `get_related_sources`, citation gate, and repair fallback).
- **Company Retrieval**: `src/adapters/postgres-company-knowledge.ts` (PostgreSQL full-text search, pgvector cosine similarity, explicit OrgForge cross-links, employee directory).
- **Authentication & Sessions**: `src/auth.ts` (HMAC-SHA256 session tokens in cookies/headers, scrypt password verification).
- **Personal Memory Provider**: `src/adapters/letta-memory.ts` (Letta App Server integration scoped per `employee_id`).
- **Database Migrations**: `database/migrations/` (001 through 005; migrations are authoritative).

---

## Architectural Boundaries

Keep these boundaries strict:

1. **Strict Evidence Grounding**: Every company factual claim must cite a source retrieved in the current run (`[source:SOURCE_ID]`). Unsupported questions must produce an Insufficient Evidence response rather than hallucinations.
2. **Personal Memory Separation**: Letta stores user-scoped Personal Memory only; it never stores the OrgForge corpus. Personal Memory is labeled as context and is never cited as Company Evidence.
3. **Data Storage Division**: PostgreSQL stores Company Evidence, full-text indexes, vector embeddings, explicit artifact links, conversations, and the employee roster.
4. **Read-Only Operation**: The agent is strictly read-only; Proposed Actions and workplace writes (such as ticket creation or email sending) are deferred.
5. **No Unauthorized Services**: Do not add Jev, external vector databases, alternative memory services, or separate BM25 daemons.

---

## Database & OrgForge Corpus

- **4,966 Employee-Visible Artifacts**: Slack (3,303), Email (610), Confluence (479), Jira (304), Zoom transcripts (208), Pull Requests (57), Salesforce (3), Zendesk (2).
- **Oracle Exclusion**: Simulation events (`sim_event`), simulation configs (`sim_config`), evaluation benchmarks, and oracle files are strictly excluded from runtime ingestion.
- **51 Company Employees**: Populated in `employees` table with roles, departments, avatars, and password hashes (`database/migrations/005_employee_auth.sql`).
- **Embeddings**: Amazon Bedrock Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`, 1024 dimensions, region `ap-southeast-2`, budget preflight `$5`).

---

## Development & Verification Commands

```bash
# Start PostgreSQL container
npm run db:up

# Run migrations (001 to 005)
npm run db:migrate

# Ingest OrgForge dataset into PostgreSQL
npm run orgforge:ingest

# Compute Titan V2 embeddings (dry-run or live)
npm run orgforge:embed -- --dry-run
npm run orgforge:embed

# Start Letta local memory server
npm run letta:server

# Start application server with hot-reload
npm run dev

# Run full test suite (all 76 tests)
npm test

# Run browser conversational UI rendering test
npm run test:browser

# Run TypeScript typecheck
npm run typecheck

# Verify oracle isolation
npm run test:orgforge
```

---

## Discipline for AI Assistants

- Run `npm run typecheck` and `npm test` after any structural change.
- Never put raw AWS access keys or passwords in tracked files.
- Preserve `.env`, `.venv/`, caches, and generated files as untracked local state.
- Do not commit or push to Git without the user's explicit authorization.
