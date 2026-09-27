# Handoff: the date-view planner (#23)

Pick a simulated working day D. The signed-in employee sees their own open tickets and plan as of D, and chat answers as if it were D: nothing the system reads is later than the end of D.

Built in #24–#29 (map #23). The plan and its trade-offs are in the doc "按日期视角的计划助手：实施计划"; the decisions are in `docs/mvp.md`, "Date-view planner projection".

## Run it

```bash
npm run db:migrate                                   # adds 019_asof_projection.sql
.venv/bin/python orgforge_kb/build_graph.py          # as before
.venv/bin/python orgforge_kb/build_timeline.py       # new: day_plan_entry + work_item_state (~2s)
npm run test:timeline                                # projection unit tests (Python)
TEST_DATABASE_URL=$DATABASE_URL npm test             # as-of.test.ts' real-corpus half needs this
```

Without `TEST_DATABASE_URL` the real-corpus tests in `test/as-of.test.ts` are skipped, not failed.

## What is where

| Piece | File |
| :--- | :--- |
| Projection tables | `database/migrations/019_asof_projection.sql` |
| Projection builder + tests | `orgforge_kb/build_timeline.py`, `orgforge_kb/test_build_timeline.py` |
| The rule: resolve a day, cutoff, "Today is D" | `src/as-of.ts` |
| Dated retrieval, planner reads | `src/adapters/postgres-company-knowledge.ts` (`searchBefore`/`relatedBefore`/`sourcesBefore`, `todo`, `dayPlan`, `workingDays`, `asOf()` → `DatedCompanyKnowledge`) |
| Agent: dated knowledge, `today_todo` / `day_plan` tools | `src/soclaas-company-agent.ts` |
| Routes: `/api/v1/planner/{days,todo,day}`, chat `asOf` | `src/http-app.ts` |
| Date picker, Today panel | `public/index.html`, `public/app.js` ("The chosen day, and the Today panel"), `public/styles.css` |
| Tests | `test/as-of.test.ts`, `test/planner.test.ts`, `test/sme-browser.test.ts` ("on a chosen day") |

## The rules, as implemented

- **Day boundary is midnight UTC.** The simulation's clock is UTC (working hours 09:00–17:00 UTC; every artifact's `occurred_at` matches the day in its id in UTC). `document_date` is unreliable: off by a day for 2,333 of 3,303 slack messages. Both the filter and the projection use the UTC day of `occurred_at`.
- **Working days** are the 60 days with a department plan, 2026-01-01 to 2026-03-25. A weekend reads as the Friday before; outside the range is a 400. The last working day is "the present": the picker shows "Today" and no `asOf` is sent.
- **Evidence**: `occurred_at < cutoff`, applied inside each SQL query (not to its results). Undated artifacts are never visible on a past day. `build_timeline.py` lists the 18 that exist: 6 sprint retros and 12 datadog alerts.
- **Switched off on a past day, not half-filtered**: `relatedThroughEvents`, all graph methods (the dated view simply lacks them), the answer graph preview, the Company Graph link, reading and writing personal memory, and feeding the emergent graph.
- **A conversation's day is fixed by its first turn** and stored in its messages' metadata. Later turns keep it; one begun without a day stays without. Changing the picker away from the open conversation's day starts a new chat.
- **Planner rows are not evidence.** The agent's tools return them with a `cite` list; only the tickets fetched through the dated view become citable. A ticket raised after D can be listed but not cited.
- **Only the signed-in employee.** No person parameter anywhere; a different `userId` is a 400. Rows match the employee's `displayName` against the names in the corpus.

## Data quirks worth knowing

- A jira ticket's actor is **who raised it** (a department lead for 262 of 304), not who works on it (they agree for 65 of 352 progress events). The projection keeps that person as `reporter`. `assignee` stays empty until a progress event, a plan naming the ticket, or a reassignment names someone; those three sources never disagree.
- So leads see a long "Raised by you, not picked up" group. For example, Jax has 77 vendor tickets on 2026-03-25. The panel folds that group after five.
- 44 tickets end "In Review" and never reach Done; that is the corpus, not a bug.

## Acceptance (2026-09-27, scratch copy of the corpus, headless Chromium)

The run used the real app, real knowledge adapter and real agent code. Only the language model was scripted, so what shows is what the tools return.

1. **2026-01-15, Jax.** The panel reads "As of Thu, Jan 15, 2026", with In progress · 1 (ENG-123) and Raised by you · 19, and 3 plan items. "我今天该先做什么？" was answered from `today_todo` + `day_plan`, citing ENG-123, tagged "As of 2026-01-15", with no graph preview.
2. **ENG-112 on 2026-01-06**, while it was still open: no evidence from after the day was returned, the ticket was not found, and the answer was Insufficient Evidence. **On 2026-01-09**, after it was resolved: the ticket and CONF-ENG-054 were found and cited, with the latest evidence from 2026-01-08.
3. **2026-03-25 (the present), Taylor, on a 390px phone.** The panel starts closed and opens from the header. It shows In review · 4 and 3 plan items, with no horizontal overflow. Asking for Jax's list returned HTTP 400.

No page errors. The only console errors were the missing favicon (404) and the deliberate 400.

## Deferred (next round)

- Reminders (incidents open, joiners/leavers, unanswered questions, stale tickets), sprint board, overdue detection.
- Date-filtering the graph: `graph_edges.valid_from/valid_to`, `graph_nodes.first_seen`, and props that are only known after the fact (an incident's `root_cause`). Until then the graph stays off on a past day.
- Date-filtering personal memory (write-date on each memory) so it can be on for past days.
- Dating the 18 undated artifacts, e.g. the datadog alerts from their incident's open time.
- Manager or department view of the Today panel: out of scope by decision.
