# PDPA consent attestation for text and audio submissions

Research date: 2026-09-20

This note answers a narrow product question: whether the Personal Context Agent needs a consent checkbox every time a user submits text or audio, and how the surrounding notice and consent flow should work under Singapore's Personal Data Protection Act 2012 (PDPA). It is product research, not legal advice. A Singapore-qualified lawyer should review the actual recording contexts, privacy notice, vendor arrangements, and launch markets before use with real third-party recordings.

The current MVP boundary in [`docs/mvp.md`](../mvp.md) remains controlling: use only synthetic, staged-consent, or first-party transcripts; audio upload is a stretch goal; and do not claim production privacy compliance.

## Short answer

The PDPA does **not** prescribe a per-upload checkbox. It requires an organisation to have a valid basis for collecting, using, and disclosing personal data, to notify individuals of the relevant purposes on or before collection, and to limit processing to reasonable purposes. PDPC guidance says notification may be given before the first collection in a series of recurring collections and need not be repeated before every collection unless a new purpose arises. [PDPA ss. 13, 14, 18 and 20](https://sso.agc.gov.sg/Act/PDPA2012?ProvIds=pr13-%2Cpr14-%2Cpr18-%2Cpr20-); [PDPC Advisory Guidelines on Key Concepts, paras. 14.5–14.6 and 14.21–14.23](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Advisory-Guidelines/AG-on-Key-Concepts/Advisory-Guidelines-on-Key-Concepts-in-the-PDPA-17-May-2022.pdf#page=83)

A per-upload speaker attestation can nevertheless materially help as a **risk control and evidence of due diligence** when the upload contains another person's personal data. PDPC guidance says an organisation obtaining personal data from a third-party source should check whether the source can validly consent on the individual's behalf or obtained the individual's consent to disclosure. Suggested checks include a contractual undertaking and written, documented verbal, or documentary confirmation. Such checks may be mitigating evidence if the source concealed the absence of consent; they do not create consent that never existed or make an otherwise unlawful recording lawful. [PDPC Advisory Guidelines on Key Concepts, paras. 12.33–12.35](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Advisory-Guidelines/AG-on-Key-Concepts/Advisory-Guidelines-on-Key-Concepts-in-the-PDPA-17-May-2022.pdf)

Therefore, neither extreme is suitable:

- a privacy policy or terms link by itself is too weak to establish that every identifiable speaker agreed to this particular processing; but
- making the user re-accept a long legal statement on every first-party text submission adds friction without answering a changing factual question.

## What the PDPA baseline means here

### Whose data is involved

Typed text, a transcript, audio content, and associated metadata can be personal data whenever an individual can be identified from that material alone or together with information the organisation has or is likely to access. A voice recording is not automatically biometric data merely because it contains a voice, but it may still be ordinary personal data and may reveal sensitive facts. [PDPC, PDPA Overview](https://www.pdpc.gov.sg/overview-of-pdpa/the-legislation/personal-data-protection-act)

An individual acting in a personal or domestic capacity is generally outside the PDPA, but the service operator remains an organisation handling the submitted personal data. The user's personal/domestic exclusion therefore does not remove the operator's obligations. [PDPC, PDPA Overview](https://www.pdpc.gov.sg/overview-of-pdpa/the-legislation/personal-data-protection-act)

For the account holder's own text or solo audio, clear notice followed by deliberate submission may support express consent or, depending on the facts, deemed consent by conduct. For an identifiable non-user speaker, the uploader's own agreement to the service's terms is not that speaker's consent. The operator needs a consent pathway, an applicable statutory exception, or another properly assessed basis; the product should not assume one merely because the uploader possesses the file. [PDPC Advisory Guidelines on Key Concepts, paras. 12.3–12.5, 12.9–12.10 and 12.33–12.35](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Advisory-Guidelines/AG-on-Key-Concepts/Advisory-Guidelines-on-Key-Concepts-in-the-PDPA-17-May-2022.pdf#page=38)

### Notice, consent, and terms do different jobs

| Mechanism | Product role | What it does not prove |
| --- | --- | --- |
| Privacy notice | Explains what is collected; transcription, memory, retrieval, and evaluation purposes; recipients/processors; retention; transfers; withdrawal; and DPO contact | That another speaker actually agreed |
| Terms of service | Sets the contract with the uploader, including permitted-content rules and responsibility for having authority to upload | Consent by a non-party speaker |
| Onboarding consent | Records the account holder's informed choice for stable, core processing purposes | That every future file has the same speakers or provenance |
| Just-in-time upload notice | Puts the important processing consequences in front of the user at the relevant moment | By itself, authority over third-party data |
| File-specific speaker attestation | Records the uploader's representation about the changing facts of this file | A legal safe harbour or independent verification of speaker consent |

The PDPC recommends concise, layered notices and a just-in-time notice immediately before relevant collection or permission, while keeping a fuller policy available. It also recommends an explicit, non-pre-ticked action where consent is being requested and retaining the wording, version, time, and scope of consent records. [PDPC, Guide to Data Protection by Design for ICT Systems, pp. 15–18](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Other-Guides/Guide-to-Data-Protection-by-Design-for-ICT-Systems-%28310519%29.pdf); [PDPC, Guide to Notification, pp. 14, 17 and 21](https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/other-guides/guide-to-notification-260919.pdf#page=14)

Consent is not the whole compliance programme. The organisation must still support withdrawal where consent is relied upon, stop affected processing unless another legal basis applies, use reasonable security, limit retention, control overseas transfers, and meet the other applicable PDPA obligations. [PDPC, Data Protection Obligations](https://www.pdpc.gov.sg/overview-of-pdpa/the-legislation/personal-data-protection-act/data-protection-obligations)

The PDPA analysis also does not, by itself, determine whether the original act of recording was lawful in every setting. Workplace rules, duties of confidence, sector rules, contractual restrictions, and the law of another jurisdiction may also matter.

## Recommended product pattern

Use a layered flow rather than treating a single checkbox as the solution:

1. **Full privacy notice, always available.** Describe the actual data flow and purposes, including transcription and model/storage providers, whether data leaves Singapore, retention and deletion, and how to contact the DPO or withdraw consent.
2. **Onboarding acknowledgment and consent for the account holder's own data.** Obtain one clear, non-pre-ticked action for the stable core purposes. Record the notice version, purposes, timestamp, and account. Ask again only if a material new purpose or materially different processing is introduced.
3. **Short just-in-time notice at first audio use and after material changes.** Explain that audio may contain other people's personal data, will be transcribed, and may be converted into persistent memory. Link to the full notice.
4. **A concise file-specific speaker-status choice for each audio upload.** For example: “Only I am identifiable”; “Other people are identifiable, and I have confirmed they agreed to transcription and memory processing”; or “I am not sure.” Accept the first two; reject or quarantine the third for this prototype. Do not preselect an answer.
5. **No repeated speaker checkbox for ordinary first-party typed notes.** Show a lightweight reminder that third-party personal data and prohibited data should not be submitted. If pasted conversations, transcripts, or other substantial third-party content are later supported, apply the same source and consent checks as audio.
6. **Allow scoped batch confirmation only when the scope is real.** A staged study session or batch with the same named participants, purposes, and retention rules may use one documented attestation for that batch. Reconfirm when participants, purpose, processing, or scope changes.

This pattern follows the PDPC's layered and just-in-time design guidance while preserving a file-level record for the fact that actually changes. It should reduce ritual clicking without pretending that general terms establish third-party consent.

## Product decisions to record in issue #9

1. **MVP admission rule:** accept only solo first-party material, synthetic data, or staged recordings with affirmative agreement from every identifiable speaker. Reject ambient, covert, unknown-speaker, and uncertain-consent material.
2. **Attestation cadence:** use a per-audio speaker-status choice; allow a narrowly scoped batch attestation only for a defined staged session. Do not repeat the long privacy policy on every upload.
3. **Processing scope disclosed:** decide whether audio is only transcribed or whether raw audio, transcripts, and derived memories are retained; name any external providers and transfers.
4. **Evidence retained:** store the attestation answer, notice/wording version, account, timestamp, file or batch identifier, and declared scope. Do not store supposed speaker signatures unless there is a real need and reviewed process.
5. **Failure behavior:** block or quarantine uploads when the user chooses “not sure”; do not infer consent from silence, a filename, or completion of the upload.
6. **Withdrawal route:** define how the account holder or an identifiable speaker can contact the operator and what deletion or cessation can actually be performed across audio, transcripts, memories, vendors, logs, and backups.

For issue #9, frame this as a cross-cutting product decision about **third-party personal data**, under submission methods and provenance rather than only under audio. A separate implementation issue becomes useful only when third-party content or audio moves into active scope and the team is ready to specify notice copy, evidence fields, withdrawal handling, retention, and tests.
