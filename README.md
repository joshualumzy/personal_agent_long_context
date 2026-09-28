# Kaki

<p align="center">
  <img src="public/assets/kaki-logo-256.png" alt="Kaki logo" width="128" />
</p>

<p align="center">
  <strong>Less digging. Less chasing. More real work.</strong><br />
  An evidence-grounded operating agent for small teams.
</p>

<p align="center">
  <a href="https://kakiai.me">Live demo</a> ·
  <a href="docs/deliverable/submission/Kaki.ai-Business-Proposal-v2.pptx">Business proposal</a> ·
  <a href="docs/deliverable/submission/Kaki-Technical-Report.pdf">Technical report</a>
</p>

Kaki helps SME employees reconstruct company context, turn meetings into reviewable follow-up, and hire when operational knowledge becomes thin. It searches before answering, cites the records it read, keeps each employee's personal working context separate from company evidence, and prepares actions without taking control away from people.

The product combines three connected workflows:

- **Know:** answer workplace questions from inspectable company records.
- **Act:** turn meeting decisions and commitments into ready-to-review drafts.
- **Grow:** detect knowledge gaps and carry them into a human-controlled recruiting workflow.

Kaki is built as a modular TypeScript application for the AWS AI Agent Global Hackathon by Stellar Ark AI.

## Why Kaki

Small teams carry the coordination load of larger organisations with fewer people to absorb it. The information usually exists, but it is scattered across chat, tickets, email, documents and meetings. Employees spend time rebuilding history, writing up promises and chasing the next step.

Kaki addresses the shared root of those problems: fragmented context.

| Recurring task | Manual friction | Business consequence |
| --- | --- | --- |
| Answer a company question | Search several systems and rebuild the history | Slow answers and decisions based on partial context |
| Follow up a meeting | Read notes, gather details, draft work and remember owners | Actions are delayed, duplicated or missed |
| Run founder-led hiring | Define criteria, search, compare and chase replies | Recruiting competes with product and customer work |

## Product

### S1 · Company context

The company context agent answers workplace questions from Company Evidence and makes every source inspectable.

- Hybrid retrieval combines exact identifiers, PostgreSQL full-text search and pgvector semantic search.
- Explicit document links and a deterministic property graph connect related records.
- Every company claim must cite a record retrieved in the current run as `[source:ID]`.
- Unsupported questions return **Insufficient Evidence** rather than a guess.
- Employees can ask what was known as of a past date without leaking later records or present-day Personal Memory.
- The signed-in employee can inspect their plan and open work for a selected day.
- A detected knowledge gap can open a draft role in Recruiting on explicit request.

### S2 · Meeting actions

The meeting workflow accepts live, replayed or uploaded transcripts, then turns decisions and commitments into typed follow-up.

- Transcript segments pass through sensitive-data and prompt-injection screening before agent processing.
- Kaki extracts decisions, questions and commitments with the verbatim words that triggered them.
- It can answer company questions during a meeting and flag conflicts with earlier decisions.
- It drafts emails, messages, calendar invites, tickets, documents, spreadsheets and hiring requests.
- Missing recipients, dates or details remain visible as unresolved instead of being guessed.
- Approval binds to the exact payload. Editing a draft requires a new approval.

### S3 · Recruiting

The recruiting workflow helps a founder define and run a search without delegating the hiring decision to a model.

- A role starts from a brief, an uploaded job description or a knowledge gap found in S1.
- The founder confirms three to six criteria before any search runs.
- Public professional profiles are assessed criterion by criterion as `yes`, `no` or `unclear`.
- Candidate tiers are assigned by deterministic code.
- Outreach remains a draft for the founder to edit and send.
- Criteria changes, accepted preferences and their reasons can persist in the founder's scoped Letta memory. Candidate records do not enter Personal Memory.

## Trust contract

Kaki's control model is intentionally narrow:

| Tier | Examples | Behaviour |
| --- | --- | --- |
| **Auto** | Read-only answers and conflict flags | May complete automatically |
| **Approval** | Email, ticket, invite, message, document or hiring draft | Waits for review of the exact payload |
| **Escalate** | Money, discounts, refunds and contracts | Requires a named human decision |
| **Blocked** | Secrets, prompt injections and disallowed content | Withheld from the model and cannot execute |

Deterministic server code assigns the tier. The model proposes content; it does not decide the permission boundary.

Kaki also uses a **zero-credential handoff**. It holds no write credentials for external workplace systems. An approved action opens prefilled in the employee's own Gmail, calendar or tracker, and the employee performs the final send or save in their authenticated session.

## Architecture

![Kaki system architecture](docs/assets/kaki-architecture.svg)

