# Personal Context Agent

A consumer-product domain focused on preserving useful continuity across a user's long-form voice recordings so an agent can assist with later tasks.

## Language

**Personal Context Agent**:
A standalone consumer product that uses deliberately submitted audio and transcripts to maintain continuity across a user's changing information.
_Avoid_: Recording Necklace companion, Personal Contact Agent

**Recording Necklace**:
A consumer wearable produced by the SME that captures long-form voice recordings for later processing by the product.
_Avoid_: Agent, assistant

**Transcript**:
The textual record derived from a recording. It is source evidence for the product, not the agent's memory itself.
_Avoid_: Memory

**Submitted Audio**:
Prerecorded, first-party audio that the user deliberately provides for processing within the prototype's privacy boundary.
_Avoid_: Live capture, always-on recording

**Voice Note**:
A deliberately submitted solo recording or transcript in which the user records personal plans, preferences, commitments, or goals.
_Avoid_: Recorded conversation

**Memory**:
Useful Personal Context retained by the agent for assistance in later interactions. A Transcript may contribute to Memory but remains source material rather than Memory itself.
_Avoid_: Transcript, recording

**Memory Update**:
A later statement that changes, supersedes, or cancels information retained from an earlier transcript.
_Avoid_: Duplicate memory

**Semantic Invalidation**:
A Memory Update that makes earlier information inactive for future answers without requiring its source history to be erased.
_Avoid_: Deletion, forgetting

**Privacy Deletion**:
Erasure of selected source evidence and its derived data rather than merely making it inactive for retrieval.
_Avoid_: Cancellation, semantic invalidation

**Current Truth**:
The latest unambiguous version of the user's information after applicable Memory Updates have been considered.
_Avoid_: Latest statement

**Evidence History**:
The available source passages and sequence of Memory Updates that explain how the Current Truth changed over time.
_Avoid_: Current memory

**Memory Conflict**:
Two incompatible statements for which the user has not expressed a clear update; the Current Truth remains unresolved until the user clarifies.
_Avoid_: Latest statement wins

**Useful Personal Context**:
Names, relationships, preferences, commitments, and similar personal information retained because a visible assistance feature needs it.
_Avoid_: All PII

**Prohibited Data**:
Credentials, authentication secrets, payment or bank details, private keys, and government identifiers that must never become long-term memory.
_Avoid_: Sensitive memory

**Restricted Memory**:
Sensitive personal context, such as health, detailed financial, biometric, or precise-location information, that requires stronger controls than ordinary Useful Personal Context.
_Avoid_: Prohibited data

**Consent Attestation**:
The uploader's confirmation that they are the only identifiable speaker or that every identifiable speaker agreed to transcription and memory processing.
_Avoid_: Consent verification
