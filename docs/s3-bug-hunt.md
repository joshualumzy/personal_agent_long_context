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

## Round 2, backend (2026-09-26)

Two fresh hunters looked at what the round 1 fixes broke or missed. 43 bugs
confirmed (chat agent 17, backend 26), all fixed. Regression files:
`test/regression/r2-*.test.ts`.

Chat agent (`r2-agent-*.test.ts`)
- Tool calls without an id, with a duplicated id, or streamed without an id
  were answered without a matching id or dropped. Fix: every call gets a
  unique id.
- An empty model reply was echoed back as an empty assistant message, which
  servers reject. Fix: not echoed.
- Citation repair asked for "Insufficient evidence ..." and then rejected it.
  Fix: the repair answer may say evidence is missing if it names what is
  missing and asserts nothing else. A teammate's existing test caught a first
  version that also let "Insufficient evidence, but X" through.
- If saving the answer failed, the user got an error although the tools had
  already acted (a retry would repeat them). Fix: the answer is delivered;
  the failed save is logged.
- `{message: 5, question: "hi"}` gave a 500; a blank userId made an unreadable
  conversation; a replaced conversation lost its title; the company-question
  route skipped the prohibited-data gate. Fix: all four.
- `recruiting_revise_criteria` still wiped the draft for a list of strings, an
  empty list, or blank texts; unknown kinds became must; a refused start left
  an orphan service. Fix: refused with the draft unchanged; kinds read
  strictly; failed starts are forgotten.
- SKILL.md: multi-line values, escapes and comments were misread; symlinked
  skill folders were ignored; duplicate names both loaded. Fix: YAML parser
  with a lenient fallback for hand-written files; symlinks followed;
  duplicates skipped.

Backend (`r2-backend-*.test.ts`)
- A candidate id of `__proto__` in a URL closed Object.prototype, i.e. every
  object in the process. Fix: own-key lookup for candidates.
- A load that failed once (busy file) broke the role until restart. Fix:
  retried.
- An email sent by Gmail followed by a failed save was sent again on retry.
  Fix: send is claim (saved), send, record; a claimed draft cannot be sent
  or edited again.
- Follow-up and intro drafts landed on people who replied or were closed
  meanwhile; a reply reopened a closed (even hired) candidate; a failed
  scheduling draft lost the reply itself. Fix: stage re-checked inside the
  change; closed stays closed; the reply is saved first.
- Memory heard about changes that were then rolled back. Fix: events reach
  Memory only after the save.
- Candidate headlines were written into events, outliving the 30-day
  erasure. Fix: no profile text in events.
- Damaged files with partial candidates or a role without createdAt broke
  the role or the list. Fix: normalized on load.
- A request arriving during deletion brought the role back. Fix: a deleted
  id is never opened again.
- The LinkedIn inbox gave a shared conversation to the oldest role. Fix:
  newest first.
- The proposal route declined when `accept` was missing. Fix: must be a
  boolean.
- After fast-forward, Gmail replies were missed (simulated vs real clock);
  one failing thread stopped the sync. Fix: messages keep real time too;
  threads are isolated.
- A broken `%` escape in a profile URL crashed a search round; chat text to a
  confirmed role was not capped; importing two links to one person reported
  it twice; a deleted role's scoring reported errors. Fix: all four.
- Fairness check: it refused legitimate criteria ("business-level Chinese",
  "Traditional Chinese Medicine", "p99 under 50 ms", "women's health
  products", "citizen developer", "Singaporean SMEs", ...) and missed real
  discrimination ("aged 25-35", "born after 1995", "90后", "限男", "ladies
  preferred", "新加坡人优先", "SC/PR", "passport holder", "local candidates
  only", "must be a mother", ...). Fix: job-related contexts (languages as
  skills, markets, products, units) are removed first, then broader
  protected patterns apply. Checked on 29 discriminatory and 43 legitimate
  phrasings, including every criterion the real model produced earlier.
- Model output: an unrecognised kind in set_kind flipped nice to must; a
  numeric criterion id discarded the verdict. Fix: strict kinds; numeric ids
  read.

Found while setting up the frontend checks (`r2-own-rate-limit.test.ts`)
- Under several parallel sessions SoCLaaS answered HTTP 429. The recruiting
  client retried three times with no pause, so a rate limit failed every
  attempt, and candidates whose scoring failed stayed unscored until
  something else triggered scoring. Fix: retries back off (doubling, jitter,
  Retry-After honoured) and only for 429, 408, 5xx, network errors and
  malformed replies; at most 6 model calls in flight across all roles;
  failed scoring is retried after 30 s, up to 3 times.

## Frontend logic, fixed (2026-09-26)

The owner asked to fix now the frontend logic that any future UI will keep,
and leave only layout for the redesign. Checks moved to
`test/regression/ui/` (see its README); each failed before the fix and passes
after.
- Delete stayed armed across role switches (`h03`); the drawer outlived the
  board and acted on another role (`h15`); late answers painted the previous
  role (`h04`, `h05`). Fix: every answer is tied to the view it was asked
  for; switching roles closes the drawer and disarms Delete.
- Draft criteria lost focus and edits on each poll (`h02`). Fix: polling
  refreshes the draft only while it is untouched.
- The composer could send twice (`h17`, `h17b`). Fix: one request at a time.
- "I sent it myself" went ahead after a failed save (`h21`). Fix: sending
  follows only a save that worked.
- "Send from Gmail" ignored a typed address (`h12`). Fix: follows the field.
- A split SSE event lost its type (`h08`). Fix: the type persists across
  reads and resets on a blank line.
- An embedded panel for a missing role showed an empty shell or a stale
  board (`h07`, `h16`). Fix: it says the role is gone.
- A background error could not be dismissed (`h20`). Fix: Dismiss, which
  also clears it on the server.
Still deferred (layout): `h09` panel height, `h23` two proposals in a small
embedded panel.

## Fairness check removed (2026-09-26, owner's decision)

The owner removed the check that refused criteria on protected
characteristics. It blocked real, lawful requirements ("新加坡人优先",
"SC/PR": Singapore's Workplace Fairness Act, s 22, lets employers prefer
citizens and PRs) and served nothing the product needs. Removed with it:
`src/recruiting/fairness.ts`, the refusals in the service, the "never write"
lines in the model prompts, the rule in the skill, and the promise in the
design doc and README. Tests that asserted refusals were deleted
(`r2-backend-fairness.test.ts`, whose two model-output parsing tests moved
to `r2-backend-parsing.test.ts`; one test in `r2-backend-nonbugs.test.ts`;
the fairness tests in `test/recruiting.test.ts`); the fake model in
`test/recruiting.test.ts` no longer proposes an "under 30" criterion.
