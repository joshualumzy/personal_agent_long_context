import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { PersonalContextApplication, type ApplicationOptions } from "./application.js";
import {
  CONSENT_ATTESTATIONS,
  CONSENT_POLICY_VERSION,
  type MemoryProvider,
} from "./domain.js";
import type { CompanyKnowledge } from "./company-domain.js";
import type { SoCLaaSCompanyAgent } from "./soclaas-company-agent.js";
import { detectProhibitedData } from "./prohibited-data.js";
import type { ConversationStore } from "./conversation-domain.js";
import type { GmailClient } from "./recruiting/gmail.js";
import { registerRecruitingRoutes } from "./recruiting/routes.js";
import type { RoleBoard } from "./recruiting/roles.js";
import type { EmergentMemory } from "./emergent-memory.js";

export interface BuildAppOptions extends ApplicationOptions {
  memory: MemoryProvider;
  companyAgent?: SoCLaaSCompanyAgent;
  companyAgents?: Record<string, SoCLaaSCompanyAgent>;
  companyKnowledge?: CompanyKnowledge;
  conversationStore?: ConversationStore;
  /** Fastify logger configuration. Tests pass a stream to capture output. */
  logger?: FastifyServerOptions["logger"];
  /** The recruiting direction (S3). Omitted, its routes are not registered. */
  recruiting?: { board: RoleBoard; gmail: GmailClient | null };
  /**
   * Keeps the emergent graph following the questions asked. Omitted, questions
   * are answered exactly as before and the graph stays at its last export.
   */
  emergentMemory?: EmergentMemory;
}

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));
const markedBrowserBundle = fileURLToPath(
  new URL("../node_modules/marked/lib/marked.umd.js", import.meta.url),
);
const domPurifyBrowserBundle = fileURLToPath(
  new URL("../node_modules/dompurify/dist/purify.min.js", import.meta.url),
);
/** Written by orgforge_kb/cognee_memory.py graph: one file per question, plus
 *  index.json. Ignored by Git. */
const emergentGraphDirectory = fileURLToPath(
  new URL("../data/emergent-graph/", import.meta.url),
);

const securityHeaders = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const HISTORY_TURNS = 6;

