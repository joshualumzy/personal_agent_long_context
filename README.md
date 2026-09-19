# Personal Context Agent

A personal agent that keeps useful context from transcripts you deliberately
submit, applies later corrections and cancellations, and answers from what is
currently true rather than from everything it has ever heard.

A browser submits a dated, consent-attested Transcript to a thin server-side
adapter. The adapter sends accepted content to a user-scoped Letta agent,
which owns persistent Memory. The browser then inspects that Memory and asks
questions about it. Letta and model credentials never reach the page.

```text
Browser  ->  thin server-side adapter  ->  Letta App Server  ->  model provider
```

`docs/mvp.md` is the authoritative scope. `CONTEXT.md` fixes the vocabulary.

## Requirements

- Node.js 22.19 or newer
- A model provider connected to Letta Code (see Configuration)
- The pinned Letta Agent SDK `0.8.12` and Letta Code runtime `0.32.13`,
  installed by `npm install`

## Configuration

Install dependencies and create your environment file:

```bash
npm install
cp .env.example .env
```

Connect a model provider once. This is Letta Code's own configuration, stored
under `~/.letta`, not something this repository reads:

```bash
npx letta                     # run from this directory, so the pinned 0.32.13 is used
/connect                      # choose a provider and paste your key
```

Non-interactively, for an OpenAI-compatible gateway:

```bash
npx letta connect openai-compatible --base-url <base-url>/v1 --api-key <key>
```

Then set the model in `.env`. The handle is the provider prefix plus the model
id that `npx letta model list` reports:

```
LETTA_MODEL=openai-compatible/qwen3.8:27b
```

`LETTA_MODEL` is read when an agent is created, so changing it affects new
agents only. To evaluate a different model, use a new user identifier.

Every developer connects their own provider key. Nothing about a shared key
is needed, and the local backend keeps each person's agents and Memory on
their own machine.

### Local and remote App Servers

The product interface does not change between them. Only server-side
configuration does.

| | Local development | Remote self-hosted |
| --- | --- | --- |
| `LETTA_APP_SERVER_URL` | `http://127.0.0.1:4500` | your App Server URL |
| `LETTA_APP_SERVER_TOKEN` | unset | required |
| Who runs the App Server | `npm run letta:server` on your machine | the deployed host |
| Where the provider key lives | your `~/.letta` | the App Server host |

The browser receives the same application API in both cases, and no part of
the frontend knows which one is in use. Provisioning the remote host is out of
scope for this repository.

## Running it

```bash
npm run letta:server          # terminal 1: the App Server on 127.0.0.1:4500
npm run dev                   # terminal 2: the application on 127.0.0.1:3000
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The application server can
start before Letta, but Transcript submission is rejected until the App Server
and its model provider are available.

For frontend work without a model, `MEMORY_ADAPTER=deterministic npm run dev`
uses an in-memory provider. That mode is not evidence of real Letta
persistence.

## Application interface

The frontend and the evaluation harness are both callers of this interface,
so production and evaluation behavior cannot drift apart.

- `POST /api/v1/transcripts` accepts `userId`, `sourceId`, `recordedAt`,
  `transcript`, `attestation`, and `policyVersion`.
- `POST /api/v1/questions` accepts `userId` and `question`.
- `GET /api/v1/users/:userId/memory` returns the Memory Letta currently
  exposes for that user, including its history of superseded, cancelled, and
  conflicting entries.
- `GET /api/v1/policy` returns the policy version and the two valid
  attestation values.
- `GET /health` reports application-server availability.

```bash
curl --fail-with-body http://127.0.0.1:3000/api/v1/transcripts \
  -H 'content-type: application/json' \
  --data '{
    "userId": "demo-user",
    "sourceId": "voice-note-001",
    "recordedAt": "2026-09-19T08:00:00+08:00",
    "transcript": "I moved my weekly planning to Sunday evening.",
    "attestation": "uploader_only_identifiable_speaker",
    "policyVersion": "consent-v1"
  }'

curl --fail-with-body http://127.0.0.1:3000/api/v1/questions \
  -H 'content-type: application/json' \
  --data '{ "userId": "demo-user", "question": "When do I plan my week?" }'
