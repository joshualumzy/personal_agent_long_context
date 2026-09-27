# Show Me Your Agents Hackathon Submission Dossier

> Canonical source for the submission narrative, claims, evidence, and artifact links.
> Derived business, technical, video, and deployment artifacts must remain consistent with this document.

## Document Control

| Field | Value |
|---|---|
| Working submission name | SME Operating Agent |
| Repository package name | Personal Context Agent |
| Target SME | Stellar Ark AI |
| SME business | AI-native wearables, context glasses, a pendant, and proactive agent software |
| Final product name | `<missing>` |
| Team code | `<missing>` |
| Category | `<missing>` |
| Submission deadline | 28 September 2026, 9:00am (Asia/Singapore) |
| Repository | https://github.com/joshualumzy/personal_agent_long_context |
| Submission source of truth | This dossier |
| Implemented product truth | Current `src/`, `public/`, `skills/`, and `test/` code |
| Stale scope documents to reconcile | [`../mvp.md`](../mvp.md), [`../../GEMINI.md`](../../GEMINI.md) |
| Canonical domain language | [`../../CONTEXT.md`](../../CONTEXT.md) |
| Last dossier update | 27 September 2026 |
| Submission snapshot commit | `<missing>` |

## Required Deliverables

| Deliverable | Submission value | Status |
|---|---|---|
| Team Code | `<missing>` | Missing |
| Problem Statement | See [Problem Statement](#problem-statement) | Drafted |
| GitHub Repository URL | https://github.com/joshualumzy/personal_agent_long_context | Known |
| Business Proposal (PDF) | DOCX draft: `SME-Operating-Agent-Business-Proposal-Draft.docx`; PDF export `<missing>` | Drafted; PDF export pending |
| Technical Document (PDF) | DOCX draft: `SME-Operating-Agent-Technical-Documentation-Draft.docx`; PDF export `<missing>` | Drafted; PDF export pending |
| Demo Video | `<missing>` | Not recorded |
| Deployment Evidence | `<missing>` | Not available |

## How to Use This Dossier

1. Update facts and evidence here first.
2. Do not promote a hypothesis, target, implementation detail, or automated check into a verified outcome.
3. Generate the business proposal, technical document, and demo script from the artifact views near the end of this file.
4. Before submission, compare every external claim against the [Claims and Evidence Register](#claims-and-evidence-register).
5. Replace every literal `<missing>` before final submission, or explicitly state the limitation if the field cannot be completed.

## Source Hierarchy

For the hackathon submission, this dossier is the narrative source of truth. Claims inside it use this evidence order:

1. Current code and tests establish which product surfaces and controls are implemented.
2. Reproducible runtime evidence establishes what has actually run and with which configuration.
3. Saved evaluation reports establish bounded measured results.
4. `CONTEXT.md` supplies useful domain language, extended here for the implemented meeting and recruiting workflows.
5. `README.md`, `docs/mvp.md`, and `GEMINI.md` are supporting documents. Their S1-only scope statements are stale relative to the registered S2 and S3 code paths and must be reconciled before final submission.

If prose conflicts with code, do not silently repeat the prose: inspect the implementation and record the mismatch here.

## One-Sentence Submission

The SME Operating Agent helps Stellar Ark AI employees recover company knowledge, turn text meeting transcripts into controlled follow-up work, and run evidence-based recruiting, while keeping consequential actions under human control.

## Problem Statement

Stellar Ark AI builds AI-native wearables, including context glasses and a pendant, paired with a proactive agent system that turns everyday conversations into persistent memory and action. Captured context feeds a layered memory architecture and an agent layer connected to Feishu, email, calendar, and CRM. As the company builds and operates this system, its employees face a related internal context-to-action problem: company knowledge must be recovered from scattered records, meeting commitments must become owned follow-up, and a growing SME must hire without allowing administrative work to displace core product and customer work.

### Problem Evidence

| Evidence needed | Current state |
|---|---|
| First-hand SME problem context | Supplied by team members participating as Stellar Ark AI employees |
| Baseline time spent reconstructing context, processing meeting follow-up, and running hiring | `<missing>` |
| Frequency of company questions, unowned meeting commitments, and founder-led hiring tasks | `<missing>` |
| Cost or operational consequence of missed context, missed follow-up, or delayed hiring | `<missing>` |
| Current business-system context | Feishu, email, calendar, and CRM; detailed private records are intentionally excluded |

The problem basis comes from first-hand company context, but the quantitative baseline is not yet established. Private Stellar Ark AI records are intentionally excluded from the hackathon repository and demonstration. OrgForge supplies synthetic data for privacy-safe implementation and evaluation; it is not presented as Stellar Ark AI data.

## Target User and Stakeholders

### Primary User

An employee or founder at Stellar Ark AI who must turn scattered company context into trustworthy day-to-day work while contributing to a fast-moving AI-native product business. The same workflow may later apply to comparable SMEs with limited operations or recruiting capacity.

### Stakeholders

- SME employee: needs fast, understandable, evidence-backed answers and dependable meeting follow-up.
- Founder or hiring manager: needs to run a structured candidate search and outreach workflow without a dedicated recruiter.
- Business owner or manager: needs more consistent decisions without losing source accountability or human control.
- IT or system administrator: needs clear data boundaries and deployable infrastructure.
- Security or governance owner: needs source inspection, scoped identity, and explicit limitations.

### Current Workflow Basis

1. An employee receives a question, makes a commitment in a meeting, or a founder needs to hire.
2. They search systems and reconstruct context manually.
3. They translate what they found into emails, tickets, calendar events, documents, or hiring criteria.
4. They chase missing details, remember decisions, and follow up later.
5. They personally check and execute each consequential action.

This workflow is grounded in the team's first-hand understanding of Stellar Ark AI. The hackathon does not expose private company records, and the frequency, handling-time, rework, and missed-follow-up baselines remain to be measured in a controlled internal pilot.

## Proposed Solution

The SME Operating Agent is one modular product with three connected workflows:

1. **Company Context (S1 — know):** authenticates an employee persona; retrieves employee-visible Company Evidence with keyword, vector, and explicit-link traversal; returns citation-backed answers or Insufficient Evidence; and keeps employee-scoped Personal Memory separate.
2. **Meeting Actions (S2 — act):** accepts text transcript lines typed, pasted, or replayed from scripted demo scenarios; screens them before model use; identifies commitments, questions, and decisions; answers read-only questions through S1; flags cross-meeting conflicts; and prepares controlled follow-up actions.
3. **Recruiting (S3 — grow):** turns a founder's hiring need or job-description file into reviewable criteria, searches and scores public professional profiles, learns only from explicit feedback, drafts outreach, tracks replies and follow-ups, and remembers why the search changed.

The workflows are connected in code. S1 supplies Company Evidence to S2. An approved hiring request from S2 creates a draft role in S3. S3 is also available inside the main company chat as a skill whose tools load only when recruiting is relevant.

The current Company Evidence demo uses 4,966 synthetic employee-visible artifacts and a 51-person synthetic employee roster from the OrgForge dataset found for this hackathon. OrgForge is demo and evaluation data only; it is not a customer, product dependency, deployment target, or external integration. Recruiting uses Exa when configured or clearly labelled fictional sample profiles otherwise. The runtime Company Evidence corpus excludes the Evaluation Oracle by construction.

## Scope

### In Scope for the MVP

- Three browser experiences: company chat at `/`, meeting work at `/meetings`, and recruiting at `/recruiting`.
- Employee persona authentication and scoped sessions.
- Retrieval over synthetic Company Artifacts sourced from the OrgForge hackathon demo dataset.
- PostgreSQL full-text and pgvector retrieval.
- Explicit related-artifact traversal.
- Multi-step model tool use.
- Inspectable citations validated against evidence retrieved in the current run.
- Separately labelled, employee-scoped Letta Personal Memory.
- Persistent PostgreSQL conversations.
- Text-transcript meeting ingestion, pre-model screening, commitment/question/decision extraction, conflict checks, and action drafting.
- Deterministic S2 action tiers: automatic read-only results, exact-payload approval, escalation, or blocking.
- S2 handoffs to prefilled Gmail/Outlook, calendar, WhatsApp/Teams, GitHub, document, and spreadsheet surfaces; the employee completes the effect in their own account.
- Recruiting criteria, candidate search and scoring, feedback-driven proposals, outreach drafting, reply handling, and time-based follow-up.
- Cross-workflow handoff from a meeting hiring request to a recruiting role.
- Recruiting as a lazily loaded skill in the main chat.

### Out of Scope or Deferred

- Use or disclosure of private Stellar Ark AI business records in the hackathon demo; quantitative validation is deferred to a controlled internal pilot.
- Production enterprise SSO and fine-grained authorization.
- Production Personal Memory correction and deletion controls.
- Speech-to-text inside the application; S2 consumes transcript text and does not transcribe audio.
- Automatic sending of email or LinkedIn messages; S2 and S3 prepare handoffs and the user sends in their own account.
- Editing existing third-party records or documents through provider APIs.
- Real-time Slack, Jira, email, or document webhooks.
- Unattended consequential action or multi-agent orchestration.
- Production disaster recovery and incident-response controls.
- A claim of complete prompt-injection resistance.
- A claim of broad production reliability.

## Business Value Hypotheses

| Value dimension | Proposed value | Current evidence |
|---|---|---|
| Productivity | Reduce time spent reconstructing context, converting meetings into follow-up work, and administering a candidate search. | Product hypothesis; real baseline and pilot result are `<missing>`. |
| Follow-through | Make meeting commitments visible as traceable, reviewable drafts instead of relying on memory and manual minutes. | Implemented S2 workflow and automated tests; real-team outcome study is `<missing>`. |
| Hiring capacity | Give a founder a structured criteria-to-outreach workflow without pretending to replace human hiring judgment. | Implemented S3 workflow and automated tests; real hiring outcome evidence is `<missing>`. |
| Service consistency | Give employees a repeatable answer format with inspectable sources, explicit uncertainty, and deterministic action policy. | Citation validation and S2 policy are implemented; end-user outcome study is `<missing>`. |
| Risk control | Reduce unsupported company claims and prevent an agent from silently sending consequential drafts. | Citation validation, exact-payload approval, escalation/blocking, and user-account handoffs exist; production security validation is `<missing>`. |
| Knowledge continuity | Carry employee context, meeting decisions, and explicit hiring rationale across interactions. | Letta adapters and cross-workflow state are implemented; final live end-to-end verification is `<missing>`. |

These are not revenue or cost-savings claims. Financial value evidence: `<missing>`.

## Success Metrics and Pilot Plan

Targets must be agreed before they are described as success criteria.

| Metric | Definition | Baseline | Proposed target | Current result |
|---|---|---:|---:|---:|
| Context reconstruction time | Median time to produce an evidence-backed answer for a representative task. | `<missing>` | `<missing>` | `<missing>` |
| Task completion rate | Share of representative questions answered correctly with sufficient evidence. | `<missing>` | `<missing>` | `<missing>` |
| Citation integrity | Share of evaluated answers containing no hallucinated source identifiers. | `<missing>` | `<missing>` | 100% in the latest 76-question recorded run |
| Expected-evidence recall | Share of expected artifacts cited in the evaluation set. | `<missing>` | `<missing>` | 29% in the latest 76-question recorded run |
| Factual answer accuracy | Share of evaluated answers judged correct. | `<missing>` | `<missing>` | 12% in the latest 76-question recorded run |
| Turn latency | Mean time to complete an evaluated question. | `<missing>` | `<missing>` | 39.68 seconds in the latest 76-question recorded run |
| Unsupported-answer behavior | Share of unsupported questions that explicitly report insufficient evidence instead of guessing. | `<missing>` | `<missing>` | `<missing>` |
| User source-inspection success | Share of pilot users able to open and understand the evidence behind an answer. | `<missing>` | `<missing>` | `<missing>` |
| Meeting action recall by kind | Share of labelled commitments/questions/decisions converted into the correct action kind. | `<missing>` | `<missing>` | One saved live run reports 100% for all kinds except email, which found 2 of 3 |
| Meeting policy correctness | Share of proposed actions assigned the expected deterministic tier. | `<missing>` | `<missing>` | 23 of 23 in one saved live run |
| Unsafe transcript-line blocking | Secrets and prompt-injection lines blocked before model use, with ordinary-line false blocks tracked separately. | `<missing>` | `<missing>` | One saved live run: 9 of 9 unsafe lines blocked and 0 of 44 ordinary lines blocked |
| Recruiting funnel time | Time from a confirmed role to a scored, reviewable pool. | `<missing>` | `<missing>` | `<missing>` |
| Recruiting quality | Share of candidate judgments and workflow decisions meeting a human-labelled rubric. | `<missing>` | `<missing>` | `<missing>` |

### Evaluation Interpretation

The latest saved full OrgForge evaluation report is `docs/evaluation/orgforge-eval-2026-09-26T10-40-40-494Z.json`. It records 76 questions using `qwen3.8:27b`: 12% factual accuracy, 29% expected-evidence recall, 100% citation integrity, and 39.68 seconds mean latency.

This run supports a narrow claim that the citation-ID guard prevented hallucinated source identifiers in that sample. It does not support a claim of strong answer quality or production readiness. The low accuracy and recall are current quality gaps to address or explain before the final submission.

The repository also records one S2 live evaluation run dated 25 September 2026 using `qwen3.8:27b`. It reports correct tiers for 23 of 23 actions, 9 of 9 injections/secrets blocked, no false blocks among 44 ordinary lines, no action in 29 of 29 negative cases, and one cross-meeting conflict found. Action-kind recall was complete except for email (2 of 3). This is one run and should be presented as bounded evidence, not general reliability.

S3 has extensive deterministic, holdout, regression, chaos, and browser test assets, but a final submission snapshot result and a concise validated quality summary are `<missing>`.

Evaluation Oracle data is available only to the offline evaluation runner and must never enter the runtime retrieval corpus or agent context.

## User Experience

1. The employee asks a company question and inspects the cited Company Evidence behind the answer.
2. They open Meeting Actions and replay or enter transcript text.
3. Unsafe lines are blocked; read-only questions are answered; commitments become traceable action cards.
4. The employee reviews the exact payload, edits if necessary, and explicitly approves; an edit invalidates the previous approval.
5. Approved everyday work opens as a prefilled handoff in the employee's own tool. Money or contract commitments are escalated instead.
6. A hiring commitment can open a draft role in Recruiting.
7. The founder reviews criteria, sees a scored candidate pool, gives feedback, and prepares outreach without the agent sending it.

### Demo Persona and Scenario

| Field | Value |
|---|---|
| Demo persona | `<missing>` |
| Persona role and department | `<missing>` |
| S1 company question and expected evidence | `<missing>` |
| S2 text meeting or replay source | `<missing>` |
| S2 commitment, question, decision, or conflict to prove | `<missing>` |
| S2 approved handoff to show | `<missing>` |
| S3 hiring requirement and candidate source | `<missing>` |
| S3 criteria, pool, and outreach moment to show | `<missing>` |
| Cross-workflow S2-to-S3 hiring handoff | `<missing>` |
| Insufficient-evidence or missing-field behavior | `<missing>` |
| Model provider and exact model used in recording | `<missing>` |
| Demo dataset snapshot | `<missing>` |

## Architecture

```text
Browser surfaces
  |-- /             Company Context (S1)
  |-- /meetings     Meeting Actions (S2)
  `-- /recruiting   Recruiting (S3)
             |
             v
Fastify modular monolith
  |-- sessions, conversations, REST, and SSE
  |-- S1 company reasoning loop
  |     |-- PostgreSQL full-text + pgvector + explicit artifact links
  |     |-- retrieved-source citation validation
  |     `-- employee-scoped Letta Personal Memory
  |-- S2 meeting service
  |     |-- pre-model transcript guard
  |     |-- commitment/question/decision extraction
  |     |-- S1 evidence and question answering
  |     |-- deterministic action policy + exact-payload approval
  |     `-- user-account handoffs or S3 hiring handoff
  `-- S3 recruiting service and main-chat skill
        |-- criteria, profile search, scoring, feedback, proposals
        |-- Exa or labelled sample candidates; Hunter/Prospeo optional
        |-- read-only Gmail/Calendar and LinkedIn inbox inputs
        `-- Letta hiring-intent memory + user-controlled outreach handoff

Company Evidence, Personal Memory, meeting state, and recruiting role state
have distinct stores and contracts. Evaluation Oracle data stays offline.
```

### Runtime Components

| Component | Responsibility |
|---|---|
| Browser UIs | Company chat, meeting-action workspace, and recruiting workspace, with an embedded recruiting panel available in main chat. |
| Fastify application | HTTP validation, sessions, orchestration, outcome translation, and SSE delivery. |
| Company reasoning loop | Selects retrieval tools, gathers evidence, and composes an answer. |
| Meeting service | Screens transcript text, extracts action candidates, drafts supported payloads, applies deterministic policy, versions edits, checks approvals, and records an action log. |
| Dispatching executor | Opens approved drafts in user-controlled tools, simulates a ticket only when no GitHub repository is configured, and hands hiring requests to S3. |
| Recruiting service | Manages per-role criteria, searches, candidate scoring, founder feedback, proposals, outreach drafts, replies, and retention. |
| Recruiting chat skill | Exposes non-sending S3 tools only after the main agent loads the recruiting skill and can attach the live panel. |
| PostgreSQL | Company Evidence, chunks, embeddings, explicit artifact links, conversations, and employee roster. |
| pgvector | Vector similarity search alongside PostgreSQL full-text retrieval. |
| Letta App Server | Employee-scoped Personal Memory and founder hiring-intent events through separate adapters; never the Company Evidence corpus. |
| NUS SoCLaaS / AWS Bedrock | Configurable model providers for reasoning; final demo provider is `<missing>`. |
| Amazon Titan Text Embeddings V2 | 1,024-dimensional embeddings in `ap-southeast-2`. |
| Optional external services | Exa profile search, Hunter/Prospeo work-email lookup, Google read-only mail/calendar access, and read-only LinkedIn inbox sync. Each final demo dependency is `<missing>`. |

## Reasoning Loop and Tool Use

### S1: Company Context

1. Validate the request and employee context; keep Personal Memory separate from Company Evidence.
2. Let the model choose typed `search_company_knowledge` and `get_related_sources` calls.
3. Execute retrieval server-side and repeat within the tool-step limit.
4. Generate an answer, validate every source identifier against evidence retrieved in that run, and return a validated or insufficient-evidence outcome.

### S2: Meeting Actions

1. Accept transcript text and screen each segment for prohibited data and instruction attacks before model use.
2. Extract commitments, questions, and decisions, retaining the verbatim trigger quote; discard a candidate whose quote is absent from the transcript.
3. Route company questions to S1, check new decisions against prior decisions, and gather evidence or missing fields for drafts.
4. Apply deterministic policy: automatic read-only result, approval-required draft, escalation, or blocked.
5. Bind approval to the exact payload hash. Editing creates a new version that requires approval again.
6. Execute only as a user-controlled handoff, a simulated record where explicitly configured, or an S3 draft-role creation.

### S3: Recruiting

1. Load the recruiting skill only when the main-chat request concerns hiring, or operate directly in `/recruiting`.
2. Convert the founder's words or an uploaded job description into reviewable criteria; search begins only after confirmation.
3. Search public professional profiles, judge each criterion, and place candidates into deterministic tiers.
4. Treat feedback, criteria changes, preference proposals, and search widening as explicit state transitions; proposals require acceptance.
5. Look up a chosen candidate's work email without guessing, create an editable outreach draft, and let the founder complete sending in their own account or on LinkedIn.
6. Read or accept relayed replies, prepare follow-ups, and record the founder's stated hiring rationale in Personal Memory.

The model does not receive direct database credentials and does not execute arbitrary workplace writes.

## Autonomy and Human Control

The product automates evidence retrieval, analysis, drafting, and low-risk read-only results. It does not silently send messages or make financial, contractual, or hiring decisions. S2 can execute an approved handoff or create an S3 draft role, but the external effect remains visible and bounded.

| Risk level | MVP behavior |
|---|---|
| Evidence retrieval | Automatic within the authenticated runtime boundary. |
| Answer generation | Automatic, followed by deterministic citation validation. |
| Unsupported question | Return Insufficient Evidence rather than invent facts. |
| Meeting read-only answer or conflict flag | Automatic and traced. |
| Meeting email, message, calendar, ticket, document, spreadsheet, or hiring draft | Requires approval of the exact payload; an edit requires re-approval. |
| External workplace effect | Opens a prefilled handoff in the user's own account, or is explicitly recorded as simulated. |
| Recruiting criteria or proposal changes | Require explicit founder confirmation or acceptance. |
| Recruiting outreach | Drafted by the agent; sending remains a founder action in Gmail or LinkedIn. |
| Money or contract commitment | Escalated to a named higher authority; not executable by the employee. |
| Secret or transcript instruction attack | Blocked before model use. |

Human control is implemented in the current S2 and S3 code, although production authorization and third-party integration security are not yet proven.

## Safety, Security, and Guardrails

- Company citations must refer to Company Evidence retrieved in the current run.
- Personal Memory is labelled separately and is never cited as Company Evidence.
- Evaluation Oracle records are rejected from runtime ingestion.
- The browser does not receive model-provider or database credentials.
- S2 screens each transcript segment before model use and deterministically assigns the action tier.
- S2 approval is bound to an exact payload version; escalated and blocked actions cannot reach its executor.
- S3 chat tools expose no send operation; outreach is completed by the founder in their own account.
- S3 stores only declared public professional profile fields and does not guess email addresses.
- Unsupported claims should produce an Insufficient Evidence response.
- Session tokens use an HMAC-based mechanism and password verification uses scrypt; production identity and authorization hardening are not claimed.
- Complete prompt-injection resistance is not claimed.
- Production-grade tenant isolation, SSO, privacy deletion, disaster recovery, and incident response are deferred.

Current external security assessment or penetration test: `<missing>`.

## Observability and Evaluation

### Available Deterministic Verification

```bash
npm run typecheck
npm test
npm run test:browser
npm run test:orgforge
npm run test:holdout
npm run test:lock
npm run eval:meetings:dry
```

Current run date and results for these commands: `<missing>`.

### Available Live Evaluation

```bash
npm run eval:orgforge
npm run eval:meetings
npm run eval:recruiting
```

The evaluation runner has access to reserved expected answers and artifacts, but the runtime agent does not. Saved reports are stored under `docs/evaluation/`.

### Evidence Still Needed

- Final clean verification run against the submission snapshot.
- Final live-provider configuration and proof.
- Final S3 evaluation summary suitable for external reporting.
- Final demo recording with timestamps and cited source inspection.
- Deployment health check and environment evidence.
- Real-SME problem validation and pilot measurement.

## Feasibility

### What Exists

- A TypeScript/Fastify browser application.
- PostgreSQL migrations and a repeatable OrgForge ingestion path.
- Full-text and pgvector retrieval adapters.
- An explicit artifact-link traversal mechanism.
- SoCLaaS and AWS Bedrock model integration paths.
- A Letta Personal Memory adapter.
- Server-Sent Events for live progress and answer delivery.
- Citation validation and an offline OrgForge evaluation harness.
- A transcript-text meeting workflow with guarded extraction, action policy, versioned approval, handoffs, and evaluation cases.
- A multi-role recruiting workflow with criteria, search, scoring, feedback, outreach, replies, retention, a main-chat skill, and extensive regression/holdout assets.
- Cross-workflow S1-to-S2 evidence use and S2-to-S3 hiring handoff.
- Automated TypeScript, server, browser, ingestion, holdout, regression-lock, and domain evaluation checks.

### What Is Required to Operate It

- Node.js 22.19 or newer.
- Python 3.9 or newer for ingestion.
- Docker-compatible PostgreSQL with pgvector.
- A Letta App Server.
- A SoCLaaS API key and/or configured AWS Bedrock access.
- Environment-specific session secrets and database credentials.
- Optional Exa, Hunter, Prospeo, Google OAuth, and LinkedIn setup for live S3 integrations; labelled sample/manual fallbacks cover some demo paths.

### Key Risks

| Risk | Current mitigation | Remaining gap |
|---|---|---|
| Incorrect answer despite valid citations | Inspectable sources and offline evaluation. | Latest full evaluation accuracy is low. |
| Missing expected evidence | Hybrid retrieval and explicit artifact traversal. | Latest full evaluation recall is low. |
| Hallucinated source identifiers | Deterministic retrieved-source citation validation. | Does not prove the cited source semantically supports every claim. |
| Personal/company context confusion | Separate stores, labels, and citation rules. | Production privacy and deletion controls are deferred. |
| Unauthorized or stale action | S2 deterministic tiers, exact-payload approval, edit invalidation, and user-account handoffs; S3 has no chat send tool. | Production identity, shared approval, and third-party authorization still need hardening. |
| Unsafe meeting content reaches the model | Pre-model screening for prohibited data and instruction attacks. | A single bounded evaluation is not complete prompt-injection proof. |
| Candidate privacy or biased screening | Public-professional-field boundary, no guessed email, private pass reasons blocked from outreach, 30-day closed-candidate deletion. | Legal review, fairness evaluation, consent basis, and real deployment controls are `<missing>`. |
| Third-party fallback is mistaken for live integration | UI/code distinguish sample candidates, manual sending, and simulated tickets. | Final video must disclose the exact configured services. |
| Evaluation leakage | Runtime admission rules exclude Oracle sources. | Re-verify the final deployed data snapshot. |
| Provider or dependency outage | Explicit error paths and configurable providers. | Deployment resilience and operational SLOs are `<missing>`. |

## Scalability Path

### Prototype to Pilot

1. Select one SME, one department, and a bounded set of employee-visible systems.
2. Define authorization rules and a data-processing agreement.
3. Measure the current context-reconstruction workflow and establish baselines.
4. Ingest a permission-scoped pilot corpus with provenance and deletion controls.
5. Select one bounded meeting-follow-up workflow and one active hiring role; configure only the required integrations.
6. Run representative golden-path, unsupported, adversarial, approval, privacy, fairness, and access-control evaluations.
7. Deploy to a small pilot group with monitoring and human support.

### Pilot to Production

- Replace demo persona switching with enterprise identity and server-derived authorization.
- Add connector-specific incremental ingestion and lifecycle controls.
- Add production Personal Memory correction, retention, and deletion controls.
- Replace local per-role recruiting files with tenant-scoped durable storage and audited authorization.
- Add connector-specific approval, idempotency, and revocation controls before any direct provider writes.
- Add operational monitoring, SLOs, incident response, backup, and disaster recovery.
- Re-evaluate retrieval quality, citation support, privacy, and security on the real deployment.

The expected hosting topology, user volume, transaction volume, operating cost, and support model are `<missing>`.

## Deployment Information

| Field | Value |
|---|---|
| Deployment platform | `<missing>` |
| Public application URL | `<missing>` |
| Health endpoint | `<missing>` |
| Deployment region | `<missing>` |
| Deployment version or commit | `<missing>` |
| Deployment date | `<missing>` |
| Database service | `<missing>` |
| Letta hosting | `<missing>` |
| Model provider used by deployment | `<missing>` |
| Secrets management | `<missing>` |
| TLS evidence | `<missing>` |
| Health-check evidence | `<missing>` |
| Deployment screenshot or logs | `<missing>` |
| Known deployment limitations | `<missing>` |

The local development application exposes `GET /health`, which returns `{ "status": "ok" }`. A local health response is not deployment evidence.

## Claims and Evidence Register

Status definitions:

- **Verified**: supported by a current repository artifact or recorded run named below.
- **Implemented, not currently re-verified**: present in code/docs but not re-run for this submission snapshot.
- **Hypothesis**: proposed business effect requiring a pilot.
- **Missing**: required information is not yet available.
- **Prohibited**: outside the documented claim boundary.

| ID | Claim | Status | Evidence | Allowed use |
|---|---|---|---|---|
| C-01 | The runtime corpus contains 4,966 synthetic employee-visible OrgForge artifacts across eight artifact groups. | Implemented, not currently re-verified | `docs/mvp.md`; `GEMINI.md`; ingestion scripts | Proposal and technical document with the word “synthetic.” |
| C-02 | Runtime ingestion excludes the Evaluation Oracle by construction. | Implemented, not currently re-verified | `docs/mvp.md`; `scripts/orgforge/ingest.py`; `npm run test:orgforge` | Technical document; demo only after final verification. |
| C-03 | Company answers can use full-text, vector, and explicit related-artifact retrieval. | Implemented, not currently re-verified | `src/adapters/postgres-company-knowledge.ts`; `src/soclaas-company-agent.ts` | Technical document; demo only if exercised in the recorded run. |
| C-04 | Company citation identifiers are validated against sources retrieved in the current run. | Verified in a bounded evaluation | Code and the 76-question report with 100% citation integrity | Proposal, technical document, and demo with sample limitation. |
| C-05 | Personal Memory is stored and presented separately from Company Evidence. | Implemented, not currently re-verified | `docs/mvp.md`; `src/adapters/letta-memory.ts`; UI | Technical document; demo after live verification. |
| C-06 | Employee Personal Memory is isolated correctly for all users. | Missing | `<missing>` | Do not claim until an authoritative isolation test passes. |
| C-07 | Unsupported questions reliably return Insufficient Evidence. | Implemented, not currently quantified | Prompt, citation gate, automated cases | Describe as intended behavior; quantify only after evaluation. |
| C-08 | The agent reduces employee context-reconstruction time. | Hypothesis | Real-SME baseline and pilot are `<missing>` | Proposal as a target, never as an achieved result. |
| C-09 | The solution improves business productivity, service consistency, or risk control. | Hypothesis | Pilot evidence is `<missing>` | Proposal as expected value with a measurement plan. |
| C-10 | The application is production-ready. | Prohibited | No supporting evidence | Do not claim. |
| C-11 | The application is quantitatively validated on private Stellar Ark AI data. | Prohibited | The problem basis is first-hand, but the current corpus is synthetic and the internal baseline is not yet measured | Do not claim. |
| C-12 | The application completely prevents prompt injection. | Prohibited | No complete proof | Do not claim. |
| C-13 | The latest full benchmark demonstrates strong overall answer quality. | Prohibited | 12% accuracy and 29% recall in the 76-question run | Do not claim; present as an identified quality gap if discussed. |
| C-14 | A public deployment is available. | Missing | `<missing>` | Do not claim until deployment evidence is attached. |
| C-15 | S2 accepts transcript text, screens segments before model use, identifies meeting work, and applies deterministic action tiers. | Implemented, not currently re-verified | `src/meetings/guard.ts`; `extractor.ts`; `policy.ts`; `service.ts`; meeting tests | Proposal and technical document; demo after final verification. |
| C-16 | S2 performs speech-to-text transcription. | Prohibited | No audio/STT path in the implemented S2 workflow | Do not claim; say “processes text transcripts.” |
| C-17 | S2 binds approval to the exact draft payload and requires re-approval after edits. | Implemented, not currently re-verified | `src/meetings/service.ts`; route and core tests | Proposal, technical document, and demo after final verification. |
| C-18 | S2 sends email or changes third-party tools autonomously. | Prohibited | `src/meetings/executor.ts` opens user-account handoffs; unconfigured tickets are simulated | Do not claim. Show the handoff boundary. |
| C-19 | S2 can create a draft S3 recruiting role from an approved hiring request. | Implemented, not currently re-verified | `src/server.ts`; `src/meetings/executor.ts`; handoff tests | Proposal, technical document, and demo after final verification. |
| C-20 | One saved S2 live run achieved 23/23 tier correctness, blocked 9/9 unsafe lines with 0/44 ordinary-line false blocks, and found 1/1 conflict. | Verified in one bounded run | `README.md` evaluation table and meeting evaluation assets | Use only with date, model, and one-run limitation. |
| C-21 | S3 supports reviewable criteria, candidate search/scoring, explicit feedback and proposals, outreach drafts, replies, and follow-up state. | Implemented, not currently re-verified | `src/recruiting/`; `test/recruiting.test.ts`; `test/holdout/recruiting.holdout.test.ts` | Proposal and technical document; demo after final verification. |
| C-22 | S3 is available in main chat as a lazily loaded skill whose tools cannot send. | Implemented, not currently re-verified | `skills/recruiting/SKILL.md`; `src/recruiting/chat-tools.ts`; recruiting skill tests | Technical document and demo after final verification. |
| C-23 | S3 sends outreach autonomously or guarantees unbiased hiring outcomes. | Prohibited | Sending remains with the founder; no fairness evidence is recorded | Do not claim. |
| C-24 | The three workflows are integrated in one server. | Implemented, not currently re-verified | `src/server.ts`; `src/http-app.ts` | Proposal and technical document; demo after final verification. |

## Judge-Rubric Mapping

| Judging area | Submission evidence |
|---|---|
| Goal and scope definition | Problem Statement, Target User, Scope, Business Value Hypotheses |
| Architecture and reasoning loop | Architecture; Reasoning Loop and Tool Use |
| Tool use and integration | PostgreSQL/pgvector, artifact links, Letta, model providers, optional recruiting services, read-only Google access, and user-account handoffs |
| Autonomy and human-in-the-loop | S1 read-only answers; S2 deterministic tiers and exact-payload approval; S3 explicit founder decisions and no autonomous sending |
| Safety, security, and guardrails | Citation validation, Oracle exclusion, memory separation, transcript screening, escalation, private-reason checks, and limitations |
| Observability and evaluation | S1 saved evaluation, S2 action log and live evaluation, S3 deterministic/holdout/regression assets, and final verification gaps |
| Platform and tooling usage | Fastify, PostgreSQL/pgvector, Letta, model-provider integrations, SSE |
| Problem and opportunity | First-hand Stellar Ark AI problem basis, privacy-safe synthetic demo data, and unmeasured quantitative baseline clearly distinguished |
| Business value | Productivity, consistency, risk, scale, and continuity hypotheses |
| Impact and outcomes | Proposed pilot metrics plus current bounded technical metrics |
| Feasibility and scalability | Existing implementation, operational requirements, risks, pilot path |
| Proposal quality | One claim register shared by the proposal, technical document, and demo |

## Artifact Generation Views

### Business Proposal PDF

Recommended structure:

1. Executive summary and why the proposition fits Stellar Ark AI.
2. Problem and opportunity at Stellar Ark AI, including the privacy-safe synthetic-data approach.
3. One integrated solution and demo story: Know, Act, and Grow.
4. Business value, proposed pilot targets, and concise measurement approach.
5. Feasibility, current bounded technical evidence, and path to scale.
6. Adoption roadmap, critical controls, and closing case.

Use the business sections of this dossier. Do not include low-level implementation detail unless it establishes feasibility or risk control.

### Technical Document PDF

Recommended structure:

1. Scope, assumptions, and claim boundary.
2. System context and component architecture.
3. Data model and boundaries among Company Evidence, Personal Memory, meetings, and recruiting roles.
4. S1 retrieval/reasoning/citation contracts.
5. S2 transcript guard, extraction, policy, approval versioning, and handoffs.
6. S3 skill loading, criteria/search/scoring state machine, outreach boundary, and memory.
7. Cross-workflow S1-to-S2 and S2-to-S3 contracts.
8. Authentication, authorization, safety, privacy, and citation guardrails.
9. Deployment topology and configuration.
10. Testing, evaluation, current results, limitations, and reproduction commands.

Use the technical sections and evidence register. Include the low benchmark result rather than selectively reporting citation integrity alone.

### Demo Video

Recommended proof sequence:

1. State the small-team context-to-action problem and selected persona.
2. **Know:** ask a company question, show progress, inspect the cited evidence, and briefly show the separate Personal Memory surface.
3. **Act:** replay or enter transcript text, show a blocked unsafe line or conflict, and watch a real commitment become a draft.
4. Edit the draft to invalidate its earlier approval, approve the exact new payload, and show the user-account handoff rather than claiming an autonomous send.
5. **Grow:** let a meeting hiring request create a draft S3 role, or open the prepared demo role.
6. Review criteria and a scored pool, give one piece of feedback, and show an outreach draft whose final send remains with the founder.
7. Briefly show the integrated architecture, verification evidence, deployment health, and exact demo fallbacks or simulated components.
8. Close with the pilot value hypothesis and honest limitations, including text-only meetings and synthetic/sample data where used.

Final narration, screen sequence, duration, and recording URL: `<missing>`.

### Deployment Evidence

The evidence package should contain:

- public application URL;
- `GET /health` response from that URL;
- deployment platform and region;
- deployed commit identifier;
- timestamped application screenshot;
- timestamped deployment log or release record with secrets removed;
- confirmation that required services are reachable; and
- known limitations or temporary demo dependencies.

Current evidence package: `<missing>`.

## Final Submission Checklist

- [ ] Team code is filled in.
- [ ] Category and eligibility are confirmed.
- [ ] Problem evidence is either supplied or explicitly presented as an assumption.
- [ ] Business targets are labelled as targets, not achieved outcomes.
- [ ] Final repository state and commit are recorded.
- [ ] Required verification commands pass on the submission snapshot.
- [ ] The final live model and dataset snapshot are recorded.
- [ ] The core demo scenario is deterministic enough for recording.
- [ ] The business proposal PDF matches this dossier.
- [ ] The technical document PDF matches this dossier.
- [ ] The demo video proves the claims it narrates.
- [ ] Deployment evidence is public, timestamped, and contains no secrets.
- [ ] All literal `<missing>` markers have been resolved or intentionally disclosed.
- [ ] All URLs open without private local-machine assumptions.
- [ ] The Slack submission contains every required field and artifact.

## Submission Block for Slack

```text
Team Code: <missing>
Problem Statement: Stellar Ark AI employees lose time and follow-through when company context is fragmented, meeting commitments must be converted into work by hand, and founder-led hiring competes with core product and customer work. Our integrated agent helps them know what happened, turn text meetings into controlled follow-up, and run a structured recruiting workflow while keeping consequential actions under human control. Private business records are excluded; the hackathon demo uses clearly labelled synthetic data.
GitHub Repository URL: https://github.com/joshualumzy/personal_agent_long_context
Business Proposal (PDF): <missing>
Technical Document (PDF): <missing>
Demo Video: <missing>
Deployment Evidence: <missing>
```

## Reference Material

- `docs/ref/SMYA - business proposal guidelines.pdf`
- `docs/ref/ShowMeYourAgent_Hackathon_Briefing_release-1.pdf`
- `docs/mvp.md`
- `GEMINI.md`
- `CONTEXT.md`
- `README.md`
- `docs/evaluation/orgforge-eval-2026-09-26T10-40-40-494Z.json`
