# SME Employee Context Agent

A read-only personal workplace agent that helps SME employees reconstruct context across fragmented company artifacts. Sprint 1 imports the synthetic OrgForge corpus, lets a live SoCLaaS model search and follow artifact relationships, and returns answers with inspectable citations.

See [`docs/mvp.md`](docs/mvp.md) for authoritative scope and [`CONTEXT.md`](CONTEXT.md) for domain language.

## Requirements

- Node.js 22.19 or newer
- Python 3.9 or newer
- Docker Desktop
- A SoCLaaS API key; for hybrid retrieval, an AWS account with Amazon Bedrock access

## Configure

```bash
npm ci
python3 -m venv .venv
.venv/bin/pip install -r scripts/orgforge/requirements.txt
cp .env.example .env
```

Add your secret only to `.env`:

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

The browser never receives these values. `.env` and `.venv/` are ignored by Git.

## Start the database and ingest OrgForge

```bash
npm run db:up
npm run db:migrate
npm run orgforge:ingest
npm run orgforge:embed
```

For hybrid retrieval, authenticate the AWS CLI profile before embedding or running the app:

```bash
aws login --profile sme-agent
export AWS_PROFILE=sme-agent
```

The importer admits only declared employee-visible artifact types. It rejects simulation events, configuration, supplemental oracle files, and other non-runtime records.

## Run

```bash
npm run dev
```

Open [http://127.0.0.1:3000/sme](http://127.0.0.1:3000/sme).

The prior transcript/Letta prototype remains available at the root page while the SME workflow is being validated. Its Memora results apply only to that earlier prototype.

## Verify

```bash
npm run typecheck
npm test
```

The existing suite remains model-free. The SME question workflow deliberately has no simulated-model mode: model-dependent verification calls the configured SoCLaaS endpoint.

To verify oracle isolation locally:

```bash
docker compose exec -T database psql -U orgforge -d orgforge \
  -c "SELECT count(*) FROM source_documents WHERE source_id LIKE 'EVT-%' OR source_type NOT IN ('confluence', 'datadog_alert', 'email', 'invoice', 'jira', 'nps_survey', 'pr', 'sf_account', 'sf_opp', 'slack', 'zd_ticket', 'zoom_transcript');"
```

The result must be zero.

## Current limitations

- Retrieval fuses PostgreSQL full-text and pgvector semantic rankings, then follows explicit OrgForge links.
- The demonstration employee is fixed to Jax.
- Production authentication and per-department authorization are not implemented.
- Live answers remain model-dependent; the configured-key path has been smoke-tested locally.
- No workplace write action is executed in Sprint 1.
