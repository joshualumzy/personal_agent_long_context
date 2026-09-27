# S3 Recruiting Agent

Design record for the recruiting direction (whiteboard S3). Owner: Cici. Decided in a grilling session on 2026-09-23. S1 and S2 are explored separately by the other two teammates.

## One sentence

A small-company founder states a hiring need by voice, typing, or file; the agent turns it into criteria, searches public professional profiles with Exa, places candidates into match tiers, learns from the founder's feedback, drafts outreach, and follows up, while every outward action waits for the founder.

## Decisions

| Topic | Decision |
|---|---|
| Relationship to the product | Same Letta memory base. The founder's hiring intent is Memory; candidate records are not. |
| Who is the user | A founder hiring for their own small company. One open role at a time. |
| Requirement input | Typed, dictated (the laptop's own dictation tool), or an uploaded file (txt, md, pdf, docx). All become text. The founder can also paste LinkedIn links of people already in mind; they join the pool and are scored like everyone else. |
| Criteria | The agent splits the requirement into 3–6 criteria, each `must` or `nice`. The founder confirms once. |
| Candidate source | Exa Search with `category: "people"` (free tier: $20 once plus $10 a month, about 2,800 searches). Websets are not used: their API needs a paid plan. |
| Scoring | Our own LLM judges each criterion `yes` / `no` / `unclear` with a reason, in the shape Exa Websets uses. Verdicts are cached per candidate and criterion, so a new criterion only costs one judgement per candidate. |
| Tiers | 100%: every criterion `yes`. 75%: every must `yes`, some nice missing. 50%: exactly one must `no` or `unclear`. Anything worse leaves the pool. |
| Pool size | Start small: a tight query and about 20 people. Expand only when hiring stalls. |
| Expansion | When N simulated days pass with no reply from the 100% and 75% tiers, the agent proposes the next step of a ladder: widen location, then drop background filters, then demote one must to nice. The founder approves each step. |
| Feedback | Three kinds: a verdict on one person (keep or pass, optionally with a reason), a change to criteria, and a retraction of something said before. A criteria change rescores the existing pool first, renames the role to match, and searches again in the background. |
| Implicit preferences | Each keep or pass is recorded with a reason (stated or inferred). When passes (or keeps) sharing one inferred reason reach the threshold (2 for the demo, configurable), the agent proposes a new criterion. It never takes effect without the founder's confirmation. |
| Candidate stages | discovered → scored → drafted → contacted → replied → scheduling → closed. |
| Contact details | Hunter first, Prospeo next (it looks people up by LinkedIn link). If neither finds an address, none is shown: a guessed address could reach a stranger. The founder can type one in. Only for people the founder chooses to contact. |
| Sending | The draft is shown and edited in our frontend. The founder presses "Open in Gmail to send", which opens the message prefilled in their own Gmail; their Send there is what sends it, and the app records it as sent. The app holds no permission to send mail. Drafts are short, open with one concrete piece of the person's work tied to what the company builds, and use `COMPANY_PITCH` for the company; they are LinkedIn-length when no email is known. |
| Replies | Gmail replies are read through the Gmail API (read-only), found by the candidate's address since the founder's message. LinkedIn replies are read by a Playwright script using the founder's own logged-in browser profile. It loads the inbox and copies each conversation's preview without clicking anything, so it cannot send or mark messages read; only conversations naming someone the founder contacted reach the model. Pasting or dictating a reply is always available as the fallback. The LLM matches a reply to a candidate and proposes the next stage and draft. |
| Scheduling | Draft a message proposing a few time slots. Calendar integration is deferred. |
| Follow-up | Five simulated days without a reply: draft a follow-up. Seven more: mark the candidate cold and stop. A fast-forward control simulates the passing days for the demo. |
| Frontend | Progressive disclosure on one screen. The orbit holds 100% at the centre, 75% in the middle ring, 50% as small dots outside. Clicking a dot opens a drawer with three tabs: why they fit, career, outreach. Feedback animates dots between rings; an expansion sends a ripple outward and the new people fly in from the edge. |
| Privacy | Store only the public professional fields Exa returns plus the founder's notes. Closed candidates are erased after 30 days. The founder's private notes never appear in outreach; drafts are checked before they are shown. |
| Model | NUS SoC LaaS, `qwen3.8:27b` (OpenAI compatible), the same provider Letta uses. |
| Evaluation | (a) Criterion-verdict agreement against 30 hand-labelled candidates. (b) Feedback effectiveness: share of candidates resembling passed ones that still reach the top two tiers after a preference is accepted. |

## Memory boundary

Letta holds the founder's hiring intent: every confirmed criteria version, each preference proposal and its outcome, feedback with reasons, and each expansion step. Each of these is sent to Letta as a hiring event through the existing ingestion path, so the founder can later ask "why do we require Rust?" and inspect the history.

The application keeps a structured projection of the current criteria so that scoring and reshuffling are immediate. Each change updates the projection and emits its event in the same step, so the two do not drift apart.

Candidate profiles, verdicts, contact details, drafts, and stages stay in a local JSON store (`data/recruiting.json`, git-ignored). They are records about third parties, not the founder's personal context.

## Demo script (about 90 seconds)

1. The founder dictates the need. The agent shows 4–5 criteria; the founder confirms.
2. Exa returns about 20 people; dots settle into the orbit.
3. The founder passes on two people for the same reason. The agent proposes a criterion; the founder accepts; dots move rings live.
4. The founder chooses a 100% candidate. Hunter finds the email; the draft appears; the founder sends.
5. Fast-forward seven days. No reply from the top tiers; the agent proposes widening the pool; a new outer ring appears.

## Milestones

- M1: requirement → criteria → Exa → scoring → orbit.
- M2: feedback → preference proposals → rescoring → expansion.
- M3: contact lookup → open in Gmail to send → replies (Gmail, LinkedIn, paste) → follow-up and scheduling drafts.

## Out of scope

Several open roles at once, calendar integration, sending on LinkedIn, speech-to-text inside the app, production multi-user authentication.

## Running it

```bash
npm run letta:server     # terminal 1, as for the rest of the product
npm run dev              # terminal 2, then open http://127.0.0.1:3000/recruiting
```

Only `SOCLAAS_BASE_URL` and `SOCLAAS_API_KEY` are required. Each other key in `.env.example` switches one piece from its fallback to the real service:

| Key | Without it |
|---|---|
| `EXA_API_KEY` | 40 invented sample profiles (`src/recruiting/sample-candidates.json`), labelled as such in the UI |
| `HUNTER_API_KEY`, `PROSPEO_API_KEY` | no email is found; the founder types one in or sends on LinkedIn |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | replies are not read from Gmail; the founder pastes them. Opening a draft in Gmail needs no setup |
| Letta not running | `MEMORY_ADAPTER=deterministic` keeps hiring events in process only |

Gmail: create an OAuth client of type "Web application" in Google Cloud, add `http://127.0.0.1:3000/api/recruiting/gmail/callback` as a redirect URI, enable the Gmail API and the Google Calendar API, keep the consent screen in testing mode, and add the team as test users. Then press Connect Gmail.

LinkedIn replies: `npm run linkedin:login` once (log in by hand in the window), then `npm run linkedin:sync` whenever you want the agent to read new messages. The browser profile lives in `data/linkedin-profile`, git-ignored.

Evaluation: `npm run eval:recruiting:template` writes `eval/recruiting/labels.json`; label it by hand, then `npm run eval:recruiting`.

## Code map

| Path | What it holds |
|---|---|
| `src/recruiting/service.ts` | The state machine: criteria, scoring loop, feedback, proposals, outreach, time |
| `src/recruiting/agent.ts` | Every model prompt and the validation of its reply |
| `src/recruiting/tiers.ts` | The 100 / 75 / 50 rule |
| `src/recruiting/intent-memory.ts` | Hiring events into Letta through the existing ingestion path |
| `src/recruiting/sources.ts`, `contacts.ts`, `gmail.ts` | Exa, Hunter and Prospeo, Gmail |
| `scripts/linkedin-inbox.ts` | The read-only LinkedIn reader |
| `public/recruiting.*` | The orbit page |

## Verified on 2026-09-23

With `qwen3.8:27b` on SoC LaaS, the sample source, and a local Letta App Server:

- A Chinese requirement with "最好 30 岁以下" became four criteria; the age wish was refused and reported.
- Confirming found 20 people; all 20 were scored in 19 seconds (judging runs without the thinking phase: about 2 s a call instead of 8).
- Passing two candidates who "only execute other people's designs" produced a proposed must criterion about owning a shipped product. Accepting it moved three candidates from the middle ring to the outer one and one out of the pool.
- Outreach drafted a first message (at the time an address was guessed; guessing has since been removed). Seven simulated days produced a follow-up draft and a "Widen location" proposal; accepting it made location a nice-to-have and added a second round of 20 people.
- After "remote is fine, we open remote next month", asking "why is Singapore no longer required?" was answered from Letta Memory with that reason.
