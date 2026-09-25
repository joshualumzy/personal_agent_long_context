import { readFile } from "node:fs/promises";
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
import type { RecruitingService } from "./recruiting/service.js";

export interface BuildAppOptions extends ApplicationOptions {
  memory: MemoryProvider;
  companyAgent?: SoCLaaSCompanyAgent;
  companyKnowledge?: CompanyKnowledge;
  conversationStore?: ConversationStore;
  /** Fastify logger configuration. Tests pass a stream to capture output. */
  logger?: FastifyServerOptions["logger"];
  /** The recruiting direction (S3). Omitted, its routes are not registered. */
  recruiting?: { service: RecruitingService; gmail: GmailClient | null };
}

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));
const markedBrowserBundle = fileURLToPath(
  new URL("../node_modules/marked/lib/marked.umd.js", import.meta.url),
);
const domPurifyBrowserBundle = fileURLToPath(
  new URL("../node_modules/dompurify/dist/purify.min.js", import.meta.url),
);

const securityHeaders = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

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

    if (!options.companyAgent) {
      const payload = { message: "The company context agent is not configured." };
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
    if (options.conversationStore) {
      if (conversationId) {
        const existing = await options.conversationStore.get(conversationId, userId);
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
      const companyAnswer = await options.companyAgent.answer(
        {
          employeeId,
          question: message,
          ...(contextConsidered ? { personalMemory: contextConsidered } : {}),
        },
        isStream
          ? {
              onStatus: (phrase) => sendEvent("status", { phrase }),
              onToken: (delta) => sendEvent("token", { delta }),
            }
          : undefined,
      );

      const durationMs = Date.now() - turnStartTime;

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
            durationMs,
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

  if (options.recruiting) {
    registerRecruitingRoutes(app, options.recruiting.service, options.recruiting.gmail);
    app.get("/recruiting", serve("recruiting.html", "text/html; charset=utf-8"));
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