/** A comma-separated query parameter as a list, blanks dropped. */
function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 128 * 1024,
  });
  const application = new PersonalContextApplication(options.memory, {
    ...options,
    onFailure:
      options.onFailure ??
      ((failure) => app.log.error(failure, "Memory provider failure")),
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/v1/models", async () => {
    const hasSonnet = Boolean(options.companyAgents?.sonnet);
    return {
      models: [
        {
          id: "soclaas",
          name: "Qwen 2.5 32B (SoCLaaS)",
          shortName: "SoCLaaS Qwen",
          provider: "NUS SoC",
          badge: "Default",
          available: Boolean(options.companyAgents?.soclaas || options.companyAgent),
        },
        {
          id: "sonnet",
          name: "Claude 3.5 Sonnet",
          shortName: "Claude Sonnet",
          provider: "AWS Bedrock",
          badge: "Fast",
          available: hasSonnet,
        },
      ],
      default: "soclaas",
    };
  });

  app.post("/api/v1/company/questions", async (request, reply) => {
    if (!options.companyAgent) {
      return reply.code(503).send({ message: "The company context agent is not configured." });
    }
    const body = request.body;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).employeeId !== "string" ||
      typeof (body as Record<string, unknown>).question !== "string"
    ) {
      return reply.code(400).send({ message: "employeeId and question are required." });
    }
    const employeeId = (body as Record<string, string>).employeeId.trim();
    const question = (body as Record<string, string>).question.trim();
    if (!employeeId || !question || question.length > 2_000) {
      return reply.code(400).send({ message: "Provide a valid employeeId and question." });
    }
    try {
      return await options.companyAgent.answer({ employeeId, question });
    } catch (error) {
      request.log.error(
        { employeeId, reason: error instanceof Error ? error.message : "Unknown failure." },
        "Company context question failed",
      );
      return reply.code(502).send({
        message: "The company context agent could not complete this question. Please try again.",
      });
    }
  });

  const handleAgentTurn = async (
    userId: string,
    employeeId: string,
    message: string,
    request: FastifyRequest,
    reply: FastifyReply,
    requestedConversationId?: string,
  ) => {
    const turnStartTime = Date.now();
    const isStream =
      Boolean(request.headers?.accept?.includes("text/event-stream")) ||
      Boolean((request.body as Record<string, unknown> | undefined)?.stream);

    if (isStream) {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
    }

    const sendEvent = (event: string, data: unknown) => {
      if (isStream) {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    const requestedModel = (
      (request.body as Record<string, unknown> | undefined)?.model as string | undefined
    )?.toLowerCase();
    const activeAgent =
      (requestedModel && options.companyAgents?.[requestedModel]) ||
      options.companyAgents?.soclaas ||
      options.companyAgent;

    if (!activeAgent) {
      const payload = {
        message:
          requestedModel === "sonnet"
            ? "The Claude Sonnet model is not configured on this server. Check LLM_GATEWAY_URL and LLM_GATEWAY_API_KEY in .env."
            : "The company context agent is not configured.",
      };
      if (isStream) {
        sendEvent("error", payload);
        reply.raw.end();
        return;
      }
      return reply.code(503).send(payload);
    }

    const prohibited = detectProhibitedData(message);
    if (prohibited) {
      const payload = {
        status: "rejected",
        code: "prohibited_data",
        category: prohibited.category,
        message: `Your message was blocked because it appears to contain ${/^[aeiou]/i.test(prohibited.category) ? "an" : "a"} ${prohibited.category}. Remove credentials or sensitive numbers before continuing.`,
      };
      if (isStream) {
        sendEvent("error", payload);
        reply.raw.end();
        return;
      }
      return reply.code(400).send(payload);
    }

    let conversationId = requestedConversationId;
    // Recent turns let the agent follow up on its own questions ("replace the role?" "yes").
    let history: Array<{ role: "user" | "assistant"; content: string }> = [];
    if (options.conversationStore) {
      if (conversationId) {
        const existing = await options.conversationStore.get(conversationId, userId);
        history = (existing?.messages ?? [])
          .slice(-HISTORY_TURNS)
          .map(({ role, content }) => ({ role, content: content.slice(0, 1500) }));
        if (!existing) {
          const conv = await options.conversationStore.create(userId);
          conversationId = conv.conversationId;
        }
      } else {
        const title = message.length > 50 ? `${message.slice(0, 47).trim()}…` : message;
        const conv = await options.conversationStore.create(userId, title);
        conversationId = conv.conversationId;
      }

      await options.conversationStore.appendMessage({
        conversationId,
        role: "user",
        content: message,
      });
    }

    sendEvent("status", { phrase: "Reviewing working context…" });

    let contextConsidered = "";
    let memoryUpdated = false;
    let memorySources: Array<{ sourceId: string; label: string }> = [];

    if (typeof options.memory.processWorkingContext === "function") {
      try {
        const memRes = await options.memory.processWorkingContext({ userId, message });
        contextConsidered = memRes.contextConsidered;
        memoryUpdated = memRes.memoryUpdated;
        memorySources = memRes.sources;
      } catch (err) {
        request.log.warn({ err }, "Working context processing fallback");
        const memoryResult = await application.ask({ userId, question: message });
        if (memoryResult.statusCode === 200 && memoryResult.body.status === "answered") {
          contextConsidered = memoryResult.body.answer;
          memorySources = memoryResult.body.sources;
        }
      }
    } else {
      const memoryResult = await application.ask({ userId, question: message });
      if (memoryResult.statusCode === 200 && memoryResult.body.status === "answered") {
        contextConsidered = memoryResult.body.answer;
        memorySources = memoryResult.body.sources;
      }
    }

    try {
      const companyAnswer = await activeAgent.answer(
        {
          employeeId,
          question: message,
          ...(contextConsidered ? { personalMemory: contextConsidered } : {}),
          ...(history.length ? { history } : {}),
        },
        isStream
          ? {
              onStatus: (phrase) => sendEvent("status", { phrase }),
              onToken: (delta) => sendEvent("token", { delta }),
              onResetTokens: () => sendEvent("reset_tokens", {}),
            }
          : undefined,
      );

      const durationMs = Date.now() - turnStartTime;
      const modelUsed = requestedModel === "sonnet" ? "sonnet" : "soclaas";

      // The answer is already settled, so extraction can happen afterwards. It
      // reads prose with a model and takes minutes; queueing it here is what
      // lets the emergent graph grow around the questions people actually ask.
      options.emergentMemory?.enqueue(message);

      if (options.conversationStore && conversationId) {
        await options.conversationStore.appendMessage({
          conversationId,
          role: "assistant",
          content: companyAnswer.answer,
          metadata: {
            sources: companyAnswer.sources,
            personalMemory: {
              answer: contextConsidered,
              sources: memorySources,
              memoryUpdated,
            },
            runId: companyAnswer.runId,
            toolCalls: companyAnswer.toolCalls,
            ...(companyAnswer.blocks ? { blocks: companyAnswer.blocks } : {}),
            durationMs,
            model: modelUsed,
          },
        });
      }

      const responsePayload = {
        ...companyAnswer,
        ...(conversationId ? { conversationId } : {}),
        personalMemory: {
          answer: contextConsidered,
          sources: memorySources,
          memoryUpdated,
        },
        durationMs,
        model: modelUsed,
      };

      if (isStream) {
        sendEvent("done", responsePayload);
        reply.raw.end();
        return;
      }

      return reply.send(responsePayload);
    } catch (error) {
      request.log.error(
        { employeeId, reason: error instanceof Error ? error.message : "Unknown failure." },
        "Unified agent turn failed",
      );
      if (isStream) {
        sendEvent("error", {
          message: "The agent could not complete this question. Please try again.",
        });
        reply.raw.end();
        return;
      }
      return reply.code(502).send({
        message: "The agent could not complete this question. Please try again.",
      });
    }
  };

  app.post("/api/v1/agent/chat", async (request, reply) => {
    const body = request.body;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      (typeof (body as Record<string, unknown>).message !== "string" &&
        typeof (body as Record<string, unknown>).question !== "string")
    ) {
      return reply.code(400).send({ message: "message is required." });
    }
    const userId =
      typeof (body as Record<string, unknown>).userId === "string"
        ? (body as Record<string, string>).userId.trim()
        : "jax";
    const employeeId =
      typeof (body as Record<string, unknown>).employeeId === "string"
        ? (body as Record<string, string>).employeeId.trim()
        : "jax";
    const message = (
      (body as Record<string, string>).message ??
      (body as Record<string, string>).question
    ).trim();

    if (!message || message.length > 2_000) {
      return reply.code(400).send({ message: "Provide a valid message (up to 2000 characters)." });
    }

    const conversationId =
      typeof (body as Record<string, unknown>).conversationId === "string"
        ? (body as Record<string, string>).conversationId.trim()
        : undefined;

    return handleAgentTurn(userId, employeeId, message, request, reply, conversationId);
  });

  app.get("/api/v1/conversations", async (request, reply) => {
    if (!options.conversationStore) {
      return reply.send([]);
    }
    const query = (request.query ?? {}) as Record<string, string>;
    const userId = query.userId?.trim() || "jax";
    const list = await options.conversationStore.list(userId);
    return reply.send(list);
  });

  app.post("/api/v1/conversations", async (request, reply) => {
    if (!options.conversationStore) {
      return reply.code(503).send({ message: "Conversation store is not configured." });
    }
    const body = (request.body ?? {}) as Record<string, string>;
    const userId = body.userId?.trim() || "jax";
    const title = body.title?.trim();
    const created = await options.conversationStore.create(userId, title);
    return reply.code(201).send(created);
  });

  app.get<{ Params: { conversationId: string }; Querystring: { userId?: string } }>(
    "/api/v1/conversations/:conversationId",
    async (request, reply) => {
      if (!options.conversationStore) {
        return reply.code(503).send({ message: "Conversation store is not configured." });
      }
      const userId = request.query?.userId?.trim() || "jax";
      const detail = await options.conversationStore.get(request.params.conversationId, userId);
      if (!detail) {
        return reply.code(404).send({ message: "Conversation not found." });
      }
      return reply.send(detail);
    },
  );

  app.delete<{ Params: { conversationId: string }; Querystring: { userId?: string } }>(
    "/api/v1/conversations/:conversationId",
    async (request, reply) => {
      if (!options.conversationStore) {
        return reply.code(503).send({ message: "Conversation store is not configured." });
      }
      const userId = request.query?.userId?.trim() || "jax";
      const deleted = await options.conversationStore.delete(request.params.conversationId, userId);
      if (!deleted) {
        return reply.code(404).send({ message: "Conversation not found." });
      }
      return reply.send({ status: "deleted", conversationId: request.params.conversationId });
    },
  );

  app.post("/api/v1/agent/questions", async (request, reply) => {
    const body = request.body;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).userId !== "string" ||
      typeof (body as Record<string, unknown>).employeeId !== "string" ||
      typeof (body as Record<string, unknown>).question !== "string"
    ) {
      return reply.code(400).send({ message: "userId, employeeId, and question are required." });
    }
    const userId = (body as Record<string, string>).userId.trim();
    const employeeId = (body as Record<string, string>).employeeId.trim();
    const question = (body as Record<string, string>).question.trim();
    if (!userId || !employeeId || !question || question.length > 2_000) {
      return reply.code(400).send({ message: "Provide valid userId, employeeId, and question values." });
    }

    return handleAgentTurn(userId, employeeId, question, request, reply);
  });

  app.get<{ Params: { sourceId: string } }>(
    "/api/v1/company/sources/:sourceId",
    async (request, reply) => {
      if (!options.companyKnowledge) {
        return reply.code(503).send({ message: "Company knowledge is not configured." });
      }
      const sources = await options.companyKnowledge.sources([request.params.sourceId]);
      const source = sources[0];
      return source
        ? reply.send(source)
        : reply.code(404).send({ message: "Source not found." });
    },
  );

  app.get<{
    Querystring: {
      seed?: string;
      depth?: string;
      category?: string;
      sourceType?: string;
      department?: string;
      subtype?: string;
      nodeType?: string;
      incidentsOnly?: string;
      includeActors?: string;
      limit?: string;
      edgeTypes?: string;
    };
  }>("/api/v1/graph", async (request, reply) => {
    const knowledge = options.companyKnowledge;
    if (!knowledge?.graphSlice) {
      return reply.code(503).send({ message: "The graph is not configured." });
    }
    const query = request.query;
    const number = (value: string | undefined) => {
      if (value === undefined) return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    // Comma-separated rather than repeated ?edgeTypes=a&edgeTypes=b: Fastify's
    // default query parser gives the latter the same string type as a single
    // value, which would need its own array-vs-string branch for no benefit —
    // a layer tab only ever asks for a small fixed list.
    const edgeTypes = query.edgeTypes
      ? query.edgeTypes.split(",").map((value) => value.trim()).filter(Boolean)
      : undefined;

    const slice = await knowledge.graphSlice({
      ...(query.seed ? { seed: query.seed } : {}),
      ...(number(query.depth) !== undefined ? { depth: number(query.depth)! } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.sourceType ? { sourceType: query.sourceType } : {}),
      ...(query.department ? { department: query.department } : {}),
      ...(query.subtype ? { subtype: query.subtype } : {}),
      ...(query.nodeType ? { nodeType: query.nodeType } : {}),
      incidentsOnly: query.incidentsOnly === "true",
      includeActors: query.includeActors === "true",
      ...(number(query.limit) !== undefined ? { limit: number(query.limit)! } : {}),
      ...(edgeTypes && edgeTypes.length > 0 ? { edgeTypes } : {}),
    });

    if (slice.nodes.length === 0) {
      return reply.code(404).send({ message: "That selection matched no nodes." });
    }
    return reply.send(slice);
  });

  /**
   * Resolve a free-text question to the graph node most likely about it, so
   * the main graph tab can center on something without the caller knowing a
   * source id in advance. Reuses the same hybrid search retrieval already
   * used for answering questions — no separate keyword-only path — so this
   * finds the same top hit a person asking the same thing would get as
   * evidence.
   */
  app.get<{ Querystring: { q?: string } }>("/api/v1/graph/seed", async (request, reply) => {
    const knowledge = options.companyKnowledge;
    if (!knowledge) {
      return reply.code(503).send({ message: "Company knowledge is not configured." });
    }
    const query = request.query.q?.trim();
    if (!query) {
      return reply.code(400).send({ message: "Provide a q parameter." });
    }
    const [top] = await knowledge.search(query, 1);
    if (!top) {
      return reply.code(404).send({ message: "Nothing matched that question." });
    }
    return reply.send({ sourceId: top.sourceId, label: top.title });
  });

  /** One of the fixed company-overview subgraphs, by name. */
  app.get<{ Params: { name: string } }>("/api/v1/graph/view/:name", async (request, reply) => {
    const knowledge = options.companyKnowledge;
    if (!knowledge?.graphView) {
      return reply.code(503).send({ message: "The graph is not configured." });
    }
    const slice = await knowledge.graphView(request.params.name);
    if (!slice) return reply.code(404).send({ message: "There is no view by that name." });
    return reply.send(slice);
  });

  /**
   * A question's graph: the question as a centre node, linked to the graph
   * nodes its evidence belongs to and the ones it names outright. Only the
   * centre and its seeds — the rest is reached by expanding.
   */
  app.get<{ Querystring: { q?: string; categories?: string; seeds?: string } }>(
    "/api/v1/graph/query",
    async (request, reply) => {
      const knowledge = options.companyKnowledge;
      if (!knowledge?.graphQuery) {
        return reply.code(503).send({ message: "The graph is not configured." });
      }
      const query = request.query.q?.trim();
      if (!query) return reply.code(400).send({ message: "Provide a q parameter." });
      const seeds = Number(request.query.seeds);
      const slice = await knowledge.graphQuery({
        query,
        ...(request.query.categories ? { categories: splitList(request.query.categories) } : {}),
        ...(Number.isFinite(seeds) && seeds > 0 ? { seeds } : {}),
      });
      return reply.send(slice);
    },
  );

  /**
   * One node's neighbourhood, along every relationship in both directions,
   * ranked and budgeted per category; the remainder of a category comes back
   * as a cluster node, and expanding that returns its next page.
   */
  app.get<{
    Querystring: {
      id?: string;
      categories?: string;
      budget?: string;
      offset?: string;
      includePlans?: string;
    };
  }>("/api/v1/graph/expand", async (request, reply) => {
    const knowledge = options.companyKnowledge;
    if (!knowledge?.graphExpand) {
      return reply.code(503).send({ message: "The graph is not configured." });
    }
    const id = request.query.id?.trim();
    if (!id) return reply.code(400).send({ message: "Provide an id parameter." });
    const budget = Number(request.query.budget);
    const offset = Number(request.query.offset);
    const slice = await knowledge.graphExpand({
      id,
      ...(request.query.categories ? { categories: splitList(request.query.categories) } : {}),
      ...(Number.isFinite(budget) && budget > 0 ? { budget } : {}),
      ...(Number.isFinite(offset) && offset > 0 ? { offset } : {}),
      includePlans: request.query.includePlans === "true",
    });
    if (slice.nodes.length === 0) {
      return reply.code(404).send({ message: "No node has that id." });
    }
    return reply.send(slice);
  });

  /**
   * Evidence for one graph node, found the same way: hybrid search over the
   * node's own label. This is not exact provenance for a specific edge — the
   * graph does not keep that — it is the same retrieval a question would get,
   * scoped to what this node is called. Good enough for "why is this here"
   * without pretending to be a citation.
   */
  app.get<{ Querystring: { label?: string; limit?: string } }>(
    "/api/v1/graph/evidence",
    async (request, reply) => {
      const knowledge = options.companyKnowledge;
      if (!knowledge) {
        return reply.code(503).send({ message: "Company knowledge is not configured." });
      }
      const label = request.query.label?.trim();
      if (!label) {
        return reply.code(400).send({ message: "Provide a label parameter." });
      }
      const parsedLimit = Number(request.query.limit);
      const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 12) : 5;
      const evidence = await knowledge.search(label, limit);
      return reply.send({ evidence });
    },
  );

  /**
   * The emergent graph, as last exported by orgforge_kb/cognee_memory.py.
   *
   * It is served from a file rather than queried live: cognee keeps it in its own
   * embedded stores, which this process cannot read, and extraction takes minutes
   * anyway — far too long for a request. So the Python side writes an export and
   * this hands it over, which also makes plain that the view is a snapshot of
   * whatever was last extracted rather than something computed on demand.
   */
  app.get("/api/v1/graph/emergent", async (_request, reply) => {
    try {
      const content = await readFile(join(emergentGraphDirectory, "index.json"), "utf8");
      return reply.type("application/json; charset=utf-8").send(content);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
      return reply.code(404).send({
        message:
          "No question has been extracted yet. Ask something in the chat and it " +
          "will be extracted in the background, or run it by hand: " +
          "python orgforge_kb/query_slice.py \"<question>\" -o slice.json, then " +
          "python orgforge_kb/cognee_memory.py remember slice.json, then " +
          "python orgforge_kb/cognee_memory.py graph.",
      });
    }
  });

  /** The graph extracted for one question. */
  app.get<{ Params: { slug: string } }>(
    "/api/v1/graph/emergent/graphs/:slug",
    async (request, reply) => {
      // The slug reaches the filesystem, so it may only be what the exporter
      // produces: lower-case words, digits and underscores.
      if (!/^[a-z0-9_]{1,120}$/.test(request.params.slug)) {
        return reply.code(400).send({ message: "That is not a graph name." });
      }
      try {
        const content = await readFile(
          join(emergentGraphDirectory, `${request.params.slug}.json`),
          "utf8",
        );
        return reply.type("application/json; charset=utf-8").send(content);
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
        return reply.code(404).send({ message: "No graph for that question." });
      }
    },
  );

  /**
   * Whether an extraction is in flight, so the view can say the graph is about
   * to change and reload it once it has.
   */
  app.get("/api/v1/graph/emergent/status", async (_request, reply) => {
    if (!options.emergentMemory) {
      return reply.send({
        enabled: false,
        running: null,
        queued: 0,
        extracted: 0,
        lastFinishedAt: null,
        lastError: null,
      });
    }
    return reply.send({ enabled: true, ...options.emergentMemory.status() });
  });

  app.get("/api/v1/policy", async () => ({
    policyVersion: CONSENT_POLICY_VERSION,
    attestations: CONSENT_ATTESTATIONS,
  }));

  app.post("/api/v1/transcripts", async (request, reply) => {
    const result = await application.submit(request.body);
    return reply.code(result.statusCode).send(result.body);
  });

  app.post("/api/v1/questions", async (request, reply) => {
    const result = await application.ask(request.body);
    return reply.code(result.statusCode).send(result.body);
  });

  app.get<{ Params: { userId: string } }>(
    "/api/v1/users/:userId/memory",
    async (request, reply) => {
      try {
        const result = await application.inspect(request.params.userId);
        return reply.code(result.statusCode).send(result.body);
      } catch (error) {
        app.log.error(
          {
            operation: "inspect",
            userId: request.params.userId,
            reason: error instanceof Error ? error.message : "Unknown failure.",
          },
          "Memory provider failure",
        );
        return reply.code(503).send({
          code: "memory_service_unavailable",
          message: "The Memory service is unavailable.",
        });
      }
    },
  );

  const serve =
    (filename: string, contentType: string) =>
    async (_request: unknown, reply: FastifyReply) => {
      const content = await readFile(`${publicDirectory}${filename}`);
      return reply.headers(securityHeaders).type(contentType).send(content);
    };
  const serveFile =
    (path: string, contentType: string) =>
    async (_request: unknown, reply: FastifyReply) => {
      const content = await readFile(path);
      return reply.headers(securityHeaders).type(contentType).send(content);
    };

  app.get("/", serve("index.html", "text/html; charset=utf-8"));
  app.get("/sme", async (_request, reply) => reply.redirect("/", 302));
  app.get(
    "/vendor/marked.js",
    serveFile(markedBrowserBundle, "text/javascript; charset=utf-8"),
  );
  app.get(
    "/vendor/dompurify.js",
    serveFile(domPurifyBrowserBundle, "text/javascript; charset=utf-8"),
  );
  app.get("/app.js", serve("app.js", "text/javascript; charset=utf-8"));
  app.get("/styles.css", serve("styles.css", "text/css; charset=utf-8"));
  app.get("/sme.js", serve("app.js", "text/javascript; charset=utf-8"));
  app.get("/sme.css", serve("styles.css", "text/css; charset=utf-8"));

  app.get("/graph", serve("graph.html", "text/html; charset=utf-8"));
  app.get("/graph/app.js", serve("graph.js", "text/javascript; charset=utf-8"));
  app.get("/graph/styles.css", serve("graph.css", "text/css; charset=utf-8"));

  if (options.recruiting) {
    registerRecruitingRoutes(app, options.recruiting.board, options.recruiting.gmail);
    // The chat page embeds this page as a live panel, so only same-origin framing is allowed.
    app.get("/recruiting", async (_request, reply) => {
      const content = await readFile(`${publicDirectory}recruiting.html`);
      return reply
        .headers({
          ...securityHeaders,
          "content-security-policy": securityHeaders["content-security-policy"].replace(
            "frame-ancestors 'none'",
            "frame-ancestors 'self'",
          ),
          "x-frame-options": "SAMEORIGIN",
        })
        .type("text/html; charset=utf-8")
        .send(content);
    });
    app.get("/recruiting/", async (_request, reply) => reply.redirect("/recruiting", 301));
    app.get("/recruiting/app.js", serve("recruiting.js", "text/javascript; charset=utf-8"));
    app.get("/recruiting/styles.css", serve("recruiting.css", "text/css; charset=utf-8"));
  }

  app.addHook("onClose", async () => {
    await options.memory.close?.();
    await options.companyKnowledge?.close?.();
    await options.conversationStore?.close?.();
  });

  return app;
}
