import { randomUUID } from "node:crypto";
import {
  CONSENT_ATTESTATIONS,
  CONSENT_POLICY_VERSION,
  type AcceptedTranscript,
  type ApplicationResponse,
  type MemoryInspection,
  type MemoryProvider,
  type SubmissionResult,
  type TranscriptSubmission,
} from "./domain.js";
import { detectProhibitedData } from "./prohibited-data.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ApplicationOptions {
  clock?: () => Date;
  correlationId?: () => string;
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

export class PersonalContextApplication {
  private readonly clock: () => Date;
  private readonly correlationId: () => string;

  constructor(
    private readonly memory: MemoryProvider,
    options: ApplicationOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.correlationId = options.correlationId ?? randomUUID;
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

    const prohibitedCategory = detectProhibitedData(parsed.submission.transcript);
    if (prohibitedCategory) {
      return {
        statusCode: 422,
        body: {
          status: "rejected",
          correlationId,
          receivedAt,
          code: "prohibited_data",
          message: `This Transcript appears to contain a ${prohibitedCategory}. Remove it before submitting.`,
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
    } catch {
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
