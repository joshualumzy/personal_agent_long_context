export const CONSENT_POLICY_VERSION = "consent-v1" as const;

export const CONSENT_ATTESTATIONS = [
  "uploader_only_identifiable_speaker",
  "all_identifiable_speakers_agreed",
] as const;

export type ConsentAttestation = (typeof CONSENT_ATTESTATIONS)[number];

export interface TranscriptSubmission {
  userId: string;
  sourceId: string;
  recordedAt: string;
  transcript: string;
  attestation: ConsentAttestation;
  policyVersion: typeof CONSENT_POLICY_VERSION;
}

export interface AcceptedTranscript extends TranscriptSubmission {
  correlationId: string;
  receivedAt: string;
}

export interface MemoryItem {
  label: string;
  content: string;
  description?: string;
  updatedAt?: string;
}

export interface MemoryInspection {
  userId: string;
  items: MemoryItem[];
}

export interface MemoryProvider {
  ingest(transcript: AcceptedTranscript): Promise<{ agentRef: string }>;
  inspect(userId: string): Promise<MemoryInspection>;
  close?(): Promise<void>;
}

export interface AcceptedSubmissionResult {
  status: "accepted";
  correlationId: string;
  receivedAt: string;
}

export interface RejectedSubmissionResult {
  status: "rejected";
  correlationId: string;
  receivedAt: string;
  code:
    | "invalid_request"
    | "invalid_attestation"
    | "invalid_policy_version"
    | "prohibited_data"
    | "memory_service_unavailable";
  message: string;
}

export type SubmissionResult =
  | AcceptedSubmissionResult
  | RejectedSubmissionResult;

export interface ApplicationResponse<T> {
  statusCode: number;
  body: T;
}
