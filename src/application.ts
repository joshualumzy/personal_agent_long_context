import { randomUUID } from "node:crypto";
import {
  CONSENT_ATTESTATIONS,
  CONSENT_POLICY_VERSION,
  type AcceptedTranscript,
  type ApplicationResponse,
  type MemoryInspection,
  type MemoryProvider,
  type QuestionResult,
  type QuestionSubmission,
  type SubmissionResult,
  type TranscriptSubmission,
} from "./domain.js";
import { detectProhibitedData } from "./prohibited-data.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const identifierRule =
  "must be 1\u2013128 characters using letters, numbers, dot, underscore, colon, or hyphen.";

/**
 * A failure record for the server-side log. It carries identifiers only:
 * `docs/research/pii-privacy-policy.md` requires operational logs to stay
 * content-free, so no Transcript text, question text, or Memory content
 * belongs in this shape.
 */
export interface ApplicationFailure {
  operation: "submit" | "ask";
  correlationId: string;
  userId: string | null;
  reason: string;
}

export interface ApplicationOptions {
  clock?: () => Date;
  correlationId?: () => string;
  onFailure?: (failure: ApplicationFailure) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSubmission(
  input: unknown,
):
  | { submission: TranscriptSubmission }
  | { code: "invalid_request" | "invalid_attestation" | "invalid_policy_version"; message: string } {
  if (!isRecord(input)) {
    return { code: "invalid_request", message: "A JSON request body is required." };
  }

  if (
    typeof input.attestation !== "string" ||
    !CONSENT_ATTESTATIONS.includes(
      input.attestation as (typeof CONSENT_ATTESTATIONS)[number],
    )
  ) {
    return {
      code: "invalid_attestation",
      message: "Select one of the two current Consent Attestation choices.",
    };
  }

  if (input.policyVersion !== CONSENT_POLICY_VERSION) {
    return {
      code: "invalid_policy_version",
      message: "Refresh the page and review the current Consent Attestation.",
    };
  }

  const requiredStrings = ["userId", "sourceId", "recordedAt", "transcript"] as const;
  if (
    requiredStrings.some(
      (key) => typeof input[key] !== "string" || input[key].trim().length === 0,
    )
  ) {
    return {
      code: "invalid_request",
      message: "User, source, recorded time, and Transcript text are required.",
    };
  }

  const userId = (input.userId as string).trim();
  const sourceId = (input.sourceId as string).trim();
  const recordedAt = (input.recordedAt as string).trim();
  const transcript = (input.transcript as string).trim();

  if (!identifierPattern.test(userId) || !identifierPattern.test(sourceId)) {
    return {
      code: "invalid_request",
      message:
        "User and source identifiers must be 1–128 characters using letters, numbers, dot, underscore, colon, or hyphen.",
    };
  }

  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      recordedAt,
    ) ||
    Number.isNaN(Date.parse(recordedAt))
  ) {
    return {
      code: "invalid_request",
      message: "Recorded time must be a valid ISO 8601 timestamp with a timezone.",
    };
  }

  if (transcript.length > 50_000) {
    return {
      code: "invalid_request",
      message: "Transcript text must be 50,000 characters or fewer.",
    };
  }

  return {
    submission: {
      userId,
      sourceId,
      recordedAt: new Date(recordedAt).toISOString(),
      transcript,
      attestation: input.attestation as TranscriptSubmission["attestation"],
      policyVersion: CONSENT_POLICY_VERSION,
    },
  };
}

function parseQuestion(
  input: unknown,
): { question: QuestionSubmission } | { code: "invalid_request"; message: string } {
  if (!isRecord(input)) {
    return { code: "invalid_request", message: "A JSON request body is required." };
  }

  if (
    typeof input.userId !== "string" ||
    !identifierPattern.test(input.userId.trim())
  ) {
    return {
      code: "invalid_request",
      message: `User identifier ${identifierRule}`,
    };
  }

  if (typeof input.question !== "string" || input.question.trim().length === 0) {
    return { code: "invalid_request", message: "A question is required." };
  }

  const question = input.question.trim();
  if (question.length > 2_000) {
    return {
      code: "invalid_request",
      message: "A question must be 2,000 characters or fewer.",
    };
  }

  return { question: { userId: input.userId.trim(), question } };
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown failure.";
}

export class PersonalContextApplication {
  private readonly clock: () => Date;
  private readonly correlationId: () => string;
  private readonly onFailure: (failure: ApplicationFailure) => void;

  constructor(
    private readonly memory: MemoryProvider,
    options: ApplicationOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.correlationId = options.correlationId ?? randomUUID;
    this.onFailure = options.onFailure ?? (() => {});
  }

  async submit(input: unknown): Promise<ApplicationResponse<SubmissionResult>> {
    const correlationId = this.correlationId();
    const receivedAt = this.clock().toISOString();
    const parsed = parseSubmission(input);

    if ("code" in parsed) {
      return {
        statusCode: 400,
        body: { status: "rejected", correlationId, receivedAt, ...parsed },
      };
    }

    const prohibited = detectProhibitedData(parsed.submission.transcript);
    if (prohibited) {
      return {
        statusCode: 422,
        body: {
          status: "rejected",
          correlationId,
          receivedAt,
          code: "prohibited_data",
          category: prohibited.category,
          rule: prohibited.rule,
          message: `This Transcript appears to contain a ${prohibited.category}. Remove it before submitting. Your text is still in the form.`,
        },
      };
    }

    const accepted: AcceptedTranscript = {
      ...parsed.submission,
      correlationId,
      receivedAt,
    };

    try {
      await this.memory.ingest(accepted);
    } catch (error) {
      this.onFailure({
        operation: "submit",
        correlationId,
        userId: accepted.userId,
        reason: failureReason(error),
      });
      return {
        statusCode: 503,
        body: {
          status: "rejected",
          correlationId,
          receivedAt,
          code: "memory_service_unavailable",
          message: "The Memory service is unavailable. Your Transcript was not accepted.",
        },
      };
    }

    return {
      statusCode: 202,
      body: { status: "accepted", correlationId, receivedAt },
    };
  }

  async ask(input: unknown): Promise<ApplicationResponse<QuestionResult>> {
    const correlationId = this.correlationId();
    const receivedAt = this.clock().toISOString();
    const parsed = parseQuestion(input);

    if ("code" in parsed) {
      return {
        statusCode: 400,
        body: { status: "rejected", correlationId, receivedAt, ...parsed },
      };
    }

    try {
      const answer = await this.memory.ask({
        ...parsed.question,
        correlationId,
        receivedAt,
      });
      return {
        statusCode: 200,
        body: { status: "answered", correlationId, receivedAt, ...answer },
      };
    } catch (error) {
      this.onFailure({
        operation: "ask",
        correlationId,
        userId: parsed.question.userId,
        reason: failureReason(error),
      });
      return {
        statusCode: 503,
        body: {
          status: "rejected",
          correlationId,
          receivedAt,
          code: "memory_service_unavailable",
          message: "The Memory service could not answer right now. Try again shortly.",
        },
      };
    }
  }

  async inspect(userId: string): Promise<ApplicationResponse<MemoryInspection>> {
    const normalized = userId.trim();
    if (!identifierPattern.test(normalized)) {
      return {
        statusCode: 400,
        body: { userId: normalized, items: [] },
      };
    }

    return { statusCode: 200, body: await this.memory.inspect(normalized) };
  }
}
