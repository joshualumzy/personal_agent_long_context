# Letta Agent SDK suitability assessment

Research date: 2026-09-19

Primary sources only:

- [Current Letta Agent SDK documentation](https://docs.letta.com/agent-sdk)
- [Current Agent SDK source repository](https://github.com/letta-ai/letta-agent-sdk)
- [Current Letta Code source repository](https://github.com/letta-ai/letta-code)
- [Current self-hosting documentation](https://docs.letta.com/self-hosting)
- [Letta pricing](https://docs.letta.com/pricing)
- [Letta privacy policy](https://www.letta.com/privacy-policy/)

## Current MVP decision

The current MVP scope is defined in [`docs/mvp.md`](../mvp.md). It uses a thin application adapter with self-hosted Letta as the owner of persistent memory. It deliberately defers a separate application-owned memory database, typed state machine, deletion ledger, and `MemoryService` until a small Memora evaluation demonstrates a product-relevant need.

The analysis below remains useful as production risk research and as a fallback architecture. Its recommendations for application-owned memory are not committed MVP requirements.

## Production-oriented research verdict

**Use Letta as an optional agent runtime and conversational orchestration layer, not as the Personal Context Agent's authoritative memory database.**

The current Letta Agent SDK is a good fit for a TypeScript prototype that needs durable agents, conversations, streaming, tool calls, model portability, and local/self-hosted deployment. Its native memory, MemFS, is a Git-backed hierarchy of Markdown files that an agent can edit and periodically consolidate. That is useful working memory, but it is not the project's required domain model for provenance-linked Current Truth, explicit supersession/cancellation, unresolved conflict, or verifiable Privacy Deletion. [Agent SDK overview](https://docs.letta.com/agent-sdk), [MemFS](https://docs.letta.com/concepts/memfs)

The recommended design is therefore:

```text
deliberately submitted audio/transcript
                  |
          transcription + PII gate
                  |
     authoritative application-owned store
     ├── source evidence and transcript spans
     ├── versioned memory facts and status
     ├── conflict/supersession relationships
     └── deletion ledger and cascade
                  |
       narrow typed memory service/tools
                  |
       Letta agent runtime and dialogue
                  |
       answer + evidence-span citations
```

Letta may keep small, non-sensitive working summaries in MemFS, but the application database remains the source of truth. This boundary makes Letta replaceable and lets the project evaluate Letta's native memory separately from the project's explicit memory model.

## Important product-line distinction

The current application SDK is `@letta-ai/letta-agent-sdk`, which targets JavaScript/TypeScript and the current Letta App Server. The old Python server, V1 SDK, block/archival-memory APIs, and `letta/letta` Docker image are retired for new applications, benchmarks, and academic experiments. Letta's own repository instructs new integrations and benchmarks to use the current Agent SDK and App Server. [Official migration warning](https://github.com/letta-ai/letta/blob/main/AGENTS.md), [current quickstart](https://docs.letta.com/agent-sdk/quickstart)

This matters because older Letta examples describe editable memory blocks plus an archival vector store. The current Agent SDK's primary memory abstraction is MemFS: a Git repository of Markdown files owned by each agent. Files under `system/` are injected into every turn; other files stay out of context until the agent reads them. [Agent SDK memory](https://docs.letta.com/agent-sdk/memory), [MemFS structure](https://docs.letta.com/concepts/memfs)

## Fit against the project requirements

| Requirement | Native Letta support | Fit | What this project must add |
| --- | --- | --- | --- |
| Incremental, ordered transcript ingestion | Durable conversations, queued turns, message history, caller-supplied `otid`, and explicit message/run identifiers are built in. | Partial | An idempotent ingestion API with recording/session timestamps and sequence numbers. Do not equate chat-message order with real-world recording chronology. |
| Immutable source evidence | Conversation history persists; MemFS edits are Git-versioned. | Partial | A source-evidence store whose transcript text, audio offsets, speaker, ASR version, and consent metadata are not autonomously rewritten by the agent. Evidence is append-only except for authorized Privacy Deletion. |
| Structured Current Truth | Native memory is primarily Markdown files; it does not define a typed fact/status schema. | Weak | Versioned records such as `CURRENT`, `SUPERSEDED`, `CANCELLED`, `CONFLICTED`, and `DELETED`, plus relationships to supporting spans. |
| Explicit add/update/invalidation | The agent can edit files and Dreaming can consolidate recent conversations. | Partial | Deterministic reconciliation rules and typed operations. Dreaming is model-driven consolidation, not a transaction or state-machine guarantee. |
| Privacy Deletion | Files/repositories and legacy API objects have delete operations. | Weak | A cross-store deletion workflow with verification. Normal Git-backed deletion is not evidence of physical erasure from history or backups. |
| Unresolved conflicts | Git supports merge conflict resolution at the file level. | Weak | A domain-level Memory Conflict state. File merge conflicts are not the same as uncertainty between two user statements. |
| Retrieval with citations | The agent can read/search files and call tools; operational IDs are available. | Partial | Stable evidence IDs, transcript spans, a retrieval result schema, and UI citations showing which statement superseded another. |
| Memora evaluation without metadata leakage | Agents and conversations can be isolated; `stateless: true` can run a turn without loading or changing MemFS. | Good substrate | A dedicated harness that sends only conversation text in order and keeps operations, expected answers, and evidence labels exclusively in the grader. |
| Inspectability and observability | Strong typed stream of reasoning, tool calls/results, errors, result timing and run IDs; persisted history; Git memory history. | Good | Product-level logs connecting ingestion event -> extracted candidate -> state transition -> retrieval -> cited answer. |
| Local/self-hosted deployment | Cloud, fully local, and separately operated App Server backends share one SDK interface. | Strong | Deployment hardening, backups, authentication, and a deliberate model-provider choice. Local state does not imply local inference. |
| TypeScript/Python support | Current high-level Agent SDK is JavaScript/TypeScript. Python must use the App Server WebSocket protocol directly; the separate Python client belongs to the older API line. | Strong for TS; weak for Python | Prefer a TypeScript backend or isolate Letta in a small TypeScript service behind an internal API. |
| Replaceable memory subsystem | Client tools and MCP tools can call application-owned services and databases. | Good if designed for it | Define a provider-neutral `MemoryService`; do not let application code depend directly on MemFS paths or Letta agent IDs. |

Sources: [sessions and durability](https://docs.letta.com/agent-sdk/sessions), [message stream and identity](https://docs.letta.com/agent-sdk/messages), [memory and Dreaming](https://docs.letta.com/agent-sdk/memory), [client and MCP tools](https://docs.letta.com/agent-sdk/mcp), [SDK reference](https://docs.letta.com/agent-sdk/reference).

## What Letta provides well

### Durable agent and conversation lifecycle

An agent is the durable entity holding identity and memory; a conversation is a thread; a session is an active connection. Sessions can be closed and later resumed by agent or conversation ID while memory and conversation history persist. Messages sent during a running turn are queued by the runtime. [Sessions](https://docs.letta.com/agent-sdk/sessions)

This is a good match for a consumer assistant that needs continuity across visits. It does **not** by itself define whether a new transcript adds, updates, cancels, or conflicts with a prior fact.

### Editable, versioned working memory

MemFS gives each agent a real Git-backed memory repository. Every saved edit is committed, which provides history and a clear boundary between saved and uncommitted memory. Files under `system/` are always in context; the rest are discoverable by path and read on demand. [MemFS](https://docs.letta.com/concepts/memfs)

Dreaming can run background subagents after a step count or compaction event to review conversations and update memory. This is promising as an experimental consolidation strategy, but it is probabilistic agent behavior. It should be evaluated against the explicit state pipeline, not trusted as the only implementation of Current Truth. [Dreaming configuration](https://docs.letta.com/agent-sdk/memory#dreaming)

MemFS does not include semantic/vector indexing by default. Letta documents an optional search mod; local conversation-history search is currently full-text, while Letta Cloud supports full-text, vector, and hybrid message search. [MemFS search](https://docs.letta.com/concepts/memfs#semantic-and-vector-search)

### External memory tools are a clean seam

The SDK can expose application-defined JavaScript functions as client tools and can proxy MCP tools. These implementations and their credentials live in the host application and are not persisted on the Letta agent. That is the right seam for `search_memory`, `propose_memory_update`, `get_evidence`, and similar operations backed by the project's own database. [MCP and client tools](https://docs.letta.com/agent-sdk/mcp)

The SDK also supports tool allowlists and an approval callback that may allow, deny, or edit individual calls. A destructive `privacy_delete` tool can therefore require explicit user approval even when ordinary reads are automatic. [Permissions](https://docs.letta.com/agent-sdk/permissions)

### Operational observability

The stream exposes typed reasoning, assistant text, tool calls, tool results, retries, errors, and a terminal result. Messages carry identifiers for message identity, lineage, ordering within a run, and tool-call correlation; results expose duration and run IDs. [Sending messages](https://docs.letta.com/agent-sdk/messages)

This makes Letta comparatively inspectable as an agent runtime. It still does not automatically cite a derived memory back to an audio or transcript span; that evidentiary provenance must be returned by the project's retrieval tool and rendered by the UI.

## What must remain application-owned

### Evidence History

Store each submitted recording/transcript and each revision outside Letta with stable identifiers:

- `recording_id`, `transcript_id`, and monotonic ingestion sequence
- event time and ingestion time
- speaker label and transcription confidence where available
- character offsets and/or audio start/end timestamps
- transcript revision and transcription-model version
- consent/source classification and sensitivity labels
- checksum for detecting accidental alteration

Letta receives only the passages needed for reasoning, each accompanied by its stable evidence ID. This lets the UI cite exact spans and lets Privacy Deletion locate every derivative.

### Current Truth state machine

Use typed records rather than relying on the latest Markdown summary:

```text
MemoryFact
  id
  subject / predicate / value
  status: CURRENT | SUPERSEDED | CANCELLED | CONFLICTED
  valid_from / valid_to
  evidence_ids[]
  supersedes_id?
  conflicts_with_ids[]
  confidence
```

An explicit correction may supersede prior state. A clear cancellation may semantically invalidate an item while preserving its Evidence History. A hedged or ambiguous contradiction should create `CONFLICTED` state and prompt for clarification. Letta has no documented built-in domain contract for these transitions; they must be enforced in application logic.

### Privacy Deletion

MemFS versioning is actively useful for audit, but it conflicts with deletion guarantees. Letta documents that every memory edit becomes a Git commit, and Cloud repository history can be read by commit/reference. Therefore, deleting a file creates a new state but should **not** be described as erasing its prior content; this is an inference from the documented Git/version behavior. [MemFS versioning](https://docs.letta.com/concepts/memfs#versioning-and-synchronization), [repository versions and deletion](https://docs.letta.com/agent-sdk/reference#cloud-repository-client)

The lower-level API documents deleting an agent or conversation, but it only promises deletion/no longer appearing in list operations; it does not document secure purge of Git history, replicas, logs, or backups. [Delete agent](https://docs.letta.com/api/typescript/resources/agents/methods/delete), [delete conversation](https://docs.letta.com/api/typescript/resources/conversations/methods/delete)

Consequently:

- Do not place raw audio, complete transcripts, payment-card data, credentials, or other highly sensitive source material in MemFS.
- Keep a deletion manifest mapping evidence to transcript rows, embeddings, extracted facts, caches, and any safe summaries mirrored into Letta.
- Treat Letta-side cleanup as one step in a larger deletion saga and report which stores were actually verified.
- For the course prototype, promise deletion only for stores under the application's control and disclose backup/log limitations.

## PII policy recommendation

Do **not** remove all personally identifiable information. Names, relationships, places, and preferences may be necessary for a useful Personal Context Agent. Use data minimization by category:

1. **Secrets and high-risk financial/authentication data:** card numbers, CVVs, passwords, API keys, authentication tokens, and recovery codes should be irreversibly redacted before transcription text reaches any agent memory or model.
2. **Sensitive identifiers:** government IDs, bank-account numbers, medical identifiers, and precise addresses should be dropped or replaced by stable tokens unless the use case explicitly requires them. If reversibility is necessary, keep the token mapping in a separately encrypted vault, never MemFS.
3. **Ordinary contextual PII:** names and broad personal facts may be retained only when necessary for the user-facing feature, with access control, encryption, provenance, and deletion support.
4. **Derived memory:** store the minimum fact needed for assistance and link it to evidence rather than copying the full transcript into every memory record.

The Agent SDK does not document a built-in PII classifier or redaction stage. This must happen before Letta ingestion. If Letta Cloud is used, the current privacy policy states that hosted services collect data used to render the service, including message requests and responses, and may use hosted-service data to improve services. For a voice-derived prototype, fully local/self-hosted state is the safer default; if a remote model provider is selected, prompts still leave the device for that provider. [Letta privacy policy](https://www.letta.com/privacy-policy/), [self-hosting and model-provider boundary](https://docs.letta.com/self-hosting)

## Memora evaluation design

Letta can be evaluated fairly on Memora, but the project should write its own adapter rather than reuse the retired V1 integrations.

For each benchmark timeline:

1. Create a fresh isolated agent or isolated local state directory; never reuse consumer memory between test cases.
2. Fix the Letta SDK/App Server version, model, prompt, memory configuration, and Dreaming setting.
3. Feed only dated conversation text, in chronological order, through the public ingestion contract.
4. Never send `operation`, `share_memory`, current-memory snapshots, presence evidence, forgetting evidence, or expected answers to Letta.
5. Ask the released query only after all permitted sessions are ingested.
6. Keep scoring metadata in a separate grader process.
7. Record outputs, tool traces, MemFS commits, latency, tokens/cost, and the project database transitions.
8. Destroy the isolated test state after exporting the declared artifacts.

`stateless: true` is useful for one-off diagnostic turns because it does not load or change the agent's memory, skills, transcript, or reflection behavior. It should not be used for the actual memory-under-test query if the goal is to measure Letta's native memory. [Stateless sessions](https://docs.letta.com/agent-sdk/sessions#run-a-turn-without-touching-memory)

The MVP initially runs only the Native Letta condition. If its results expose a recurring product-relevant failure, a later experiment may compare:

- **Native Letta:** MemFS/Dreaming owns consolidation. This tests Letta as a memory system.
- **External canonical memory:** the explicit state store owns consolidation and Letta retrieves through typed tools. This tests the recommended product architecture.

That later comparison could show whether an explicit mutation/conflict model improves on native agent-managed files without contaminating Memora inputs.

## Deployment, maturity, cost, and lock-in

### Deployment

The same Agent SDK supports:

- `cloud`: agent state in Letta Cloud, with tools in a managed sandbox or selected computer.
- `local`: state and execution on the current machine; the SDK owns the App Server subprocess.
- `remote`: state and execution on a separately operated App Server.

Letta states that a fully local deployment keeps messages, memory, and provider connections on-device and needs no account. Self-hosted agents require the operator to arrange backups. Local state is stored under `~/.letta/lc-local-backend` by default and can be isolated per experiment. [Deployment](https://docs.letta.com/agent-sdk/deployment), [self-hosting](https://docs.letta.com/self-hosting)

For local development and evaluation, start with `backend: "local"` and a project-specific state directory. The deployed MVP may use a remote, self-hosted App Server on AWS. A local state backend does not automatically make model inference local; use a local provider such as Ollama/LM Studio only if that is part of the privacy claim, or disclose the selected remote provider.

### Language and maturity

The current high-level Agent SDK is JavaScript/TypeScript only; Python applications must use the App Server WebSocket protocol directly. The package is currently pre-1.0 (`0.8.12` at research time), requires Node.js 22.19+, and is Apache-2.0 licensed. Pin its exact version and wrap it behind an internal adapter. [Quickstart](https://docs.letta.com/agent-sdk/quickstart), [official package manifest](https://github.com/letta-ai/letta-agent-sdk/blob/main/package.json)

The official Python and TypeScript `letta-client` libraries target the REST API, but the docs place that material in the legacy V1 section. They are not equivalent to the current high-level Agent SDK and should not be the foundation of a new academic benchmark. [Client SDKs](https://docs.letta.com/v1-sdk/client-sdks), [official warning against V1 for new benchmarks](https://github.com/letta-ai/letta/blob/main/AGENTS.md)

### Cost and lock-in

Self-hosting avoids Letta Cloud hosting charges but not model-inference or infrastructure costs. Current Cloud developer pricing is usage-based: the API plan is listed at $20/month, $0.10 per active agent per month, $0.00015 per second of server-side tool execution, plus model usage; BYOK is supported. These prices are time-sensitive and should be rechecked before the proposal is submitted. [Pricing](https://docs.letta.com/pricing)

The SDK and current runtime are open source under Apache-2.0, and local/remote backends reduce hosting lock-in. Architectural lock-in remains if canonical state is encoded only in Letta agent IDs, conversations, prompts, or MemFS paths. The external `MemoryService` boundary reduces this to replaceable runtime integration.

Suggested provider-neutral interface:

```ts
interface MemoryService {
  ingestTranscript(input: OrderedTranscript): Promise<IngestionResult>;
  searchCurrent(query: MemoryQuery): Promise<CitedMemory[]>;
  getHistory(memoryId: string): Promise<MemoryVersion[]>;
  resolveConflict(input: ConflictResolution): Promise<MemoryVersion>;
  semanticallyInvalidate(input: Invalidation): Promise<MemoryVersion>;
  privacyDelete(input: DeletionRequest): Promise<DeletionReceipt>;
}
```

Letta should depend on these operations as tools. The rest of the application should depend on `MemoryService`, not Letta.

## Production fallback decision

If native Letta fails the MVP evaluation gate, use the following criteria for a time-boxed application-owned-memory spike:

- A TypeScript backend can ingest ordered transcript sessions and resume the same user agent.
- The agent can call a read-only memory tool and return stable evidence-span citations.
- An explicit update supersedes an older value; an ambiguous update produces a conflict instead of silent overwrite.
- A cancellation performs Semantic Invalidation but leaves Evidence History intact.
- A separate approved Privacy Deletion request removes the source and derived data under application control and returns a deletion receipt.
- The same scenario runs against `local` and, optionally, Cloud without changing the application's memory interface.
- A small Memora slice runs in isolated state without operation/evidence metadata entering the agent.

This remains a production-oriented fallback, not the present MVP plan. The MVP keeps Letta-owned memory unless measured reliability, latency, or integration problems justify the additional evidence store and state machine.