```

Every result carries a correlation identifier. An answer also carries the run
reference when a run exists to inspect, and the Transcript source references
the Memory files record. The adapter records `receivedAt` independently of
`recordedAt`, so a late upload of an older note does not read as a new
decision. Rejections never echo the submitted Transcript or provider
internals; the real reason goes to the server log under the same correlation
identifier, carrying identifiers only.

## The demonstration

The scenario is ordinary life administration that changes over time. Run it
against a live server:

```bash
npm run demo:scenario
```

It walks the path a judge should see, and writes what happened to
`docs/evidence/`:

1. **Consent.** Submission stays unavailable until one of the two attestations
   is chosen, and the server rejects a missing or invalid one independently.
2. **Create.** A dated Transcript books a dentist appointment for Thursday the
   24th at 9am and signs up for a Tuesday pottery class.
3. **Inspect.** The Memory panel shows what the agent retained, with the source
   identifier and recorded time behind each fact.
4. **Update.** A later Transcript moves the dentist appointment to Friday the
   25th at 2pm. The earlier entry moves to history, marked superseded.
5. **Cancel.** A later Transcript cancels the pottery class. The entry is
   marked cancelled and stops being current, and its history stays.
6. **Ask.** "What is currently on my calendar?" answers Friday the 25th at 2pm
   and does not offer the Thursday slot or the pottery class as current.
7. **Chronology.** A Transcript recorded on the 5th but uploaded last does not
   overwrite the revision recorded on the 8th.
8. **Conflict.** A hedged "I might switch to a morning slot" is recorded as an
   unresolved conflict, and the next answer asks which one holds instead of
   choosing.
9. **Safety.** A Transcript containing a credential is rejected with its
   category named, the text stays in the form for correction, and nothing
   reaches Letta.

The content is synthetic and first-party. Nothing here implies always-on,
ambient, or covert recording.

## Verification

```bash
npm test          # behavior, adapter, safety, and browser-level tests
npm run typecheck
npm run test:browser   # the rendered workflow on its own
```

The default suite calls the same HTTP interface the browser uses, with a
deterministic Memory provider. `test/browser.test.ts` goes further: it loads
the delivered page and the delivered script and drives the rendered controls
against a live server.

With the App Server running and a model provider configured:

```bash
RUN_REAL_LETTA=1 npm run test:smoke
```

Four scenarios run against real Letta: connection and agent reuse across
adapters, answering from persistent Memory, an update-and-cancellation chain,
and a late older upload followed by a hedged contradiction.

The Memora evaluation has its own guide in
[`docs/evaluation/README.md`](docs/evaluation/README.md), and its result is in
[`docs/evaluation/memora-report.md`](docs/evaluation/memora-report.md).

## Security boundary

The browser receives only the application API and static assets.
`LETTA_APP_SERVER_TOKEN`, model-provider credentials, agent administration,
and provider errors stay server-side. The Prohibited Data gate runs on the
server before any content reaches Letta, and operational logs carry
identifiers rather than content.

## Limitations

These are stated plainly because the alternative is implying something the
MVP has not earned.

- **The Consent Attestation is not verified consent.** It is the uploader's
  statement, recorded and auditable. Nothing verifies who actually spoke.
- **The Prohibited Data gate is not comprehensive PII detection.** It is a
  documented set of basic rules for obvious credentials, payment details,
  private keys, and government identifiers. It is not anonymisation, and it
  will miss things.
- **Semantic Invalidation is not Privacy Deletion.** A cancelled or superseded
  entry stops being current, and its history is deliberately kept as evidence.
  Nothing is erased from the underlying store, its Git history, or any backup.
- **None of this is a claim of PDPA compliance.** The MVP demonstrates
  continuity and safety boundaries for a course and a hackathon. It is not a
  production privacy implementation.

Also out of scope: direct Recording Necklace synchronization, audio upload and
transcription, production multi-user authentication, and AWS provisioning.

## For the two submissions

The same code, told two ways.

**IT5007** cares about a working full-stack application: a browser frontend, a
server-side adapter with a real external integration, a test suite that
exercises the rendered workflow and the HTTP interface, documentation that
someone else can follow, and an evaluation with numbers rather than
assertions.

**Show Me Your Agents** cares about the SME problem: a recording-necklace
maker needs a companion agent whose Memory is explicit and inspectable,
whose safety boundaries are visible, and whose behavior is measurable. The
Memory panel, the correlation identifiers, the Prohibited Data gate, and the
Memora gate exist so the agent can be checked rather than trusted.
