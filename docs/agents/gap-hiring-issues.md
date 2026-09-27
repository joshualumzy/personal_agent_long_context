# Issue drafts: knowledge gaps → hiring proposals

Map + 8 tickets, in the format `scripts/create_issues.sh` reads:

    scripts/create_issues.sh docs/agents/gap-hiring-issues.md

---

## MAP — 知识缺口 → 招聘提议（领域健康度驱动的 recruiting）

**Goal.** When a knowledge domain is at risk — its owner is gone, one person holds too many domains, nobody is actively working in it, or incidents keep landing in it — the system writes a hiring proposal with its reasons and evidence. Anyone can open a role from it through the existing recruiting flow. Nothing is hired, confirmed or sent automatically.

**Decisions so far**
- **Recruiting is visible to the whole company in the MVP.** Proposals, and roles opened from them, are shown to every signed-in employee. There is no manager role yet.
- **A proposal is only a proposal.** Opening a role from it calls `recruiting_start` with a drafted description. Confirming criteria, searching and outreach stay exactly as they are today, each done by a person. Recruiting searches real profiles and sends real email, so nothing in this map may trigger either.
- **OrgForge's own gap labels stay offline.** `knowledge_gap_detected` (2,435 events), with its `gap_classification` and `detection_method`, is simulator output. 16 of the 78 benchmark questions are built on these events: 6 SILENCE on knowledge_gap_detected, 2 on employee_hired, and the async/pr/doc/involves gap and `hire_fills_knowledge_gap` counterfactuals. These records are used only to backtest the rules (T2, T5), never at runtime and never by the agent.
- **Runtime signals come from what an employee could see**, plus one approved projection: an employee roster with join and leave dates (T3). Departures are not reliably visible in artifacts. Morgan, laid off on 2026-02-17, keeps appearing as an actor until April.
- **Thresholds on the registry do not work on this corpus.** `documentation_coverage` reaches 1.0 within about a week of every departure, and `known_by` is 33–42 people for most domains. The rules are built on events and activity instead.
- Everything is as-of aware: on day D it uses nothing after D, like the planner (#23).

**What the corpus offers to test against**
- Departures: Bill (CTO, before the record), Sharon (before the record), Jordan 2026-01-16 (auth-service, redis-cache, oauth2-flow), Morgan 2026-02-17 (kubernetes-deploy, terraform-infra).
- Hires: Janice 2026-01-09 (Python, FastAPI, PostgreSQL, TitanDB), Reese 2026-02-05 (Kubernetes, Terraform, AWS), Ethan Patel 2026-02-05 (Go, Kubernetes).
- Hand-overs (`domain_ownership_claimed`, 7): Sanjay and Janice each end up owning 3 of the 10 domains.
- So "Bill's TitanDB gap → Janice" and "Morgan's k8s/terraform → Reese" are two hires a good rule should have proposed ahead of time.

**Tickets**
- [ ] T1 记录边界与决定
- [ ] T2 离线真值：从 OrgForge 抽取缺口、离职、入职、接手记录（仅回测用）
- [ ] T3 员工名册投影：入职/离职日期
- [ ] T4 领域健康度：按日期计算每个领域的风险信号
- [ ] T5 招聘提议规则 + 回测
- [ ] T6 从提议开岗：接入 recruiting_start
- [ ] T7 界面：缺口与招聘提议面板
- [ ] T8 评测污染检查、验收与 handoff

---

## T1 — 记录边界与决定

Part of #MAP

**What.** Add a "Knowledge gaps and hiring proposals" section to `docs/mvp.md` and `docs/mvp.zh-CN.md`:
- recruiting and proposals are visible company-wide in the MVP;
- proposals never confirm, search or send anything;
- `knowledge_gap_detected` and the registry's gap fields are offline-only, for backtesting;
- the roster projection (T3) is approved on the same terms as the planner projection: shown, never cited.

**Done when:** both docs are updated with the same rules, one short section each.

Estimate: 15 min.

---

## T2 — 离线真值：从 OrgForge 抽取缺口、离职、入职、接手记录（仅回测用）

Part of #MAP · Blocked by: #T1

**What.** `eval/orgforge/gap_truth.py` reads `source_documents` offline and writes `eval/orgforge/gap-truth.json`, which is not deployed. It holds:
- departures, with the domains each person held;
- hires, with their stated expertise and date;
- ownership hand-overs;
- per domain and per week: counts of gap detections by `detection_method`, and unanswered or escalated async questions.

Map the free-text `gap_domain` of async questions (e.g. "cache invalidation", "cost-tagging") to the 10 domains by the registry's `system_tags` where it matches; leave it unmapped otherwise, and report the unmapped share.

**Done when**
- The file is deterministic, and a second run gives the same bytes.
- It contains the 4 departures, 3 hires and 7 hand-overs listed on the map.
- A test asserts that no runtime table or migration reads `knowledge_gap_detected`: a grep over `src/`, `database/migrations/` and `orgforge_kb/build_*.py`.

Estimate: 1 h.

---

## T3 — 员工名册投影：入职/离职日期

Part of #MAP · Blocked by: #T1

**What.**
- Migration `020_employee_roster.sql`: `employee_roster(person, joined_on, left_on, role, department, derived_from)`. It holds no reason for leaving: a layoff is not company-wide information.
- `build_timeline.py` fills it from `employee_hired` and `employee_departed`. People present from the start get `joined_on = NULL`.
- A reader `roster(asOf)` returns who was employed on D.

**Done when**
- On 2026-02-16 Morgan is employed; on 2026-02-17 he is not.
- Jordan leaves on 2026-01-16; Janice joins on 2026-01-09.
- The planner and existing tests are unchanged.

Estimate: 45 min.

---

## T4 — 领域健康度：按日期计算每个领域的风险信号

Part of #MAP · Blocked by: #T3

**What.** `src/domain-health.ts` plus an adapter query. For each domain on day D, compute:

| Signal | From |
|---|---|
| `owner`, `ownerActive` | owns_domain edges and hand-overs up to D, checked against the roster on D |
| `ownerLoad` | how many domains that owner holds on D |
| `activeContributors30d` | distinct people on tickets, PRs, pages or incidents about the domain (about_domain / updates_domain edges) in the 30 days before D, only people employed on D |
| `incidents30d` | incidents about the domain in the 30 days before D |
| `evidence` | citable artifact ids behind each signal |

`GET /api/v1/gaps/health?asOf` returns all domains, and any signed-in employee can read it. It reads only projections and graph edges that were built from visible artifacts. It never reads `knowledge_gap_detected`.

**Done when**
- On 2026-02-17 kubernetes-deploy and terraform-infra show `ownerActive: false`.
- On 2026-01-02 TitanDB's owner is not an employee, because Bill left before the record.
- Every signal carries evidence ids that open in the source dialog.
- A leakage test shows that nothing dated after D contributes.

Estimate: 1.5 h.

---

## T5 — 招聘提议规则 + 回测

Part of #MAP · Blocked by: #T2, #T4

**What.**
- `src/hiring-proposals.ts`: rules over T4's signals produce proposals with `{domain, reasons[], evidence[], suggestedTitle, suggestedDescription, openedOn}`. Starting rules, to be tuned by the backtest:
  - **Orphaned:** the owner is no longer employed.
  - **Overloaded:** the owner holds ≥ 3 domains and the domain had ≥ 2 incidents in 30 days.
  - **Thin:** ≤ 1 active contributor in 30 days and ≥ 1 incident.
- A proposal stays open until a role is opened from it, it is dismissed, or its reasons no longer hold.
- `scripts/backtest-hiring.ts` runs the rules on every working day and compares them with `gap-truth.json`:
  - did a proposal precede each real hire in the matching domain, and by how many days?
  - how many proposals had no matching hire (false positives)?
- The suggested description is written from the domain's `system_tags`, its department and the reasons. It uses no LLM, so it is deterministic.

**Done when**
- The backtest report is committed (`docs/evaluation/hiring-backtest.md`), with the thresholds chosen and why.
- It proposes TitanDB before Janice's hire on 2026-01-09, and kubernetes-deploy/terraform-infra no later than 2026-02-17. If a rule cannot, the report says why rather than the rule being bent to fit.

Estimate: 1.5 h.

---

## T6 — 从提议开岗：接入 recruiting_start

Part of #MAP · Blocked by: #T5

**What.**
- `POST /api/v1/gaps/proposals/:id/open-role`: calls the recruiting service's start with the suggested description. The new role records its origin `{proposalId, domain, reasons, evidence}`, and the criteria panel shows "Opened from a knowledge gap: …" with links to the evidence.
- `POST /api/v1/gaps/proposals/:id/dismiss` takes an optional reason.
- No duplicates: while a domain has an open role, no new proposal is made for it.
- The agent gets a read-only tool, `hiring_proposals`, so "我们缺什么人？" can be answered with citations. The recruiting skill says to offer opening a role and never to open one without being asked.
- Only a person's click or explicit request opens a role. Criteria confirmation, search and outreach are unchanged.

**Done when**
- Route tests cover opening, dismissing, and no duplicates.
- A test shows that opening a role runs no search and sends nothing: the role stays in draft criteria.
- Agent tests show the tool is offered and read-only.

Estimate: 1 h.

---

## T7 — 界面：缺口与招聘提议面板

Part of #MAP · Blocked by: #T6

**What.** A "Knowledge gaps" section: a tab in the Today panel, or a page linked from the recruiting page, to be agreed with whoever is working on the UI. It lists open proposals with their reasons and evidence chips, and two buttons, "Open role" and "Dismiss". A small table shows every domain's health (owner, load, contributors, incidents). It follows the date picker, so on 2026-02-17 the Morgan proposals appear. Visible to every signed-in employee.

**Done when**
- Browser tests: proposals render, "Open role" leads to the new role's criteria, and a dismissed proposal disappears.
- Changing the date updates the list.
- Usable at phone width.

Estimate: 1 h.

---

## T8 — 评测污染检查、验收与 handoff

Part of #MAP · Blocked by: #T7

**What.**
- Run the OrgForge benchmark subset built on gap and hire events (the 16 questions) with the feature on and off. Confirm that answers do not gain facts only `knowledge_gap_detected` holds, such as `gap_classification`, `documented_pct` or `days_since_departure`: grep the answers and the tool results.
- Demo in a browser:
  1. On 2026-01-02, a TitanDB proposal. Open a role from it and see its criteria draft.
  2. On 2026-02-17, kubernetes-deploy and terraform-infra proposals.
  3. On 2026-03-25, a signed-in non-manager employee sees the same list.
- Write `docs/agents/gap-hiring-handoff.md`.

**Done when:** no contamination is found (or it is fixed), the demo works with no console errors, and the handoff is written.

Estimate: 1 h.
