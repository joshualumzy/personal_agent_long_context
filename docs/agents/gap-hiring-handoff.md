# Handoff: knowledge gaps → hiring proposals

When a knowledge domain is at risk, the system proposes a hire, with its reasons and evidence. Anyone signed in can open a draft role from a proposal. Nothing is confirmed, searched or sent without a person doing it in Hiring. The work was done as map + T1–T8 (`docs/agents/gap-hiring-issues.md`); the rules are in `docs/mvp.md`, "Knowledge gaps and hiring proposals".

## Run it

```bash
npm run db:migrate                                   # adds 020 employee_roster, 021 domain_owner_history
.venv/bin/python orgforge_kb/build_timeline.py       # fills them, with the planner tables
npm test                                             # gap-boundary, domain-health, hiring-proposals, gap-proposals, sme-browser
TEST_DATABASE_URL=$DATABASE_URL npm test             # also the real-corpus checks in test/gap-hiring.test.ts
```

Offline only. Nothing at runtime calls these:

```bash
npm run orgforge:gap-truth       # eval/orgforge/gap-truth.json, the answer key from OrgForge's own gap record
npm run backtest:hiring          # docs/evaluation/hiring-backtest.md
npm run eval:gap-contamination   # docs/evaluation/gap-contamination.md
```

The server keeps what people did with proposals (opened a role, dismissed) in `data/gap-proposals.json` (`GAP_PROPOSALS_PATH`).

## How it works

| Layer | File | What it does |
|---|---|---|
| Projections | `020_employee_roster.sql`, `021_domain_owner_history.sql`, `build_timeline.py` | Who was employed on which day (no reason for leaving). Who owned each domain from which day: registry former and current owner, recorded hand-overs, and join and leave days. |
| Health | `src/domain-health.ts`, `PostgresCompanyKnowledge.domainHealth(D)` | Per domain on D: the owner and whether they are still here, how many domains they hold, people who worked on it in the 30 days to D, incidents, and citable evidence dated no later than D. Cached per day. |
| Rules | `src/hiring-proposals.ts` | **orphaned**: the owner is gone for 2+ working days. **thin**: a full 30-day window with ≤ 25% of the median domain's contributors. **overloaded**: the owner holds 3+ domains and this one had 2+ incidents. A proposal opens the first day a rule holds and closes the first day none does; its id is `domain@openedOn`. |
| Actions | `src/gap-hiring.ts` | Lists what is open on D with its status; opens a draft role through the recruiting board, recording the proposal as `role.origin`; dismisses. While a role opened from a proposal exists, no other proposal is shown for that domain. |
| Routes | `src/http-app.ts` | `GET /api/v1/gaps/health`, `GET /api/v1/gaps/proposals`, `POST …/:id/open-role`, `POST …/:id/dismiss`. Any signed-in employee. |
| Agent | `src/soclaas-company-agent.ts` | `hiring_proposals` (read-only; evidence becomes citable) and `open_role_from_gap` (only when explicitly asked; the recruiting skill says so). |
| UI | `public/app.js`, `index.html`, `styles.css`; `public/recruiting.*` | "Knowledge gaps" tab in the Today panel, following the date picker. Hiring shows "Opened from a knowledge gap". See `docs/agents/gap-hiring-ui.md` for moving it into the new layout. |

## Results

**Backtest** (`docs/evaluation/hiring-backtest.md`):
- All 3 hires inside the record were preceded by a proposal for a domain they brought, by 6–7 days.
- There were 6 proposals in 60 days: 3 were followed by a hire, 2 by an internal hand-over, and 1 by neither.
- The sample is small, and the thin threshold was chosen on this corpus.

**Contamination check** (`docs/evaluation/gap-contamination.md`):
- Scope: the 17 benchmark questions built on gap and hire events, each checked on its own day and on the present, 34 checks in all.
- **Simulator-only fields or labels in the tool payload: 0.**
- **Present day:** no proposal is open on the last day (2026-03-25), which is when the benchmark runs by default. So there the feature adds nothing to those answers.
- **One ground-truth artifact surfaced that plain search missed:** on 2026-01-06, the TitanDB proposal's evidence includes CONF-ENG-041, which is the page in `counterfactual_neg_EVT-4…_doc_gap_detected`. It is an ordinary employee-visible page, cited as work on TitanDB. The question's answer (would the incident still have happened) is not in the payload.
- **No model was run:** the model endpoints are not reachable from where this ran, so the check covers what the tool hands the model, not the answers. Running `npm run eval:orgforge` on those 17 questions with and without `gapHiring` is the remaining step.

**Browser demo** (real app, adapter, agent and recruiting code against the corpus; only the models scripted):
1. **2026-01-02, TitanDB proposed.** The reason shown: "Bill, who owned TitanDB, left on 2024-06-01, and nobody has taken it on for 2 working days." "Open role" gave `/recruiting?role=…`. There, "Backend engineer, TitanDB" sits at draft criteria, "Opened from a knowledge gap: TitanDB" is shown with its reasons and evidence, and **0 searches ran**.
2. **2026-02-17, Morgan's last day.** terraform-infra (3 people against 24) and kubernetes-deploy (6 against 24) are proposed. The kubernetes-deploy proposal gains the orphaned reason the next day, because of the 2-day rule.
3. **The present, Taylor (not a manager), phone width.** Taylor sees the same list: the TitanDB role from step 1 marked "Role opened". No horizontal overflow and no page errors.

## Known limits and next steps

- **Existing graph leak, not fixed here.** `build_graph.py` copies a domain's `documentation_coverage` and `is_genesis_gap` into graph node props, which the graph pages show. The new code never reads them (`test/gap-boundary.test.ts`), but the graph should drop them.
- **terraform-infra is never orphaned.** Priya, the registry's current owner, takes it on the day Morgan leaves, because no hand-over is recorded; only the thin rule catches it.
- **Early days.** The first 29 working days cannot trigger the thin rule, because they have no full window.
- **The ledger is a JSON file.** Move it to Postgres if more than one server runs.
- **Moving the UI.** Placing the UI in the new layout (the "Hiring" entry or "Needs you") is for whoever merges the redesign.
