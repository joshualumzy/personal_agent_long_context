# Evidence

Captured from the running system, not reconstructed afterwards. Each item
says what it shows and how it was produced.

| File | Shows |
| --- | --- |
| `01-submission-with-consent-attestation.jpg` | The working frontend: the submission form, the recorded time kept separate from receipt time, and the purpose stated before submission. |
| `02-answer-with-conflict-sources-and-run.jpg` | Backend interaction and Memory behavior: an answer that surfaces an unresolved conflict instead of choosing, with its correlation identifier, run reference, and the Transcript sources behind it. |
| `03-safety-gate-rejects-a-credential.jpg` | The safety gate: a Transcript containing a credential rejected by category, with the text left in the form for correction and nothing sent to Letta. |
| `04-memory-with-superseded-cancelled-and-conflict.jpg` | Memory behavior: the agent's own Memory file with Current, Superseded / cancelled history, and Unresolved conflicts, each entry carrying its source identifier and recorded time. |
| `demo-scenario-*.json` | The full create, revise, cancel, late-older-upload, and hedged-contradiction chain, as recorded by `npm run demo:scenario` against a real Letta App Server. |
| `../evaluation/memora-report.md` | The evaluation result, with its raw run beside it. |

The screenshots were taken against a real Letta App Server on SoCLaaS
`qwen3.8:27b`, with the demonstration user built by the scenario script.
