# Knowledge gaps in the UI: notes for moving it into the new layout

T7 of the gap-hiring map puts hiring proposals on Kaki's left-hand plate, below the signed-in employee's own plan. It is a distinct company-wide section rather than part of the personal plan, and follows the same chosen day.

## What it reads and does

| Call | Use |
|---|---|
| `GET /api/v1/gaps/proposals?asOf=D` | `{ asOf, canOpenRoles, proposals[] }`. Each proposal: `id`, `name`, `openedOn`, `status` (`open` / `role_opened` / `dismissed`), `roleId` when a role is open, `reasons[] {rule, text}` (rule is `orphaned`, `thin` or `overloaded`), `evidence[]` (source ids, open with the existing source dialog), `suggestedTitle`. 503 means proposals are not set up: hide the whole thing. |
| `GET /api/v1/gaps/health?asOf=D` | `{ asOf, domains[] }`: `name`, `owner`, `ownerActive`, `ownerLoad`, `activeContributors30d[]`, `incidents30d[]`, for the "Every domain" table. |
| `POST /api/v1/gaps/proposals/:id/open-role` `{asOf}` | 201 `{ roleId, title }`. Drafts the role in Hiring; link to `/recruiting?role=<roleId>`. 409: already opened or dismissed. 503: Hiring not set up (the list says so first, in `canOpenRoles`). |
| `POST /api/v1/gaps/proposals/:id/dismiss` `{asOf, reason?}` | 204. |

`asOf` is the date picker's day (the last working day when none is chosen). Everything follows it, like the planner.

## Where the code is

- Markup: `public/index.html`, `#gaps-panel` inside `#plate`.
- Behaviour: `public/plate.js`, the section "Knowledge gaps: company-wide hiring proposals on the plate". It uses `initGaps()`, `loadGaps()` (called from `showDay`), `renderProposals()`, `renderHealth()` and `actOnProposal()`.
- Styles: `public/styles.css`, the section "knowledge gaps". It uses only theme tokens: `--alert` for "No owner", `--warn` for "Few people on it", `--esc` for "Owner stretched", and `--accent` for the primary button.
- Tests: `test/sme-browser.test.ts`, "SME Assistant knowledge gaps".

## Things to keep when moving it

- **Wording.** "Open role" must stay honest: its tooltip says the role is only drafted and nobody is searched or contacted until someone confirms its criteria in Hiring.
- **Status.** Dismissed proposals fold away under "Dismissed · N" instead of vanishing. A proposal with an open role links to it rather than offering the button again.
- **Evidence.** Evidence chips open the same source dialog as answer citations.
- **Visibility.** Proposals are visible to every signed-in employee (MVP decision, `docs/mvp.md`), unlike the "My day" tab, which is the signed-in employee's own.