Kaki is a modular monolith. One TypeScript and Fastify service coordinates identity, retrieval, model calls, memory and the three product workflows, while PostgreSQL remains the authoritative application store.

| Layer | Implementation |
| --- | --- |
| Browser experience | Chat, daily plan, meetings, recruiting board and company graph; Server-Sent Events for live progress |
| API and identity | Fastify, HMAC-SHA256 signed sessions, scoped employee identity and sensitive-data screening |
| Agent runtime | Bounded tool loops with validated tool arguments, citation checks and response repair |
| Generation | NUS SoCLaaS Qwen 3.8 27B for development and evaluation; Claude Sonnet 4.5 through the configured gateway for deployment |
| Company knowledge | PostgreSQL 16, pgvector and Amazon Titan Text Embeddings V2 |
| Personal Memory | Letta App Server, isolated per employee |
| Optional services | Jev for calibrated decisions, Cognee for per-question emergent graphs, local Whisper or live ASR, Exa and Google integrations |

### Evidence and memory stay separate

- **Company Evidence** is an employee-visible company record retrieved to support an answer. It is citable.
- **Personal Memory** is employee-specific working context retained across interactions. It can shape an answer but is never cited as company fact.
- **Conversation history** supports follow-up questions within a chat.
- **Planner projections** and approved graph projections can guide the workflow but do not satisfy the evidence requirement on their own.

### Company data boundary

The current MVP source of truth declares 4,988 employee-visible artifacts across 12 workplace record types. The recorded submission run used 4,966 records. Both are synthetic OrgForge data, not real SME production data.

Raw OrgForge simulator events, expected answers, scores and other Evaluation Oracle data are excluded from runtime retrieval, embeddings and citations. Oracle data may support offline evaluation or approved deterministic projections, but the runtime agent cannot read or cite it.

## How the context agent answers

1. Resolve the signed-in employee and screen the request.
2. Load recent conversation turns and that employee's Personal Memory as context only.
3. Search Company Evidence with date and record-type filters.
4. Follow links only from already retrieved records.
5. Draft an answer from the evidence and cite sources as `[source:ID]`.
6. Validate every citation against the records retrieved in that run.
7. Repair once or return **Insufficient Evidence**.
8. Persist the trace and update Personal Memory asynchronously.

The core loop exposes typed tools rather than arbitrary code execution. Tool arguments use JSON-schema constraints, result sizes are bounded, and malformed calls are rejected.

## Evaluation

Kaki was evaluated on OrgForge's independent question set and supplementary suites committed before execution. The reported numbers are individual recorded runs, not production guarantees.

| Capability | Recorded result |
| --- | --- |
| Answer accuracy on answerable OrgForge questions | **62% (18/29)** |
| Citation integrity | **100% (29/29)** cited only records retrieved in that run |
| Insufficient-evidence honesty | **12/12** |
| Daily-plan retrieval | **10/10 days, 60/60 items** |
| Personal Memory | **17/18 checks** |
| Held-out sensitive data | **20/20 blocked, 0/10 false blocks**, with no tested secret reaching memory |
| Knowledge-gap hiring backtest | **3/3 hires** preceded by a proposal 6–7 days earlier; 5/6 proposals led to a hire or internal handover |
| Meeting actions | **23/24 actions found**, with the correct risk tier for every matched action |

More than 900 automated tests cover identity and user isolation, citations, memory behaviour, sensitive-data handling, meeting approvals, recruiting confirmation and browser behaviour. See [`docs/evaluation/`](docs/evaluation/) for recorded evaluation artifacts.

### Pilot targets

These are working assumptions to test with one team, not achieved business outcomes:

- 30% less median time to an evidence-backed answer.
- 50% less time to a reviewable meeting-action draft.
- Zero unauthorised outbound actions.
- At least 80% accuracy on the pilot company's own answerable questions.
- First useful text in under three seconds.

## Quick start

### Requirements

- Node.js 22.19 or newer
- Python 3.9 or newer
- Docker Desktop
- A NUS SoCLaaS API key
- An AWS account with Bedrock access for Titan embeddings
- Letta App Server for persistent Personal Memory

### Install

```bash
npm ci
python3 -m venv .venv
.venv/bin/pip install -r scripts/orgforge/requirements.txt
cp .env.example .env
```

Generate a session secret and add credentials to `.env`:

```bash
openssl rand -hex 32
```

Minimum configuration:

