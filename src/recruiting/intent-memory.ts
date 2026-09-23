import { randomUUID } from "node:crypto";
import { CONSENT_POLICY_VERSION, type MemoryProvider } from "../domain.js";
import { detectProhibitedData } from "../prohibited-data.js";
import type { HiringEvent } from "./domain.js";

/**
 * The founder's hiring intent is Memory: criteria versions, feedback reasons,
 * accepted preferences, expansion steps. Each event goes to the same Letta
 * agent that holds the founder's other Personal Context, through the same
 * ingestion path, so "why do we require Rust?" can be answered later.
 *
 * Candidate records never pass through here. Events are sent in order on one
 * queue because Letta applies Memory Updates by `recorded_at`, and a slow turn
 * must not block the founder's screen.
 */
export interface IntentMemory {
  record(event: HiringEvent): void;
  ask(question: string): Promise<string>;
  pending(): number;
}

export class LettaIntentMemory implements IntentMemory {
  private queue: Promise<void> = Promise.resolve();
  private inFlight = 0;

  constructor(
    private readonly memory: MemoryProvider,
    private readonly userId: string,
    private readonly onFailure: (reason: string) => void = () => {},
  ) {}

  record(event: HiringEvent): void {
    const transcript = `Hiring for my company (${event.kind}): ${event.summary}`;
    // The founder's words can carry anything; Prohibited Data never reaches Memory.
    if (detectProhibitedData(transcript)) {
      this.onFailure("A hiring event held Prohibited Data and was not sent to Memory.");
      return;
    }
    this.inFlight += 1;
    this.queue = this.queue
      .then(() =>
        this.memory.ingest({
          userId: this.userId,
          sourceId: `hiring-${event.kind}-${Date.parse(event.at)}`,
          recordedAt: event.at,
          transcript,
          attestation: "uploader_only_identifiable_speaker",
          policyVersion: CONSENT_POLICY_VERSION,
          correlationId: randomUUID(),
          receivedAt: new Date().toISOString(),
        }),
      )
      .then(
        () => undefined,
        (error: unknown) =>
          this.onFailure(error instanceof Error ? error.message : "Memory ingestion failed."),
      )
      .finally(() => {
        this.inFlight -= 1;
      });
  }

  async ask(question: string): Promise<string> {
    await this.queue;
    const answer = await this.memory.ask({
      userId: this.userId,
      question,
      correlationId: randomUUID(),
      receivedAt: new Date().toISOString(),
    });
    return answer.answer;
  }

  pending(): number {
    return this.inFlight;
  }
}

/** Keeps events in process. Used by tests and when Letta is not running. */
export class LocalIntentMemory implements IntentMemory {
  readonly events: HiringEvent[] = [];

  record(event: HiringEvent): void {
    this.events.push(event);
  }

  async ask(question: string): Promise<string> {
    return `Letta is not connected, so this answer comes from the local event log only.\n${this.events
      .map((event) => `${event.at.slice(0, 10)} ${event.kind}: ${event.summary}`)
      .join("\n")}\n\nQuestion: ${question}`;
  }

  pending(): number {
    return 0;
  }
}
