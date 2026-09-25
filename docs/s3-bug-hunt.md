# S3 recruiting: bug hunt log

How this works. Each round, independent agents with fresh context hunt one
area each and must hand back an executable repro that fails. A finding
counts only after it is re-run and fails for the stated reason. Each
confirmed bug gets a regression test in `test/regression/`, written to fail
first, then the fix. Regression tests are locked by checksum
(`npm run test:lock`): a later change that weakens one breaks the lock.
Hunting stops when a full round confirms nothing new. A held-out suite
(`npm run test:holdout`), written from the design without reading the code,
runs only at the final gate.

Entries are appended, never rewritten.

## Round 1 (2026-09-26)

Four hunters (service core, routes and security, chat agent, frontend) plus
a held-out suite written from the design. Backend: 43 bugs confirmed (routes 12, core 16, chat agent 13, held-out 2 more), all
reproduced by failing tests, all fixed. Regression files:
`test/regression/r1-*.test.ts`.

Service core (`r1-core.test.ts`, guards in `r1-core-guards.test.ts`)
- A change that threw halfway left a half-edited state (confirm could not be
  retried after a failed search). Fix: every change edits a copy that
  replaces the state only after the change and the save succeed.
- Double-pressing send sent twice; sending a leftover draft reopened a closed
  candidate. Fix: send checks and sends inside one serialized change;
  closing drops the pending draft.
- An unclear reply left the "no answer yet" follow-up in place. Fix: any reply
  clears it.
- Overlapping ticks proposed the same widening twice. Fix: re-check inside
  the change.
- Retention erasing a closed person broke preference learning for good, and
  passing one person twice counted as two decisions. Fix: one decision per
  person, only people still on record.
- Two cold loads could land an older copy last. Fix: one shared load.
- An unknown model decision was treated as "pass" and closed the person.
  Fix: unknown intent instead.
- The last criterion could be removed after confirming. Fix: refused.
- Client-chosen criterion ids like "toString" matched Object.prototype and
  corrupted tiers; revised criteria could share an id. Fix: own-key lookups;
  ids are ours, a client may only keep an existing one, once.
- Legacy duplicate merging broke on chains of three and could undo a pass.
  Fix: follow the chain; the founder's decision wins.
- Two concurrent requests for a role built two services, losing an action.
  Fix: one service per role.
- A deleted role was written back by its background scoring. Fix: removing
  a role disposes its service first; a disposed service never saves.
- A model listing one person twice met the preference threshold. Fix:
  distinct ids.

Routes and security (`r1-routes.test.ts`)
- One unreadable role file broke the role list and both inboxes for every
  role. Fix: damaged files load as far as they can; unreadable roles are
  skipped, never fatal.
- A LinkedIn message was recorded in every role that contacted the person.
  Fix: one conversation goes to one role.
- Corrupt PDF or DOCX uploads answered 502 "upstream failure". Fix: 400
  "unreadable_file".
- Typed requirements were not capped (500 KB reached the model). Fix: capped
  at 8000 characters in the service, for every path.
- Non-string criterion text was stored as "[object Object]"; fast-forward
  accepted `true` and `"3"`. Fix: type checks.
- A failed Gmail code exchange was an unhandled 500; consent states never
  expired. Fix: handled; at most 50 pending.
- `RECRUITING_RESULTS_PER_QUERY=` (empty) stopped the server. Fix: empty
  means unset.

Chat agent (`r1-agent-*.test.ts`)
- A streaming request that failed after the stream began (a database blip,
  or `model: 5`) crashed the whole Node process with ERR_HTTP_HEADERS_SENT.
  Fix: every failure after the stream starts ends the stream with an error
  event.
- One malformed tool call (bad JSON, wrong type, unknown tool, missing
  argument) failed the whole turn. Fix: each call is isolated and its error
  goes back to the model.
- A recruiting model outage failed the turn. Fix: returned as a tool error.
- `recruiting_revise_criteria` with criteria as a string wiped the draft;
  `accept: "true"` declined. Fix: refused / read as a real yes or no.
- Loading any skill waived citations even for retrieved company evidence.
  Fix: relaxed only when no company evidence was retrieved.
- Panels were dropped in the insufficient-evidence fallback; a tool call on
  the last step failed the turn; an empty citation repair threw. Fix: kept;
  last step ignores tools; graceful answers.
- A non-string or prototype-named `model` gave 500/502, and an unconfigured
  model's name labelled the default model's answer. Fix: validated, own
  keys, labelled by the model actually used.
- The last SSE line was dropped without a trailing newline. Fix: parsed.
- A BOM, trailing spaces, quoted or folded values broke SKILL.md parsing, and
  one bad skill stopped the server from starting. Fix: tolerant parser; a bad
  skill is skipped.
- `recruiting_status` did not trim `role_id`. Fix: trimmed.

Held-out suite (`npm run test:holdout`, 40 tests, not read by the fixer)
- 3 failed at first: "Singapore citizen" was not refused as nationality; an
  accepted widening could edit a criterion into a protected one; a tool
  failure failed the turn. Fix: citizenship counts as nationality; the
  protected-characteristic check moved into the one function every criteria
  change passes through; tool errors as above. Now 40 of 40.

One regression test was changed after it was written: in
`r1-agent-http.test.ts` the trigger `model: 5` stopped being a failure once
non-string models were accepted as "no model named". The test keeps its
intent (a failure before the agent runs must end the stream with an error
event) with a different trigger, and a new test checks that `model: 5` now
answers normally.

## Frontend, round 1 (deferred)

The owner asked to focus on the backend now and change the frontend later,
so these are recorded, not fixed. Repro scripts:
`test/hunt/ui-hunt/*.py` (Playwright; each exits 1 when the bug reproduces).
No XSS was found: HTML in names, criteria, drafts, and model text renders as
text.

Destructive (fix first):
- "Delete this role" stays armed across a role switch, so a single click on
  the next role deletes it (`h03`).
- The candidate drawer stays open after switching to another role; its
  buttons post to the new role, and closing it throws (`h15`).
- Late responses paint the previous role over the current one, with the
  Delete button targeting the role on the URL (`h04`, `h05`).

Other:
- Editing draft criteria loses focus on every 5-second poll (`h02`).
- The composer can send the same instruction twice (`h17`, `h17b`).
- "I sent it myself" proceeds after the draft save failed, and the error is
  cleared (`h21`).
- "Send from Gmail" stays disabled after typing an address until saved
  (`h12`).
- The chat stream loses an event split across network chunks, dropping the
  panel and the conversation id (`h08`).
- The chat panel is sized 20px too tall and its header scrolls out (`h09`).
- An embedded pool panel with two proposals hides controls with no scroll
  (`h23`).
- An embedded panel for a deleted or unknown role shows an empty shell or a
  stale board (`h07`, `h16`).
- A background error banner cannot be dismissed (`h20`).
