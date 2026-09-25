# SME Employee Context Agent

## Start here

Before planning or changing the product, read:

1. `docs/mvp.md` — MVP source of truth.
2. `CONTEXT.md` — domain language.
3. `README.md` — local commands and current configuration.

The goal is a read-only workplace agent: Jax asks a question, receives a concise answer grounded in inspectable OrgForge Company Evidence, and sees Personal Memory separately.

## Active MVP surface

- Browser: `/sme`, backed by `public/sme.*`.
- Unified endpoint: `POST /api/v1/agent/questions`.
- Company-only endpoint: `POST /api/v1/company/questions`.
- Company retrieval: `src/adapters/postgres-company-knowledge.ts`.
- SoCLaaS tool loop: `src/soclaas-company-agent.ts`.
- Personal Memory: Letta through `src/adapters/letta-memory.ts`.
- Runtime schema: `database/migrations/` only.

Keep these boundaries:

- Letta stores user-scoped Personal Memory only; never store OrgForge there.
- PostgreSQL stores Company Evidence, full-text search data, vectors, and explicit artifact links.
- Every company factual claim must cite a source retrieved in the current run.
- Personal Memory is labelled context, never Company Evidence.
- The agent is read-only; Proposed Actions and all workplace writes are deferred.
- Do not add Jev, a separate vector database, another memory product, or a BM25 service for this MVP.

## Legacy prototype

The root transcript/Letta/Memora workflow is legacy evidence, not the current product direction. Avoid using it to drive new architecture:

- `public/index.html`, `public/app.js`, `public/styles.css`
- `src/application.ts`, `src/domain.ts`, `src/prohibited-data.ts`
- `eval/memora/`, `scripts/demo-scenario.ts`, `docs/evaluation/`, `docs/evidence/`
- Root transcript routes in `src/http-app.ts`

Some shared files contain both active and legacy paths. Preserve them unless the task explicitly includes their removal. In particular, the active SME flow still uses `src/adapters/letta-memory.ts`, `src/letta-config.ts`, `src/http-app.ts`, and `src/server.ts`.

Ignore `docs/OrgForge_Database_Schema.sql` for runtime work. It is a stale reference; migrations are authoritative.

## Current gate: Bedrock embeddings

The local OrgForge import is complete and keyword retrieval works. Hybrid retrieval is pending real Bedrock verification.

- Provider: Amazon Bedrock Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`)
- Region: `ap-southeast-2`
- Local profile: `sme-agent`
- Budget preflight: `$5` in `BEDROCK_EMBEDDING_BUDGET_USD`
- Never put AWS access keys in `.env`.

When AWS account verification is complete:

```bash
aws login --profile sme-agent
export AWS_PROFILE=sme-agent
aws sts get-caller-identity
npm run orgforge:embed -- --dry-run
npm run orgforge:embed
```

If verification still returns `AccessDeniedException` saying the account is being verified, do not redesign the MVP. Wait or follow AWS's verification support instruction.

## Validation and change discipline

Run relevant checks after changes:

```bash
npm run typecheck
npm test
npm run test:orgforge
```

Run live acceptance checks only with configured credentials: Bedrock backfill, Letta App Server, SoCLaaS answer, source inspection, and an Insufficient Evidence question.

Keep claims bounded: this is a synthetic OrgForge corpus MVP, not production authorization, real-company validation, or broad reliability proof. Preserve `.env`, `.venv/`, caches, and generated files as untracked local state. Do not commit or push without the user's authorization.
