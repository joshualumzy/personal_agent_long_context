import type {
  AcceptedQuestion,
  AcceptedTranscript,
  MemoryAnswer,
  MemoryInspection,
  MemoryItem,
  MemoryProvider,
  PersonalMemoryContext,
  WorkingContextResult,
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

  async processWorkingContext(input: {
    userId: string;
    message: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
  }): Promise<WorkingContextResult> {
    const askRes = await this.ask({
      userId: input.userId,
      question: input.message,
      correlationId: "deterministic-turn",
      receivedAt: new Date().toISOString(),
    });
    const hasMemory = askRes.sources.length > 0;
    return {
      contextConsidered: hasMemory ? askRes.answer : "",
      memoryUpdated: false,
      sources: askRes.sources,
    };
  }

  async getContext(userId: string): Promise<PersonalMemoryContext> {
    const items = this.memoryByUser.get(userId) ?? [];
    if (items.length === 0) {
      return { status: "empty", workingContext: "", sources: [] };
    }
    const sources = this.ingested
      .filter((transcript) => transcript.userId === userId)
      .map((transcript) => ({
        sourceId: transcript.sourceId,
        label: `context/${transcript.sourceId}`,
      }));
    return {
      status: "available",
      workingContext: items.map((item) => item.content).join(" "),
      sources,
    };
  }

  async getWorkingContextFast(userId: string): Promise<WorkingContextResult | null> {
    const ctx = await this.getContext(userId);
    if (ctx.status === "available") {
      return {
        contextConsidered: ctx.workingContext,
        memoryUpdated: false,
        sources: ctx.sources,
      };
    }
    return null;
  }
}
