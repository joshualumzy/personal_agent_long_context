import type {
  AcceptedQuestion,
  AcceptedTranscript,
  MemoryAnswer,
  MemoryInspection,
  MemoryItem,
  MemoryProvider,
} from "../domain.js";

export class DeterministicMemoryProvider implements MemoryProvider {
  readonly ingested: AcceptedTranscript[] = [];
  private readonly memoryByUser = new Map<string, MemoryItem[]>();

  async ingest(transcript: AcceptedTranscript): Promise<{ agentRef: string }> {
    this.ingested.push(structuredClone(transcript));
    const items = this.memoryByUser.get(transcript.userId) ?? [];
    items.push({
      label: `context/${transcript.sourceId}`,
      content: transcript.transcript,
      description: `Useful Personal Context retained from ${transcript.sourceId}, recorded ${transcript.recordedAt}.`,
      updatedAt: transcript.receivedAt,
    });
    this.memoryByUser.set(transcript.userId, items);
    return { agentRef: `deterministic:${transcript.userId}` };
  }

  async ask(question: AcceptedQuestion): Promise<MemoryAnswer> {
    const runRef = `deterministic-run-${question.correlationId}`;
    const items = this.memoryByUser.get(question.userId) ?? [];

    if (items.length === 0) {
      return {
        answer: "No Memory is retained for this user yet.",
        runRef,
        sources: [],
      };
    }

    return {
      answer: `Answering from retained Memory: ${items
        .map((item) => item.content)
        .join(" ")}`,
      runRef,
      sources: this.ingested
        .filter((transcript) => transcript.userId === question.userId)
        .map((transcript) => ({
          sourceId: transcript.sourceId,
          label: `context/${transcript.sourceId}`,
        })),
    };
  }

  async inspect(userId: string): Promise<MemoryInspection> {
    return {
      userId,
      items: structuredClone(this.memoryByUser.get(userId) ?? []),
    };
  }
}
