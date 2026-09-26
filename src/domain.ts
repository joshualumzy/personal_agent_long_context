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

export interface QuestionSubmission {
  userId: string;
  question: string;
}

export interface AcceptedQuestion extends QuestionSubmission {
  correlationId: string;
  receivedAt: string;
}

export interface SourceReference {
  sourceId: string;
  label: string;
}

export interface MemoryAnswer {
  answer: string;
  sources: SourceReference[];
  /** Present when the Memory provider exposes a run to inspect. */
  runRef?: string;
}

export interface WorkingContextResult {
  contextConsidered: string;
  memoryUpdated: boolean;
  sources: SourceReference[];
}

export type PersonalMemoryStatus = "available" | "empty" | "unavailable";

export type PersonalMemoryContext =
  | { status: "available"; workingContext: string; sources: SourceReference[] }
  | { status: "empty"; workingContext: ""; sources: [] }
  | { status: "unavailable"; reason: string };

export interface MemoryProvider {
  ingest(transcript: AcceptedTranscript): Promise<{ agentRef: string }>;
  inspect(userId: string): Promise<MemoryInspection>;
  ask(question: AcceptedQuestion): Promise<MemoryAnswer>;
  getContext?(userId: string): Promise<PersonalMemoryContext>;
  getWorkingContextFast?(userId: string): Promise<WorkingContextResult | null>;
  processWorkingContext?(input: {
    userId: string;
    message: string;
  }): Promise<WorkingContextResult>;
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
  /** Present for `prohibited_data`. Names the category, never the value. */
  category?: string;
  /** Present for `prohibited_data`. The detection rule that matched. */
  rule?: string;
}

export interface AnsweredQuestionResult extends MemoryAnswer {
  status: "answered";
  correlationId: string;
  receivedAt: string;
}

export interface RejectedQuestionResult {
  status: "rejected";
  correlationId: string;
  receivedAt: string;
  code: "invalid_request" | "memory_service_unavailable";
  message: string;
}

export type QuestionResult = AnsweredQuestionResult | RejectedQuestionResult;

export type SubmissionResult =
  | AcceptedSubmissionResult
  | RejectedSubmissionResult;

export interface ApplicationResponse<T> {
  statusCode: number;
  body: T;
}
