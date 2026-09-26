# SME Employee Context Agent

A read-only personal workplace assistant that helps SME employees reconstruct fragmented context across company systems. The assistant imports the synthetic OrgForge corpus into PostgreSQL, utilizes live SoCLaaS (Qwen) and AWS Bedrock (Claude) models with multi-step tool reasoning, and returns concise answers grounded in inspectable Company Evidence while tracking personal context via Letta Memory.

See [`docs/mvp.md`](docs/mvp.md) for authoritative scope and [`CONTEXT.md`](CONTEXT.md) for domain language.

---

## Key Features

- **51-Employee Corporate Directory & 1-Click Persona Switching**: Authentic OrgForge employee roster populated in PostgreSQL (`employees` table). Switch between **Jax** (Backend Eng), **Priya** (Design), **Chloe** (Product), **Marcus** (Systems), **Deepa** (Infra), or 46 other colleagues. Switching personas automatically scopes their isolated Letta memory context.
- **Dual AI Model Toggle**: Switch seamlessly between **Qwen 2.5 32B (NUS SoCLaaS)** and **Claude 3.5 Sonnet (Amazon Bedrock)** directly from the header dropdown.
- **Real-Time Token-by-Token SSE Streaming**: Low-latency token streaming (`POST /api/v1/agent/chat`) with live reasoning and tool execution badges (*"Consulting company knowledge base…"*, *"Investigating additional company evidence…"*, *"Synthesizing answer…"*, etc.).
- **Multi-Turn Persistent Chat History**: Conversations are saved and reloaded across browser sessions via PostgreSQL (`/api/v1/conversations`).
- **Inspectable Citations & Working Memory**: Click any inline `[source:CONF-ENG-239]` citation to view the exact excerpt, or open the `🧠 Working Context` drawer to inspect what Letta has retained.

---

## Requirements

- Node.js 22.19 or newer
- Python 3.9 or newer (for OrgForge dataset ingestion)
- Docker Desktop
- A SoCLaaS API key; for hybrid vector retrieval and Claude, an AWS account with Amazon Bedrock access

---

## Configure

```bash
npm ci
python3 -m venv .venv
.venv/bin/pip install -r scripts/orgforge/requirements.txt
cp .env.example .env
```

Add your credentials to `.env`:

```env
DATABASE_URL=postgresql://orgforge:orgforge-local@127.0.0.1:5432/orgforge
SOCLAAS_API_KEY=...
SOCLAAS_BASE_URL=https://soclaas-api.comp.nus.edu.sg/v1
SOCLAAS_COMPANY_MODEL=qwen3.8:27b
AWS_REGION=ap-southeast-2
EMBEDDINGS_PROVIDER=bedrock
EMBEDDINGS_MODEL=amazon.titan-embed-text-v2:0
BEDROCK_EMBEDDING_BUDGET_USD=5
```

The browser never receives server credentials. `.env` and `.venv/` are strictly ignored by Git.

---

## Start the Database and Ingest OrgForge

```bash
# Start PostgreSQL container
npm run db:up

# Run migrations (001 to 005)
npm run db:migrate

# Ingest declared employee-visible OrgForge records
npm run orgforge:ingest

# Compute Titan V2 embeddings
npm run orgforge:embed
```

For hybrid retrieval with Amazon Bedrock, authenticate the AWS CLI profile beforehand:

```bash
aws login --profile sme-agent
export AWS_PROFILE=sme-agent
```

The importer admits only declared employee-visible artifact types (Slack, Jira, Confluence, email, Zoom transcripts, PRs, alerts, invoices, CRM). It strictly rejects simulation events, configuration, supplemental oracle files, and non-runtime records.

---

## Run the Application

```bash
# 1. Start the Letta local memory server
npm run letta:server

# 2. In another terminal, start the app with hot-reload
npm run dev
```

Open **[http://127.0.0.1:3000](http://127.0.0.1:3000)** (legacy `/sme` automatically redirects to `/`).

- Default login: You can click the profile badge at the top-right header or bottom-left sidebar to switch personas. Primary demo accounts (Jax, Priya, Chloe, Marcus, Deepa) require password `password`.

---

## Verify and Test

```bash
# Typecheck TypeScript
npm run typecheck

# Run full test suite (76 automated tests)
npm test

# Run conversational browser rendering test
npm run test:browser

# Verify oracle isolation
npm run test:orgforge
```

To verify oracle isolation directly against PostgreSQL:

```bash
docker compose exec -T database psql -U orgforge -d orgforge \
  -c "SELECT count(*) FROM source_documents WHERE source_id LIKE 'EVT-%' OR source_type NOT IN ('confluence', 'datadog_alert', 'email', 'invoice', 'jira', 'nps_survey', 'pr', 'sf_account', 'sf_opp', 'slack', 'zd_ticket', 'zoom_transcript');"
```

The result must be `0`.

---

## Current Architecture Boundaries

- **Strict Evidence Grounding**: Company factual claims must cite inspectable retrieved sources.
- **Personal Memory Scoping**: Letta context is isolated per `employee_id` and presented as labeled working context, never as company evidence.
- **Read-Only Safety**: The agent is read-only; Proposed Actions (modifying Jira tickets, sending emails) are deferred to future milestones.

---

## Recruiting Direction (S3)

A hiring agent for small-company founders, built on the same Memory architecture.
- Page: `/recruiting`
- Full design record: [docs/s3-recruiting.md](docs/s3-recruiting.md).
- Test suite: `npm test` runs `test/recruiting.test.ts`.
