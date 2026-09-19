# Memora evaluation

The MVP keeps Memory inside Letta. This evaluation is the gate that decides
whether that holds: a declared, mutation-heavy slice of the Memora benchmark,
run through the same application interface the browser uses.

`docs/mvp.md` states the rule this serves: application-owned memory is built
only if native Letta repeatedly fails a product-relevant requirement.

## What you need

1. A checkout of the benchmark, pinned to the revision the report names:

   ```bash
   git clone https://github.com/geniesinc/Memora.git
   cd Memora && git checkout a6493188efc836d6511ed5e4163fe3ba87da30ff
   ```

   The corpus is used as released. Nothing is regenerated: the official
   generator does not seed its randomness, so a regenerated corpus would not
   be the same corpus.

2. A running App Server and application, configured as in the root `README.md`.

3. Grader credentials in `.env`. The grader is a separate model that never
   talks to the agent:

   ```
   SOCLAAS_BASE_URL=https://soclaas-api.comp.nus.edu.sg/v1
   SOCLAAS_API_KEY=clsk_...
   ```

## Running it

```bash
npm run letta:server                      # terminal 1
npm start                                 # terminal 2
MEMORA_DATA_DIR=/path/to/Memora/data \
  npm run eval:memora                     # terminal 3
npm run eval:memora:report
```

The run writes `docs/evaluation/memora-run-<id>.json` after every ingestion
and every question, so an interrupted run keeps everything it already
measured. The report generator reads the newest run file, or a path you pass
it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEMORA_DATA_DIR` | required | `data/` inside the Memora checkout |
| `MEMORA_COMMIT` | `a6493188…` | recorded in the report |
| `MEMORA_SPLIT` | `weekly` | `weekly`, `monthly`, or `quarterly` |
| `MEMORA_PERSONAS` | `software_engineer,academic_researcher` | comma separated |
| `MEMORA_CHUNK_CHARS` | `20000` | Transcript size budget |
| `MEMORA_JUDGE_MODEL` | `qwen3.6:35b` | grader model |
| `MEMORA_RUN_ID` | timestamp | names the output files |
| `APP_BASE_URL` | `http://127.0.0.1:3000` | the application under test |

## How isolation works

Each persona timeline runs under its own user identifier, which the adapter
maps to its own Letta agent with its own Memory. No timeline can read
another, and none of them can reach the demonstration user's Memory.

## What the agent is allowed to see

Only the conversation text and the date it was recorded. `eval/memora/dataset.ts`
reads the rest of each session file and keeps it: `operation`,
`operation_details`, `session_type`, `share_memory`, `memory_evidence`,
`forgetting_evidence`, and the expected answers stay with the grader. That
boundary is what makes the score a measurement of Memory rather than of
metadata leakage.

## Timing

Ingestion dominates. Every Transcript is an agent turn that reads and
rewrites Memory, so a weekly persona takes roughly an hour of wall clock.
Raise `LETTA_APP_SERVER_TIMEOUT_MS` before raising `MEMORA_CHUNK_CHARS`: a
48,000-character Transcript exceeded the 180 second default and was rejected.
