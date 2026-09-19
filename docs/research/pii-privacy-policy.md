# PII and sensitive-data policy for the prototype

Research date: 2026-09-19

This note recommends product and engineering guardrails for the Personal Context Agent prototype. It is not legal advice and does not establish that any recording, use, or deployment is lawful. A Singapore-qualified lawyer should review the actual recording workflow, privacy notice, vendor contracts, and intended launch markets before a real consumer pilot.

Primary sources:

- Singapore Personal Data Protection Commission (PDPC), [Data Protection Obligations](https://www.pdpc.gov.sg/overview-of-pdpa/the-legislation/personal-data-protection-act/data-protection-obligations)
- PDPC, [Advisory Guidelines on Key Concepts in the PDPA](https://www.pdpc.gov.sg/guidelines-and-consultation/2020/03/advisory-guidelines-on-key-concepts-in-the-personal-data-protection-act)
- PDPC, [Guide to Data Protection by Design for ICT Systems](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Other-Guides/Guide-to-Data-Protection-by-Design-for-ICT-Systems-%28310519%29.pdf)
- PDPC, [Guide to Data Protection Practices for ICT Systems](https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/other-guides/tech-omnibus/guide-to-data-protection-practices-for-ict-systems.pdf)
- PDPC, [Guide to Basic Anonymisation](https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/advisory-guidelines/guide-to-basic-anonymisation-%28updated-24-july-2024%29.pdf)
- Singapore Statutes Online, [Personal Data Protection (Notification of Data Breaches) Regulations 2021](https://sso.agc.gov.sg/SL/PDPA2012-S64-2021?WholeDoc=1)
- PDPC, [Guide to Managing Data Intermediaries](https://www.pdpc.gov.sg/help-and-resources/2020/09/guide-to-managing-data-intermediaries)
- PDPC, [Guide on Data Protection Clauses for Agreements Relating to the Processing of Personal Data](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Resource-for-Organisation/Guide-on-Data-Protection-Clauses-for-Agreements-Relating-to-the-Processing-of-Personal-Data-1-Feb-2021.pdf)
- Payment Card Industry Security Standards Council (PCI SSC), [Are audio/voice recordings permitted to contain sensitive authentication data?](https://www.pcisecuritystandards.org/faqs/1210/)

## Current MVP interpretation

The implementation boundary is defined in [`docs/mvp.md`](../mvp.md). For the transcript-first MVP, the implemented controls are limited to deliberate synthetic, staged-consent, or first-party submissions; a consent attestation; a basic gate for obvious prohibited data; and truthful disclosure of limitations.

The production controls below remain risk guidance. Multiple segregated stores, tenant administration, comprehensive classification, verified deletion cascades, vendor governance, incident response, and the full acceptance-test catalogue are deferred and must not be claimed as implemented.

## Bottom line

Do **not** remove all personal data. Names, relationships, preferences, commitments, and other ordinary personal details are often the facts that make a Personal Context Agent useful. The appropriate principle is purpose-bound minimisation: retain only the least-sensitive data necessary for a stated feature, with user visibility and control. PDPC's data-protection-by-design guidance specifically advises against collecting first and deciding what to do later; it recommends collecting only relevant and necessary data, using the least-sensitive type that serves the purpose, and collecting it only when needed rather than continuously. [PDPC DPbD guide, pp. 6–7 and 13](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Other-Guides/Guide-to-Data-Protection-by-Design-for-ICT-Systems-%28310519%29.pdf)

At the same time, some information has no defensible purpose in agent memory and creates disproportionate harm. Authentication secrets, payment-card security data, private cryptographic keys, government identifier numbers, and financial account numbers should never enter long-term memory, embeddings, prompts, analytics, or logs. Detect them during ingestion, irreversibly replace them with a typed marker, and promptly remove any raw source that still contains them.

The prototype should accept only deliberately uploaded solo recordings or recordings for which every speaker has affirmatively consented to this processing. Calling a file "first-party" does not eliminate the personal data of other people audible in it. For the course and hackathon, use synthetic, staged, or participant-consented recordings; no ambient capture, bystander recordings, or real customer production data.

## What the PDPA baseline means for this product

Under the PDPA, personal data is data about an identifiable individual, whether identification is possible from that data alone or together with other information the organisation has or is likely to access. The Act is not limited to a list of fields commonly called "PII." [PDPC PDPA overview](https://www.pdpc.gov.sg/overview-of-pdpa/the-legislation/personal-data-protection-act)

For an organisation operating this product, the practical baseline is to:

- notify users of the purposes for collection, use, and disclosure;
- obtain consent unless an exception applies, support withdrawal, and stop the affected processing after withdrawal;
- limit collection, use, and disclosure to reasonable, notified purposes;
- take reasonable steps on accuracy where data may affect the individual;
- provide appropriate access and correction processes;
- make reasonable security arrangements;
- stop retaining or properly dispose of data when it is no longer needed;
- ensure comparable protection for overseas transfers; and
- assess breaches for mandatory notification obligations. [PDPC Data Protection Obligations](https://www.pdpc.gov.sg/overview-of-pdpa/the-legislation/personal-data-protection-act/data-protection-obligations)

These duties are separate. Redaction does not replace security, encryption does not justify indefinite retention, consent does not make an excessive purpose reasonable, and deleting a memory index does not delete its source audio, transcript, caches, vendor copies, or backups.

## Recommended classification and handling rules

The categories below are a conservative **product policy**, not a claim that Singapore law assigns each category the same formal legal status.

| Tier | Examples | Long-term memory policy | Source/evidence policy |
| --- | --- | --- | --- |
| Useful personal context | The user's name, ordinary preferences, projects, plans, commitments, relationship labels, and names needed to distinguish people | Allowed when needed for a visible feature. Make every memory inspectable, correctable, and deletable. | Retain only the minimum supporting transcript span; avoid full-transcript retrieval when a narrow span suffices. |
| Prohibited secrets and identifiers | Passwords, PINs, one-time codes, API keys, recovery phrases, answers to security questions, private cryptographic keys, full payment-card numbers, CVV/CVC/CID, bank-account numbers, NRIC/passport/FIN and other government identifier numbers | Never store in memory, vector embeddings, model prompts, telemetry, logs, or evaluation datasets. Replace with markers such as `[PAYMENT_CARD_REDACTED]`. | Delete or irreversibly redact as early as technically possible. Raw audio containing such data must not be retained. |
| Restricted sensitive context | Health and mental-health details, financial position or debt, precise home/location history, sexual life, religion, political beliefs, legal allegations, information about children or vulnerable people | Off by default. Require a separate, specific opt-in and a clear user benefit. Keep in a segregated encrypted store with narrower retrieval and no autonomous action. | Retain only a minimal evidence span; do not reuse for model training, analytics, demos, or benchmark corpora. |
| Voice and biometric material | Raw voice recordings, speaker embeddings, voiceprints, emotion or health inference from voice | Raw audio is temporary by default. Do not create voiceprints, perform speaker authentication, or infer sensitive traits in the MVP. Any future biometric feature requires a fresh review and explicit opt-in. | Delete raw audio after transcript verification or at the short automatic deadline, whichever comes first. |
| Other people's information | A named colleague, family member, or other speaker; statements about their preferences, health, finances, or behaviour | Do not create general third-party profiles. A minimal relationship fact needed by the user, such as "Alice is my supervisor," may be retained, but sensitive traits about Alice are blocked unless there is a reviewed lawful basis and consent workflow. | Only ingest multi-speaker audio when all speakers have affirmatively consented; otherwise reject it for this prototype. |

The breach-notification regulations illustrate why the prohibited and restricted tiers deserve stronger treatment. They identify combinations involving government identifiers, payment-card and bank-account numbers, account credentials/security codes, authentication biometrics, private keys, financial information, and specified health or vulnerable-person information as capable of producing significant harm in the prescribed circumstances. [Personal Data Protection (Notification of Data Breaches) Regulations 2021, regulation 3 and Schedule](https://sso.agc.gov.sg/SL/PDPA2012-S64-2021?WholeDoc=1)

The payment-card rule should be especially strict. PCI SSC states that card verification codes must not remain in digital audio after transaction authorisation and recommends preventing their recording or securely deleting them. Although PCI DSS applicability depends on the product's payment role, there is no product reason for this agent to keep card security data at all. [PCI SSC FAQ 1210](https://www.pcisecuritystandards.org/faqs/1210/)

### Safe treatment of names, relationships, and preferences

Preserve useful ordinary identity context, but compartmentalise it:

1. Give each person an internal random entity ID.
2. Store the display name and relationship label separately from semantic memory records and encrypt both stores.
3. Put the entity ID, not the raw name, into embeddings where practical.
4. Retrieve the name mapping only after the authenticated user's request is authorised.
5. Store no inferred sensitive traits and no contact details unless a feature specifically needs them.
6. Show the user exactly what the system believes, the supporting evidence, and the controls to correct, semantically invalidate, or privacy-delete it.

This is pseudonymisation and compartmentalisation, not anonymisation. Longitudinal personal histories are often re-identifiable from combinations of facts. PDPC warns that complex datasets containing longitudinal or sensitive data may require expert assessment, and its basic guide does not cover anonymising audio or biometric data. [PDPC Guide to Basic Anonymisation, p. 5](https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/advisory-guidelines/guide-to-basic-anonymisation-%28updated-24-july-2024%29.pdf)

## Production-oriented workflow

### 1. Before upload

Show a short, just-in-time notice that names the purposes: transcription, memory extraction, retrieval, provenance display, and evaluation if applicable. Separately identify each external transcription, embedding, LLM, storage, and analytics provider and whether data leaves Singapore. Do not bundle optional research, model training, or product analytics into consent required for core operation. Maintain a versioned consent record and a withdrawal route. PDPC recommends purpose notices at relevant interaction points and a means to withdraw consent. [PDPC DPbD guide, pp. 15–17](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Other-Guides/Guide-to-Data-Protection-by-Design-for-ICT-Systems-%28310519%29.pdf)

Require the uploader to attest that the file is either a solo self-recording or that every identifiable speaker agreed to transcription and memory processing. Reject ambient, covert, or unknown-speaker recordings in the prototype. An attestation is a guardrail, not a legal conclusion; the production consent flow remains an unresolved legal question.

### 2. During ingestion

- Place uploads in an encrypted, access-restricted temporary area.
- Transcribe without training the vendor's model on the content.
- Run deterministic pattern detectors plus contextual entity detection for prohibited data before generating embeddings or sending text to a general LLM.
- Quarantine and warn instead of silently storing when confidence is low.
- Produce a redacted transcript for downstream processing; never depend on prompting the model to ignore secrets.
- Do not log raw prompts, transcripts, model responses, file names, or signed URLs. Use random job IDs and masked diagnostics.

PDPC's current ICT guide says to assess whether personal or sensitive data is really needed across both AI training and inference datasets, obtain meaningful consent, monitor prompts/API requests for exfiltration attempts, and minimise personal data in logs. [PDPC Guide to Data Protection Practices for ICT Systems, pp. 23 and 41](https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/other-guides/tech-omnibus/guide-to-data-protection-practices-for-ict-systems.pdf)

### 3. In storage and retrieval

- Encrypt personal data at rest and in transit; keep encryption keys separate from encrypted data.
- Enforce tenant isolation and least-privilege access at the application, database, object-store, and administrative layers.
- Require MFA for administrative access and log reads, writes, exports, corrections, and deletions without logging the personal content itself.
- Keep raw audio, redacted transcript/evidence, derived memory state, identity mapping, embeddings, and audit metadata in distinct stores with distinct access paths.
- Apply sensitivity labels to memory items and enforce retrieval rules before, not after, content enters an LLM prompt.
- Never use customer content to train or fine-tune models by default.

These controls follow PDPC recommendations for encryption at rest and in transit, separation of keys, least privilege, MFA for stronger access control, protected logs, and database activity monitoring. [PDPC Guide to Data Protection Practices for ICT Systems, pp. 18, 22, 30, and 41–43](https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/other-guides/tech-omnibus/guide-to-data-protection-practices-for-ict-systems.pdf)

### 4. Retention and deletion

The PDPA does not provide one universal retention period. It requires organisations to cease retaining personal data, or remove the means of associating it with individuals, when it is no longer needed for a legal or business purpose. PDPC recommends repository-specific minimum/maximum periods, automated expiry, deletion of temporary files, and coverage of backups and archives. [PDPC Data Protection Obligations](https://www.pdpc.gov.sg/overview-of-pdpa/the-legislation/personal-data-protection-act/data-protection-obligations) and [ICT guide, pp. 16 and 21–22](https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/other-guides/tech-omnibus/guide-to-data-protection-practices-for-ict-systems.pdf)

Recommended defaults for a future audio-capable prototype:

- **Raw audio:** delete immediately after the user verifies the transcript, with a hard maximum of 24 hours after successful transcription. Retention beyond that is a separate, optional user choice that is disabled for the course/hackathon build.
- **Processing files and caches:** delete when the ingestion job completes; hard maximum 24 hours.
- **Redacted transcript evidence and derived memory:** for prototype participants, delete at withdrawal, account/project deletion, 30 days after the test ends, or project close—whichever happens first. Use synthetic benchmark data for long-duration testing.
- **Operational logs:** content-free only, with a defined short period sufficient for security and debugging.
- **Backups:** document the ageing period, exclude raw audio where practical, prevent deleted data from returning on restore, and complete deletion when the backup expires.

Privacy Deletion must cascade through source audio, transcripts, extracted spans, identity maps, memories, embeddings/vector indexes, search indexes, caches, queued jobs, evaluation exports, vendor copies, and backup-expiry records. Return a deletion receipt listing completed and pending stages. This is distinct from Semantic Invalidation, which preserves Evidence History but removes an obsolete fact from Current Truth.

## Vendors, cloud models, and overseas processing

Treat transcription, LLM, embedding, database, object-storage, monitoring, and backup providers as part of the data flow. Before using a provider, record:

- processing purpose and fields sent;
- storage and processing locations;
- whether prompts or outputs are retained or used for training;
- subprocessors;
- encryption and access controls;
- deletion and return capabilities, including backups;
- breach-notification commitment; and
- contract terms supporting comparable protection for transfers outside Singapore.

PDPC states that overseas transfers require a comparable standard of protection. Its sample processing clauses cover purpose limitation, overseas-transfer protections, security, need-to-know access, correction, deletion/return, and breach notification; it also warns that using sample clauses alone does not establish compliance. [PDPC Data Protection Obligations](https://www.pdpc.gov.sg/overview-of-pdpa/the-legislation/personal-data-protection-act/data-protection-obligations) and [Guide on Data Protection Clauses, pp. 2–8](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Resource-for-Organisation/Guide-on-Data-Protection-Clauses-for-Agreements-Relating-to-the-Processing-of-Personal-Data-1-Feb-2021.pdf)

For the prototype, prefer local processing or a provider configuration with no training, minimal retention, contractual deletion, and a known region. Do not send prohibited secrets or identifiers to a provider even if its contract is otherwise acceptable.

## Production-oriented acceptance tests

The privacy claim should be tested, not only documented:

1. Seed transcripts with every prohibited category and verify none appears in memory records, embeddings, prompts, responses, logs, analytics, or exports.
2. Seed names and ordinary relationships and verify they remain useful, user-visible, correctable, and isolated to the right account.
3. Verify restricted memories are not created without explicit opt-in and are not retrieved for unrelated questions.
4. Verify raw audio expires automatically and is absent from object storage and job caches after the deadline.
5. Execute Privacy Deletion and prove the cascade across all live stores; separately report backup expiry rather than falsely claiming immediate backup erasure.
6. Execute Semantic Invalidation and prove that old evidence remains visible while the obsolete fact cannot become Current Truth.
7. Confirm that application users and administrators cannot access another user's data; require MFA for administrative access.
8. Confirm logs contain identifiers for audit events but no transcript, prompt, secret, signed URL, or raw personal content.
9. Simulate vendor failure and a suspected breach; verify containment, assessment, evidence preservation, and notification escalation paths.

## Unresolved legal and governance questions

Obtain qualified advice before moving beyond staged prototype data:

1. **Recording law and multi-party consent:** What legal bases and notices are required for recording conversations in Singapore and every intended market, including private places, workplaces, calls, and cross-border conversations? The PDPA analysis does not by itself answer whether making the recording was lawful.
2. **Third-party personal data:** Is uploader attestation sufficient for any real use case, or must each speaker receive notice and provide consent to recording, transcription, memory extraction, vendor disclosure, and retention? How will withdrawal by a non-account-holder work?
3. **Organisation roles:** Which entity is the organisation deciding purposes, which vendors are data intermediaries, and is the necklace maker, student team, university, hackathon organiser, or cloud provider a separate organisation or joint decision-maker in any environment?
4. **Research/course governance:** Do university ethics, institutional review, participant-information, or research-data rules apply to recordings or evaluation participants even when the PDPA has an exception?
5. **Cross-border transfer:** Where does each model/vendor actually process and back up data, and what legally enforceable transfer mechanism supplies comparable protection?
6. **Children and vulnerable users:** Should the initial product exclude minors entirely? What verification, parental-authority, and safeguarding rules would be required otherwise?
7. **Sensitive-memory consent:** Is category-level opt-in sufficient for health, financial, or other restricted memory, or is item-level confirmation required for the intended product claims and risk level?
8. **Access, correction, and deletion involving others:** How should an access export avoid revealing another person's personal data, and how should conflicting deletion/access requests between the account holder and another recorded speaker be resolved? PDPC notes that access may be restricted when it would reveal another individual's personal data or identity. [PDPC Individuals Overview](https://www.pdpc.gov.sg/overview-of-pdpa/data-protection/individual/individuals-overview)
9. **Breach response:** Who will serve as DPO and incident owner, and what operational process will assess significant harm/scale and meet any notification deadline?
10. **Retention schedule:** What periods can the product justify for redacted evidence, derived memory, security logs, and backups once the actual feature set and contracts are known?

## Recommended public-facing boundary

> The prototype processes audio or transcripts that users deliberately submit and are authorised to provide. It retains useful personal context only for the stated assistance features, blocks secrets and high-risk identifiers from agent memory, places sensitive memories behind explicit opt-in, preserves provenance, and supports correction and deletion. It does not perform always-on recording, covert capture, voice identification, sensitive-trait inference, or general profiling of other people.

Do not claim that the prototype is "PDPA compliant" or that redaction makes recordings anonymous. Claim only the concrete controls that have been implemented and tested.
