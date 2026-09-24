import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

export const EMBEDDING_DIMENSIONS = 1024;
export const BEDROCK_TITAN_V2_MODEL = "amazon.titan-embed-text-v2:0";
export const BEDROCK_TITAN_V2_USD_PER_MILLION_INPUT_TOKENS = 0.02;
export const ENGLISH_CHARACTERS_PER_TOKEN = 4.7;

export type EmbeddingPurpose = "document" | "query";

export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[], purpose: EmbeddingPurpose): Promise<number[][]>;
}

export interface BedrockEmbeddingOptions {
  region: string;
  model?: string;
}

function asEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS) {
    throw new Error("Embedding provider returned a vector with an unexpected dimension.");
  }
  if (!value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new Error("Embedding provider returned a non-numeric vector.");
  }
  return value;
}

/** Server-only adapter for Amazon Bedrock Titan Text Embeddings V2. */
export class BedrockEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private readonly client: BedrockRuntimeClient;

  constructor(options: BedrockEmbeddingOptions) {
    if (!options.region.trim()) throw new Error("AWS_REGION is required for Bedrock embeddings.");
    this.model = options.model ?? BEDROCK_TITAN_V2_MODEL;
    this.client = new BedrockRuntimeClient({ region: options.region });
  }

  async embed(texts: string[], _purpose: EmbeddingPurpose): Promise<number[][]> {
    return Promise.all(
      texts.map(async (text) => {
        const response = await this.client.send(
          new InvokeModelCommand({
            modelId: this.model,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
              inputText: text,
              dimensions: EMBEDDING_DIMENSIONS,
              normalize: true,
              embeddingTypes: ["float"],
            }),
          }),
        );
        if (!response.body) throw new Error("Bedrock returned an empty embedding response.");
        const payload: unknown = JSON.parse(new TextDecoder().decode(response.body));
        if (!payload || typeof payload !== "object" || !("embedding" in payload)) {
          throw new Error("Bedrock returned an invalid embedding response.");
        }
        return asEmbedding(payload.embedding);
      }),
    );
  }
}

export function embeddingProviderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider {
  if ((environment.EMBEDDINGS_PROVIDER ?? "bedrock") !== "bedrock") {
    throw new Error("EMBEDDINGS_PROVIDER must be 'bedrock'.");
  }
  return new BedrockEmbeddingProvider({
    region: environment.AWS_REGION ?? "",
    model: environment.EMBEDDINGS_MODEL,
  });
}

export function estimateBedrockEmbeddingCostUsd(characters: number): number {
  if (!Number.isFinite(characters) || characters < 0) {
    throw new Error("Character count must be a non-negative finite number.");
  }
  return (characters / ENGLISH_CHARACTERS_PER_TOKEN / 1_000_000) * BEDROCK_TITAN_V2_USD_PER_MILLION_INPUT_TOKENS;
}

export function pgVector(vector: readonly number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Expected a ${EMBEDDING_DIMENSIONS}-dimension embedding.`);
  }
  return `[${vector.join(",")}]`;
}
