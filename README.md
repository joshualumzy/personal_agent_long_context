# Personal Context Agent

This repository contains the first end-to-end MVP slice: a browser submits a dated, consent-attested Transcript to a thin server-side adapter, the adapter sends accepted content to a user-scoped local Letta agent, and the browser asks questions about, and inspects, the Memory Letta exposes.

The Consent Attestation is an uploader statement, not technical or legal verification. Use synthetic, staged-consent, or first-party Transcripts only. Do not submit credentials, authentication secrets, payment or bank details, private keys, or government identifiers.

## Requirements

- Node.js 22.19 or newer
- A model provider configured for Letta Code
- For the real integration path, the pinned Letta Agent SDK `0.8.12` and its pinned Letta Code runtime `0.32.13` (installed by `npm install`)

## Install and run

```bash
npm install
cp .env.example .env
npm run letta:server
```

In a second terminal, start the application. It loads `.env` when present:

```bash
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The application server can start before Letta, but Transcript submission is rejected until the App Server and its model provider are available.

For frontend-only work without a model, run `MEMORY_ADAPTER=deterministic npm run dev`. This mode is deliberately in-memory and is not evidence of real Letta persistence.

## Application interface

- `POST /api/v1/transcripts` accepts `userId`, `sourceId`, `recordedAt`, `transcript`, `attestation`, and `policyVersion`.
- `POST /api/v1/questions` accepts `userId` and `question`, and answers from the Memory that user's agent retained.
- `GET /api/v1/users/:userId/memory` returns the Memory Letta currently exposes for that user.
- `GET /api/v1/policy` returns the current policy version and the only two valid attestation values.
- `GET /health` reports application-server availability.

Example request:

```bash
curl --fail-with-body http://127.0.0.1:3000/api/v1/transcripts \
  -H 'content-type: application/json' \
  --data '{
    "userId": "demo-user",
    "sourceId": "voice-note-001",
    "recordedAt": "2026-09-19T08:00:00+08:00",
    "transcript": "I decided to plan the week on Sunday evening.",
    "attestation": "uploader_only_identifiable_speaker",
    "policyVersion": "consent-v1"
  }'
```

Asking a question:

```bash
curl --fail-with-body http://127.0.0.1:3000/api/v1/questions \
  -H 'content-type: application/json' \
  --data '{ "userId": "demo-user", "question": "When do I plan my week?" }'
```

An answered question returns the agent's `answer`, the `sources` it read while answering, and a `runRef` when a run exists to inspect. A source is reported only for a Memory file that records the `source_id` of the Transcript it came from, so the list holds Transcript source references rather than Memory file names. A user with no retained Memory is answered plainly, with no sources and no run reference, rather than with an error. Questions are routed to the same user-scoped agent that ingested that user's Transcripts, so one user never receives another user's Memory.

Every result includes a correlation identifier. The adapter records `receivedAt` independently of `recordedAt`. Rejections never echo the submitted Transcript or provider error details.

## Verification

The default test suite calls the same HTTP interface as the browser with a deterministic Memory provider:

```bash
npm test
npm run typecheck
```

With the local Letta App Server running and a model provider configured, run the opt-in smoke test:

```bash
RUN_REAL_LETTA=1 npm run test:smoke
```

The first smoke test verifies connection, user-agent reuse, two ingestions, persistence, and Memory inspection. It asserts that the unique source identifiers from both submitted Transcripts remain exposed after reconnecting. The second ingests one Transcript, then answers a later question through a fresh adapter, and asserts that a different user receives none of that Memory. The adapter allows up to 180 seconds for each App Server request by default; set `LETTA_APP_SERVER_TIMEOUT_MS` in `.env` if a slower provider needs a different limit.

## Security boundary

The browser receives only the application API and static assets. `LETTA_APP_SERVER_TOKEN`, model-provider credentials, agent administration, and provider errors stay server-side. The Prohibited Data check is a narrow MVP guard, not comprehensive classification or a production privacy claim.