```env
HOST=127.0.0.1
PORT=3000
SESSION_SECRET=<at-least-32-characters>

DATABASE_URL=postgresql://orgforge:orgforge-local@127.0.0.1:5432/orgforge
SOCLAAS_API_KEY=...
SOCLAAS_BASE_URL=https://soclaas-api.comp.nus.edu.sg/v1
SOCLAAS_COMPANY_MODEL=qwen3.8:27b

LETTA_APP_SERVER_URL=http://127.0.0.1:4500
LETTA_QWEN_MODEL=openai-compatible/qwen3.8:27b

EMBEDDINGS_PROVIDER=bedrock
EMBEDDINGS_MODEL=amazon.titan-embed-text-v2:0
AWS_REGION=ap-southeast-2
AWS_PROFILE=sme-agent
BEDROCK_EMBEDDING_BUDGET_USD=5
```

The browser never receives server credentials. Keep `.env`, `.venv/`, generated role state and local memory out of version control.

### Prepare the company knowledge base

```bash
# Start PostgreSQL and apply all migrations
npm run db:up
npm run db:migrate

# Ingest employee-visible OrgForge records
npm run orgforge:ingest

# Build approved planner projections
npm run orgforge:timeline

# Authenticate AWS, then embed the corpus
aws login --profile sme-agent
npm run orgforge:embed
```

The ingestion pipeline rejects raw Evaluation Oracle records. `npm run test:orgforge` verifies that boundary.

### Run Kaki

```bash
# Terminal 1: Personal Memory
npm run letta:server

# Terminal 2: application
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

| Surface | Route |
| --- | --- |
| Company context and chat | `/` |
| Company and evidence graph | `/graph` |
| Meeting actions | `/meetings` |
| Recruiting | `/recruiting` |

The primary demo personas are Jax, Priya, Chloe, Marcus and Deepa. The local demo password is `password`.

### Optional integrations

The core company context workflow requires SoCLaaS, PostgreSQL, Bedrock embeddings and Letta. Additional environment variables in [`.env.example`](.env.example) enable:

- Claude Sonnet 4.5 through the configured LLM gateway.
- Exa public-profile search, with sample profiles as the recruiting fallback.
- Hunter and Prospeo work-email lookup. Kaki never guesses an email address.
- Read-only Gmail and Calendar access for replies, contacts and free/busy checks.
- Google or Microsoft zero-credential handoffs.
- Jev decision support for meeting dates and decision conflicts.
- Cognee emergent-graph extraction.
- Local Whisper or configured live speech recognition.

## Verification

```bash
# TypeScript
npm run typecheck

# Full automated test suite
npm test

# Browser rendering and interaction checks
npm run test:browser

# Oracle isolation
npm run test:orgforge

# Meeting evaluation
npm run eval:meetings:dry
npm run eval:meetings

# OrgForge answer evaluation
npm run eval:orgforge

# Recruiting evaluation
npm run eval:recruiting
```

The standard verification gate for structural or logic changes is:

```bash
npm run typecheck
npm test
npm run test:browser
```

## Repository map

```text
public/                  Browser application and product surfaces
src/                     Fastify server, agent loop and adapters
src/meetings/            Meeting action workflow and policy
src/recruiting/          Recruiting workflow and integrations
database/migrations/     Authoritative PostgreSQL schema
orgforge_kb/             Offline graph and planner builders
scripts/orgforge/        OrgForge ingestion and isolation checks
eval/                    Evaluation datasets and runners
docs/evaluation/         Recorded evaluation outputs
docs/assets/             Architecture and reasoning-loop diagrams
docs/deliverable/        Submission materials
skills/                  Dynamically loaded agent skills
```

## Current scope and roadmap

The current system demonstrates its workflows on synthetic OrgForge company data. It does not claim validation on real SME data, production-grade authorisation, complete prompt-injection resistance or realised time and revenue savings.

The proposed rollout is deliberately staged:

1. **Pilot:** read connectors for one SME, single sign-on, per-document retrieval permissions and measured time savings.
2. **Team rollout:** managed multi-tenant memory, durable queues, broader sourcing connectors and employee-visible memory controls.
3. **Trusted actions:** company-approved delegated writes with role-based access control, while consequential actions retain human approval.
4. **More SME functions:** extend the same evidence, memory and control contract to customer support, finance operations and onboarding.

The contract stays constant: retrieve evidence, separate memory, prepare typed actions and keep risk-proportionate human control.

## Source of truth

- [`docs/mvp.md`](docs/mvp.md) defines the current MVP boundary.
- [`CONTEXT.md`](CONTEXT.md) defines the domain language.
- [`GEMINI.md`](GEMINI.md) lists the active runtime surface and verification commands.
- [`Kaki.ai-Business-Proposal-v2.pptx`](docs/deliverable/submission/Kaki.ai-Business-Proposal-v2.pptx) is the latest business proposal.
- [`Kaki-Technical-Report.pdf`](docs/deliverable/submission/Kaki-Technical-Report.pdf) is the latest technical report.
