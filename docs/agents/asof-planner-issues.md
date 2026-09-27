# Issue drafts: date-view planner (tightened version, about half a day)

Map + 6 tickets. Create the map first, then replace `#MAP` in each ticket with its number;
replace `#T1`…`#T5` in the "Blocked by" lines with the actual ticket numbers.
Suggested labels: map `wayfinder:map`; tickets `wayfinder:task` + `ready-for-agent`.

Plan document: "按日期视角的计划助手：实施计划" (the "分阶段计划（收紧版）" section).

---

## MAP — 按日期视角的计划助手（as-of 日期 / 今日待办 / 日计划）

**Goal.** Pick a simulated working day D (2026-01-01 … 2026-04-11). The signed-in employee sees
their own open tickets and day plan as of D, and can ask questions in chat as if it were D.
Nothing the system reads may be later than the end of D.

**Decisions so far**
- Simulation events (`dept_plan_created`, ticket progress) may be **shown** in the planner as offline
  projections, but are **never cited as evidence**. Planner items link to citable sources via
  `derived_from` when one exists; otherwise they are labelled "来自计划记录".
- The "Today" panel shows **only the signed-in employee**. No manager/department view in this round.
- Day granularity only; no clock times.
- While a date is selected, features not yet date-filtered are **turned off**, not half-filtered:
  answer graph preview, company graph page, personal memory, `relatedThroughEvents`.
- Without `asOf`, behaviour is exactly as today.

**Out of scope this round:** reminders, sprint board, date-filtering the graph and node props,
date-filtering personal memory, overdue detection.

**Tickets**
- [ ] T1 记录边界决定
- [ ] T2 投影表：day_plan_entry + work_item_state
- [ ] T3 as-of 过滤：检索 + 新表
- [ ] T4 planner 接口与 agent 工具
- [ ] T5 前端：日期选择器 +「今天」面板
- [ ] T6 验收与 handoff

---

## T1 — 记录边界决定：模拟事件可在 planner 展示、不可引用

Part of #MAP

**What.** Add a short section to `docs/mvp.md` (and `docs/mvp.zh-CN.md`): offline projections built
from simulation events may be displayed by the planner; they are not runtime evidence and are never
cited. The "Today" panel is scoped to the signed-in employee.

**Done when**
- Both docs updated with the same rule, one paragraph each.
- Nothing else changes.

Estimate: 15 min.

---

## T2 — 投影表：day_plan_entry + work_item_state

Part of #MAP · Blocked by: #T1

**What.**
- Migration `019_asof_projection.sql` with two tables:
  - `day_plan_entry(person, day date, seq, title, activity_type, est_hours, collaborators text[], deferred bool, item_key null, derived_from text[])` — one row per item in each person's daily department plan.
  - `work_item_state(item_key, status, assignee, points, sprint_no, valid_from date, valid_to date null, derived_from text[])` — one row per interval in which a ticket's status and assignee held.
- `orgforge_kb/build_timeline.py`: deterministic, rebuilds both tables in full, runs after `build_graph.py`.
- Index on `sources.occurred_at`; the script reports sources with no date instead of guessing.

**Done when**
- Python tests on a small fixture: a person's day plan matches that day's `dept_plan_created` entries item for item; a ticket's status on D equals its last progress record on or before D; after a reassignment the ticket leaves the old assignee's list.
- Running the script twice gives identical tables.
- One real day checked by hand.

Estimate: 1 h.

---

## T3 — as-of 过滤：检索 + 新表

Part of #MAP · Blocked by: #T2

**What.**
- `src/as-of.ts`: `AsOf` type, parsing/validation (inside the data range; a non-working day falls back to the previous working day), and SQL fragments for sources and the two new tables.
- `search`, `related`, `sources` accept optional `asOf` and apply `occurred_at <= end of D`. Search over-fetches (×3) before filtering, then truncates.
- `relatedThroughEvents` returns nothing when `asOf` is set.

**Done when**
- Leakage test on real data: for several D, every returned source has `occurred_at <= D`.
- Canary test: for an incident resolved after D, asking about its root cause at D returns no source containing the root cause.
- Existing tests unchanged when `asOf` is absent.

Estimate: 1 h.

---

## T4 — planner 接口与 agent 工具

Part of #MAP · Blocked by: #T3

**What.**
- `GET /api/v1/planner/todo?asOf` — the signed-in employee's open tickets on D (in progress / not started).
- `GET /api/v1/planner/day?asOf` — the signed-in employee's day plan on D.
- Both require sign-in and read only the signed-in employee; no `person` parameter. 503 when not configured, like the graph routes.
- Agent tools `today_todo` and `day_plan`; `asOf` comes from the conversation, the model cannot change it.
- `/api/v1/agent/chat` accepts `asOf`, stores it on the conversation, passes it to retrieval, and adds "今天是 D，你不知道 D 之后发生的事" to the system prompt. Personal memory is not read when `asOf` is set.
- Types in `company-domain.ts`: `AsOf`, `TodoItem`, `DayPlanEntry`.

**Done when**
- Route tests: parameters passed through, other employees' data unreachable, 400 on an out-of-range date, 503 when unconfigured.
- Answers built from planner items cite only `derived_from` sources that are citable.

Estimate: 1 h.

---

## T5 — 前端：日期选择器 +「今天」面板

Part of #MAP · Blocked by: #T4

**What.**
- Date picker in the home page header: date field plus previous/next working day, with "截至 D" always visible. Stored in the URL as `?asOf=`; new conversations inherit it, existing ones keep their own.
- "Today" panel beside the chat (a tab on narrow screens) with two lists: to-do (in progress / not started) and day plan (in order, activity type, estimated hours, deferred items struck through).
- Answers show a "截至 D" badge. While a date is set, the answer graph preview is not drawn and the company graph link is hidden.
- Changing the date clears cached panel data.

**Done when**
- JSDOM/browser tests: choosing a date refreshes both lists; opening a URL with `asOf` restores it; no graph preview under answers while a date is set.
- Usable at phone width.

Estimate: 1 h.

---

## T6 — 验收与 handoff

Part of #MAP · Blocked by: #T5

**What.** Walk through the demo in a browser against the real database, then update `docs/agents/graph-handoff.md` (or a new `planner-handoff.md`) with what was built, what is switched off under a date, and what is deferred.

**Demo**
1. 2026-01-15: an engineer's to-do and day plan; ask "我今天该先做什么".
2. A day while an incident is still open: ask its root cause; the answer says it is not known yet.
3. 2026-04-01: to-do and day plan for a different employee after signing in as them.

**Done when:** all three steps work with no console errors; handoff written.

Estimate: 30 min.
