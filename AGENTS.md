## Agent Skills & Guidelines

### MVP Scope & Architecture Truth
Before planning or implementing product, architecture, database, or evaluation work, read:
1. `docs/mvp.md` — Current MVP source of truth and architectural boundary.
2. `GEMINI.md` — Complete active surface, runtime contracts, model providers, and verification commands.
3. `CONTEXT.md` — Canonical workplace domain language and glossary.

### Verification Discipline
Always run after making structural or logic changes:
```bash
npm run typecheck
npm test
npm run test:browser
```

### Issue Tracker
Issues are tracked in this repository’s GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage Labels
Use the five default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain Docs
This repository uses a single-context domain-doc layout. See `docs/agents/domain.md`.
