import type {
  AcceptedTranscript,
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

  async inspect(userId: string): Promise<MemoryInspection> {
    return {
      userId,
      items: structuredClone(this.memoryByUser.get(userId) ?? []),
    };
  }
}
