import type { CompanyAnswer, CompanyQuestion, Evidence } from "./company-domain.js";

export interface AgentCallbacks {
  signal?: AbortSignal;
  onToken?: (delta: string) => void;
  onStatus?: (phrase: string) => void;
  onResetTokens?: () => void;
}

export interface ModelDescriptor {
  id: string;
  name: string;
  shortName: string;
  configuredModel: string;
  provider: string;
  badge?: string;
  available: boolean;
  unavailableReason?: string;
  aliases?: string[];
  agent?: {
    answer(
      input: CompanyQuestion,
      callbacks?: AgentCallbacks,
    ): Promise<CompanyAnswer>;
  };
}

export type ModelResolution =
  | { status: "resolved"; descriptor: ModelDescriptor; agent: NonNullable<ModelDescriptor["agent"]> }
  | { status: "unknown"; modelId: string }
  | { status: "unavailable"; descriptor: ModelDescriptor; reason: string };

export class UnknownModelError extends Error {
  readonly statusCode = 400;
  readonly error = "unknown_model";
  constructor(modelId: string) {
    super(`Unknown model '${modelId}'.`);
    this.name = "UnknownModelError";
  }
}

export class ModelUnavailableError extends Error {
  readonly statusCode = 503;
  readonly error = "model_unavailable";
  constructor(reason: string) {
    super(reason);
    this.name = "ModelUnavailableError";
  }
}

export class ProviderUnavailableError extends Error {
  readonly statusCode = 503;
  readonly error = "provider_unavailable";
  constructor(message: string = "The selected model is temporarily unavailable—retry.") {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

export class InvalidModelOutputError extends Error {
  readonly statusCode = 502;
  readonly error = "invalid_model_output";
  constructor(message: string = "The model produced an invalid response.") {
    super(message);
    this.name = "InvalidModelOutputError";
  }
}

export class RequestCancelledError extends Error {
  readonly statusCode = 499;
  readonly error = "request_cancelled";
  constructor(message: string = "Request cancelled by client.") {
    super(message);
    this.name = "RequestCancelledError";
  }
}

export class ModelRegistry {
  private readonly descriptors: Map<string, ModelDescriptor> = new Map();
  private readonly aliasMap: Map<string, string> = new Map();
  private defaultId: string;

  constructor(descriptors: ModelDescriptor[], defaultId: string = "soclaas") {
    this.defaultId = defaultId.toLowerCase();
    for (const d of descriptors) {
      const canonicalId = d.id.toLowerCase();
      this.descriptors.set(canonicalId, d);
      this.aliasMap.set(canonicalId, canonicalId);
      if (d.aliases) {
        for (const alias of d.aliases) {
          this.aliasMap.set(alias.toLowerCase(), canonicalId);
        }
      }
    }
  }

  list(): { default: string; models: Array<Omit<ModelDescriptor, "agent" | "aliases">> } {
    const models = Array.from(this.descriptors.values()).map(
      ({ agent: _agent, aliases: _aliases, ...rest }) => rest,
    );
    return {
      default: this.defaultId,
      models,
    };
  }

  resolve(requestedId?: unknown): ModelResolution {
    const isString = typeof requestedId === "string";
    const prototypeKeys = new Set([
      "constructor",
      "toString",
      "valueOf",
      "__proto__",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ]);
    if (!isString || prototypeKeys.has(String(requestedId).trim())) {
      const defaultDesc = this.descriptors.get(this.defaultId);
      if (defaultDesc && defaultDesc.available && defaultDesc.agent) {
        return { status: "resolved", descriptor: defaultDesc, agent: defaultDesc.agent };
      }
    }
    const rawId = (isString ? (requestedId as string) : this.defaultId).trim().toLowerCase();
    const canonicalId = this.aliasMap.get(rawId);

    if (!canonicalId) {
      return { status: "unknown", modelId: isString ? (requestedId as string) : rawId };
    }

    const descriptor = this.descriptors.get(canonicalId);
    if (!descriptor) {
      return { status: "unknown", modelId: isString ? (requestedId as string) : rawId };
    }

    if (!descriptor.available || !descriptor.agent) {
      return {
        status: "unavailable",
        descriptor,
        reason:
          descriptor.unavailableReason ||
          `The ${descriptor.name} model is not configured on this server.`,
      };
    }

    return {
      status: "resolved",
      descriptor,
      agent: descriptor.agent,
    };
  }
}

export function createDefaultModelRegistry(options: {
  companyAgent?: ModelDescriptor["agent"];
  companyAgents?: Record<string, ModelDescriptor["agent"]>;
  env?: Record<string, string | undefined>;
}): ModelRegistry {
  const env = options.env ?? process.env;
  const soclaasAgent = options.companyAgents?.soclaas ?? options.companyAgent;
  const sonnetAgent = options.companyAgents?.sonnet;

  const descriptors: ModelDescriptor[] = [
    {
      id: "soclaas",
      name: "Qwen 2.5 32B (SoCLaaS)",
      shortName: "SoCLaaS Qwen",
      configuredModel: env.SOCLAAS_COMPANY_MODEL ?? "Qwen/Qwen2.5-32B-Instruct",
      provider: "NUS SoC",
      badge: "Default",
      available: Boolean(soclaasAgent),
      unavailableReason: "The SoCLaaS Qwen model is not configured on this server.",
      aliases: ["qwen", "qwen-2.5-32b", "soclaas-qwen"],
      agent: soclaasAgent,
    },
    {
      id: "sonnet",
      name: "Claude 3.5 Sonnet",
      shortName: "Claude Sonnet",
      configuredModel:
        env.LLM_MODEL ?? "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
      provider: "AWS Bedrock",
      badge: "Fast",
      available: Boolean(sonnetAgent),
      unavailableReason:
        "The Claude Sonnet model is not configured on this server. Check LLM_GATEWAY_URL and LLM_GATEWAY_API_KEY in .env.",
      aliases: ["claude", "claude-3-5-sonnet", "claude-sonnet", "bedrock"],
      agent: sonnetAgent,
    },
  ];

  return new ModelRegistry(descriptors, "soclaas");
}
