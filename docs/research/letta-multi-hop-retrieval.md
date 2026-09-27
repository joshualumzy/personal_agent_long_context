# Letta and multi-hop personal-memory queries

Research date: 2026-09-20

Primary sources only:

- [Letta Agent SDK memory documentation](https://docs.letta.com/agent-sdk/memory)
- [Letta MemFS documentation](https://docs.letta.com/concepts/memfs)
- [Letta Agent SDK client-tool documentation](https://docs.letta.com/agent-sdk/mcp)
- [Current Letta Code memory prompt](https://github.com/letta-ai/letta-code/blob/main/src/agent/prompts/letta.md)
- This repository's [MVP scope](../mvp.md), [Letta adapter](../../src/adapters/letta-memory.ts), and [completed Memora evaluation](../evaluation/memora-report.md)

## Verdict

Do **not** add a graph database, vector database, or separate canonical memory store now.

The claim that Letta is adequate for simple recall but necessarily fails at multi-hop retrieval is not established by Letta's documentation or by this repository's evaluation. Letta can let a model find several memory files and reason across their contents. However, current Letta does not document a native entity graph, relationship query language, or deterministic join operator. Whether the example below works reliably is therefore an empirical question about the whole pipeline: what facts ingestion retained, how it organized them, whether the answering turn found them, and whether the configured model combined them correctly.

> I'm going to Tokyo next week. Which former colleagues of mine live there, and who introduced us?

This should become a small product-specific evaluation. Escalate storage architecture only if the current Letta-owned design shows a recurring, diagnosable failure.

## What the question requires

The answer must combine at least three kinds of current information:

1. a person is a former colleague of the user;
2. that person's current location is Tokyo;
3. another person introduced the user and that former colleague.

This is a filter plus a relationship lookup. It becomes a difficult retrieval problem only when those facts are scattered or hard to discover. If Letta consolidates each person's current facts into a discoverable profile containing relationship, location, introducer, dates, and source identifiers, the model may answer after reading only a few files. If the same facts remain split across unrelated transcripts or ambiguously named files, the agent must discover and combine more evidence.

That distinction matters: **multi-hop reasoning** is the model combining retrieved facts; **retrieval** is finding the files or passages that contain those facts; **storage/consolidation** determines whether the necessary facts and their current status exist in a usable form. A wrong answer does not by itself identify which layer failed.

## What current Letta provides

Letta stores an agent's persistent memory in MemFS, a Git-backed repository of Markdown files. Files under `system/` are included on every turn; other files stay outside the active context until the agent decides to read them, while the file tree remains visible as a discovery aid. The agent can therefore traverse several files and synthesize an answer; this is agent/model behavior rather than a documented graph query. [Letta memory](https://docs.letta.com/agent-sdk/memory#memfs), [MemFS structure](https://docs.letta.com/concepts/memfs#memory-structure)

MemFS has no semantic or vector index by default. Native discovery uses ordinary file-search and read tools. Letta documents an optional MemFS Search mod for keyword search and, with QMD, semantic or hybrid search. Conversation-history search is separate; the local backend currently provides full-text search, while Letta Cloud provides full-text, vector, and hybrid message search. [MemFS search](https://docs.letta.com/concepts/memfs#semantic-and-vector-search)

Letta's own current prompt also directs an agent to use recall, MemFS search, links, and other available search tools when it lacks past context. This supports iterative retrieval, but it is guidance to the agent, not a guarantee that every relationship chain will be found. [Letta Code memory prompt](https://github.com/letta-ai/letta-code/blob/main/src/agent/prompts/letta.md#jogging-your-memory)

If an application later needs structured lookup, the Agent SDK can expose a JavaScript client tool that runs in the host process and queries an application database. Letta's documentation demonstrates exactly this pattern with a database-backed customer lookup. The tool is an integration seam; it does not make relationship storage native to MemFS. [Client tools](https://docs.letta.com/agent-sdk/mcp#combine-mcp-and-client-tools)

## What this application currently does

The adapter gives answering turns only `Read`, `LS`, `Glob`, and `Grep`; it does not currently expose a semantic-search or structured relationship tool. Its ingestion prompt asks Letta to retain concise facts with provenance and reconcile updates, cancellations, and conflicts, but it does not prescribe an entity schema or stable person-per-file layout. Its answer prompt tells the model to read the needed memory files and use only current entries. See [`letta-memory.ts`](../../src/adapters/letta-memory.ts#L16-L17), [`letta-memory.ts`](../../src/adapters/letta-memory.ts#L159-L170), and [`letta-memory.ts`](../../src/adapters/letta-memory.ts#L238-L246).

The completed Memora slice showed that native Letta Memory was adequate for the MVP's update/cancellation gate: 20 questions scored 89.2% memory-presence accuracy and 80.8% forgetting-absence accuracy. It also had 10 stale-memory violations across 55 forgetting criteria. More importantly for this decision, the selected questions tested mutation-heavy recall and recommendation; they were not a declared evaluation of person-location-introducer traversals. The result supports keeping Letta for the MVP, but it does not validate this new query class. [Memora report](../evaluation/memora-report.md#results), [selection and limitations](../evaluation/memora-report.md#selection)

## Why another datastore is not yet justified

| Option | What it would help | Why it is not the first move |
| --- | --- | --- |
| Native Letta MemFS | Durable personal context, model-led file discovery, and synthesis across retrieved facts | It has not yet been tested on this relationship query; the existing MVP already uses it successfully enough to pass its first gate. |
| Optional semantic/hybrid search | Finding conceptually related passages when wording or filenames differ | Better candidate retrieval does not itself perform exact relationship joins or guarantee current-state filtering. |
| Relational store | Exact filters and a small number of typed joins, such as `former_colleague AND city = Tokyo`, followed by an introducer lookup | It requires extraction, schema, synchronization, provenance, and authority decisions. Those costs need a demonstrated failure first. |
| Graph database | Variable-depth traversal across many relationship types and highly connected entities | The example is only a small, fixed traversal that a relational projection or one structured lookup tool could handle. A graph database is disproportionate at MVP scale. |
| Standalone vector database | Fuzzy semantic candidate retrieval over many chunks | Vector similarity is not a relationship query. It may return relevant text, but the model must still filter people, follow introducer links, and exclude stale facts. |

The relational/vector/graph comparisons above are architectural inferences from the documented interfaces, not Letta performance claims.

## Evaluation-first escalation path

### 1. Test the current product unchanged

Create a small, synthetic or staged-consent suite using the existing ingestion and question APIs. Include:

- several former colleagues in Tokyo and several distractors who fail one condition;
- relationship, location, and introduction facts split across different dated Transcripts;
- paraphrases and aliases, such as “based in Tokyo” versus “lives in Tokyo”;
- a move into or out of Tokyo, a corrected introducer, and a relationship update so stale facts must be excluded;
- direct one-hop control questions plus the full multi-hop question.

Score exact colleague-set precision and recall, colleague-to-introducer mapping accuracy, stale-fact violations, source/provenance accuracy, latency, and the files/tools used. Do not leak expected edges or operation labels into the agent prompt.

### 2. Diagnose the failing layer before changing architecture

- **Storage/consolidation failure:** the inspected Memory never retained a required fact or kept it only as stale/current incorrectly. First improve the ingestion instructions and MemFS organization, for example discoverable per-person files with current relationship, location, introducer, and source references.
- **Retrieval failure:** the facts are correct in Memory but the answering turn did not read them. First test a clearer index/link structure; then, if wording mismatch is recurrent, evaluate Letta's optional MemFS semantic/hybrid search.
- **Reasoning failure:** the correct facts were read but the answer filtered or joined them incorrectly. Repeat enough cases to separate model variance from a stable limitation; then consider a deterministic structured lookup tool.

### 3. Add the smallest justified capability

If failures persist after the Letta-native adjustments, begin with a narrow read-only client tool such as `find_people({ relationship, city, include: ["introduced_by"] })`. For this fixed query shape, a small relational projection is simpler than a graph database. Keep stable source identifiers in every result and explicitly decide whether the projection is rebuildable from Letta Memory or becomes an application-owned authority.

Use a graph database only after evaluation shows frequent, variable-depth relationship traversal that fixed relational queries become awkward. Use vector search only for a demonstrated fuzzy-discovery problem, not as the presumed solution to joins.

## MVP alignment

The current MVP explicitly keeps Letta as the owner of persistent memory and permits application-owned memory only after a recurring, product-relevant failure demonstrates a concrete need. It also already names a custom memory database as deferred. The evaluation-first path above follows that boundary rather than changing architecture on the basis of an untested concern. [MVP architecture and evaluation gate](../mvp.md#architecture), [deferred scope](../mvp.md#deferred)
