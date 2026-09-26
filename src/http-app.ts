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
import type { CompanyKnowledge, EmployeePersona } from "./company-domain.js";
import type { SoCLaaSCompanyAgent } from "./soclaas-company-agent.js";
import { detectProhibitedData } from "./prohibited-data.js";
import type { ConversationStore } from "./conversation-domain.js";
import type { GmailClient } from "./recruiting/gmail.js";
import { registerRecruitingRoutes } from "./recruiting/routes.js";
import type { RoleBoard } from "./recruiting/roles.js";
import type { MeetingActions } from "./meetings/domain.js";
import { replayTranscript, type ReplaySource } from "./meetings/replay.js";
import { registerMeetingRoutes, type GoogleStatus } from "./meetings/routes.js";
import type { RecruitingService } from "./recruiting/service.js";
import {
  EmployeeIdentity,
  type SessionConfig,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  validateAuthConfig,
} from "./auth.js";
import {
  ModelRegistry,
  createDefaultModelRegistry,
  type ModelDescriptor,
} from "./model-registry.js";
import { MemoryUpdateQueue } from "./memory-queue.js";

const DEFAULT_PERSONAS = [
  { employeeId: "jax", displayName: "Jax", role: "Backend Engineer", department: "Engineering_Backend", avatar: "👨‍💻" },
  { employeeId: "priya", displayName: "Priya", role: "Product Designer", department: "Design", avatar: "🎨" },
  { employeeId: "chloe", displayName: "Chloe", role: "Product Manager", department: "Product", avatar: "📋" },
  { employeeId: "marcus", displayName: "Marcus", role: "Staff Systems Engineer", department: "Engineering_Backend", avatar: "🛠️" },
  { employeeId: "deepa", displayName: "Deepa", role: "People Operations Lead", department: "HR_Ops", avatar: "🤝" },
];

export interface BuildAppOptions extends ApplicationOptions {
  memory: MemoryProvider;
  companyAgent?: SoCLaaSCompanyAgent;
  companyAgents?: Record<string, SoCLaaSCompanyAgent>;
  modelRegistry?: ModelRegistry;
  companyKnowledge?: CompanyKnowledge;
  conversationStore?: ConversationStore;
  sessionConfig?: SessionConfig;
  employeeIdentity?: EmployeeIdentity;
  personas?: EmployeePersona[];
  /** When true, requests must present valid session credentials. Defaults to true when sessionConfig is passed or in production. */
  requireAuth?: boolean;
  /** Fastify logger configuration. Tests pass a stream to capture output. */
  logger?: FastifyServerOptions["logger"];
  /** The recruiting direction (S3). Omitted, its routes are not registered. */
  recruiting?: { board: RoleBoard; gmail: GmailClient | null };
  /** Meeting actions (S2). Omitted, its routes are not registered. */
  meetings?: { service: MeetingActions; replays?: ReplaySource; googleStatus?: () => Promise<GoogleStatus> };
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
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const HISTORY_TURNS = 6;
/** Longest chat message either agent route accepts. */
const MAX_MESSAGE = 8000;
const HISTORY_CHARS = 4000;

/**
 * Shortens an old turn for the model's context, keeping both ends: a pasted
 * description's last lines and an answer's closing question both matter.
 */
function clipped(content: string): string {
  if (content.length <= HISTORY_CHARS) return content;
  // Cut by code point, so an emoji at the cut is kept whole or left out, never halved.
  const points = Array.from(content);
  if (points.length <= HISTORY_CHARS) return content;
  const half = HISTORY_CHARS / 2;
  return `${points.slice(0, half).join("")}\n[… ${points.length - HISTORY_CHARS} characters left out …]\n${points.slice(-half).join("")}`;
}

function titleFrom(message: string): string {
  // By code points, so an emoji is never cut in half.
  const points = Array.from(message);
  return points.length > 50 ? `${points.slice(0, 47).join("").trim()}…` : message;
}

/** A string field or query value, trimmed; anything else (a number, a list, a repeated parameter) counts as absent. */
function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

  const sessionConfig =
    options.sessionConfig ??
    (process.env.SESSION_SECRET
      ? validateAuthConfig(process.env)
      : {
          secret: "orgforge-sme-agent-test-session-secret-at-least-32-chars-long",
          cookieName: SESSION_COOKIE_NAME,
          maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
        });

  const identity =
    options.employeeIdentity ??
    new EmployeeIdentity(sessionConfig, options.companyKnowledge);

  const memoryUpdateQueue = new MemoryUpdateQueue();

  const requireAuth = options.requireAuth ?? Boolean(options.sessionConfig);

  const requireEmployee = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<EmployeePersona | null> => {
    try {
      const authHeader = (request.headers.authorization ?? "") as string;
      const cookieHeader = (request.headers.cookie ?? "") as string;
      const hasAuth = authHeader.startsWith("Bearer ") || cookieHeader.includes("sme_session=");

      if (!hasAuth && !requireAuth) {
        const body = request.body as Record<string, unknown> | undefined;
        const requestedId =
          typeof body?.userId === "string"
            ? body.userId.trim()
            : typeof (request.query as Record<string, unknown>)?.userId === "string"
              ? ((request.query as Record<string, unknown>).userId as string).trim()
              : "jax";
        const persona = (await options.companyKnowledge?.employee?.(requestedId)) ?? {
          employeeId: requestedId,
          displayName: requestedId.charAt(0).toUpperCase() + requestedId.slice(1),
          role: "Employee",
          department: "General",
        };
        return persona;
      }

      const persona = await identity.requireEmployee(request);
      const body = request.body as Record<string, unknown> | undefined;
      const explicitUserId =
        typeof body?.userId === "string"
          ? body.userId.trim()
          : typeof (request.query as Record<string, unknown>)?.userId === "string"
            ? ((request.query as Record<string, unknown>).userId as string).trim()
            : undefined;

      if (explicitUserId && explicitUserId.toLowerCase() !== persona.employeeId.toLowerCase()) {
        reply.code(400).send({
          error: "forbidden",
          message: "Session employee does not match requested userId.",
        });
        return null;
      }

      return persona;
    } catch (error) {
      reply.code(401).send({
        error: "unauthorized",
        message: error instanceof Error ? error.message : "Authentication required.",
      });
      return null;
    }
  };

  const extractSessionEmployee = (request: FastifyRequest): { employeeId: string } | null => {
    const id = identity.extractEmployeeId(request);
    return id ? { employeeId: id } : null;
  };

  const registry =
    options.modelRegistry ??
    createDefaultModelRegistry({
      companyAgent: options.companyAgent,
      companyAgents: options.companyAgents,
    });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/v1/models", async () => {
    return registry.list();
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
    // The same gate as the chat: secrets never reach the model.
    const prohibited = detectProhibitedData(question);
    if (prohibited) {
      return reply.code(400).send({
        status: "rejected",
        code: "prohibited_data",
        category: prohibited.category,
        message: `Your question was blocked because it appears to contain ${/^[aeiou]/i.test(prohibited.category) ? "an" : "a"} ${prohibited.category}. Remove credentials or sensitive numbers before continuing.`,
      });
    }
    try {
      return await options.companyAgent.answer({ employeeId, question });
    } catch (error: unknown) {
      const isProvider500 =
        (typeof error === "object" && error !== null && "statusCode" in error && (error as { statusCode: number }).statusCode >= 500) ||
        (typeof error === "object" && error !== null && "error" in error && (error as { error: string }).error === "provider_unavailable") ||
        /gateway 500|internal server error|service unavailable|bad gateway|5\d\d/i.test(error instanceof Error ? error.message : "");
      if (isProvider500) {
        return reply.code(503).send({
          error: "provider_unavailable",
          message: "The selected model is temporarily unavailable—retry.",
        });
      }
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

    // Everything after the stream has started must end the stream, never throw:
    // a second attempt to send headers would take the whole process down.
    try {
      return await runAgentTurn();
    } catch (error) {
      request.log.error(
        { employeeId, reason: error instanceof Error ? error.message : "Unknown failure." },
        "Unified agent turn failed",
      );
      const payload = { message: "The agent could not complete this question. Please try again." };
      if (isStream) {
        if (!reply.raw.writableEnded) {
          sendEvent("error", payload);
          reply.raw.end();
        }
        return;
      }
      return reply.code(502).send(payload);
    }

    async function runAgentTurn() {
    const rawRequestedModel = (
      (request.body as Record<string, unknown> | undefined)?.model as string | undefined
    );
    const resolution = registry.resolve(rawRequestedModel);
    if (resolution.status === "unknown") {
      const payload = {
        error: "unknown_model",
        message: `Unknown model '${resolution.modelId}'.`,
      };
      if (isStream) {
        sendEvent("error", payload);
        reply.raw.end();
        return;
      }
      return reply.code(400).send(payload);
    }
    if (resolution.status === "unavailable") {
      const payload = {
        error: "model_unavailable",
        message: resolution.reason,
      };
      if (isStream) {
        sendEvent("error", payload);
        reply.raw.end();
        return;
      }
      return reply.code(503).send(payload);
    }

    const activeAgent = resolution.agent;
    const resolvedModel = resolution.descriptor;

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

    const abortController = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) {
        abortController.abort();
      }
    });

    try {
      let isFirstTurn = false;
      let conversationId = requestedConversationId;
      // Recent turns let the agent follow up on its own questions ("replace the role?" "yes").
      let history: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (options.conversationStore) {
        if (conversationId) {
          const existing = await options.conversationStore.get(conversationId, userId);
          isFirstTurn = (existing?.messages.length ?? 0) === 0;
          history = (existing?.messages ?? [])
            .slice(-HISTORY_TURNS)
            .map(({ role, content }) => ({ role, content: clipped(content) }));
          if (!existing) {
            const conv = await options.conversationStore.create(userId, titleFrom(message));
            conversationId = conv.conversationId;
            isFirstTurn = true;
          }
        } else {
          const conv = await options.conversationStore.create(userId, titleFrom(message));
          conversationId = conv.conversationId;
          isFirstTurn = true;
        }

        await options.conversationStore.appendMessage({
          conversationId,
          role: "user",
          content: message,
        });
      }

      sendEvent("status", { phrase: "Reviewing working context…" });

      let contextConsidered = "";
      let memoryStatus: "available" | "empty" | "unavailable" = "empty";
      let memoryUnavailableReason: string | undefined;
      let memorySources: Array<{ sourceId: string; label: string }> = [];

      if (typeof options.memory.getContext === "function") {
        try {
          const memCtx = await options.memory.getContext(userId);
          memoryStatus = memCtx.status;
          if (memCtx.status === "available") {
            contextConsidered = memCtx.workingContext;
            memorySources = memCtx.sources;
          } else if (memCtx.status === "unavailable") {
            memoryUnavailableReason = memCtx.reason;
          }
        } catch (err) {
          memoryStatus = "unavailable";
          memoryUnavailableReason = err instanceof Error ? err.message : "Memory service unavailable";
        }
      } else if (typeof options.memory.getWorkingContextFast === "function") {
        try {
          const fast = await options.memory.getWorkingContextFast(userId);
          if (fast && fast.contextConsidered && fast.contextConsidered.trim()) {
            memoryStatus = "available";
            contextConsidered = fast.contextConsidered;
            memorySources = fast.sources;
          } else {
            memoryStatus = "empty";
          }
        } catch (err) {
          memoryStatus = "unavailable";
          memoryUnavailableReason = err instanceof Error ? err.message : "Memory service unavailable";
        }
      } else if (typeof options.memory.processWorkingContext === "function") {
        try {
          const memRes = await options.memory.processWorkingContext({ userId, message });
          if (memRes.contextConsidered && memRes.contextConsidered.trim()) {
            memoryStatus = "available";
            contextConsidered = memRes.contextConsidered;
            memorySources = memRes.sources;
          } else {
            memoryStatus = "empty";
          }
        } catch (err) {
          memoryStatus = "unavailable";
          memoryUnavailableReason = err instanceof Error ? err.message : "Memory service unavailable";
        }
      } else {
        try {
          const memoryResult = await application.ask({ userId, question: message });
          if (memoryResult.statusCode === 200 && memoryResult.body.status === "answered") {
            if (memoryResult.body.sources.length > 0) {
              memoryStatus = "available";
              contextConsidered = memoryResult.body.answer;
              memorySources = memoryResult.body.sources;
            } else {
              memoryStatus = "empty";
            }
          }
        } catch (err) {
          memoryStatus = "unavailable";
          memoryUnavailableReason = err instanceof Error ? err.message : "Memory service unavailable";
        }
      }

      // Start the update and company answer in parallel, serialized per employee
      let memoryUpdated = false;
      if (typeof options.memory.processWorkingContext === "function") {
        memoryUpdateQueue.enqueue(userId, async () => {
          try {
            const res = await options.memory.processWorkingContext!({ userId, message });
            memoryUpdated = res.memoryUpdated;
          } catch (err) {
            request.log.warn({ err }, "Background working context update failed");
          }
        });
      }

      let ttftMs: number | undefined;

      const companyAnswer = await activeAgent.answer(
        {
          employeeId,
          question: message,
          ...(history.length ? { history, conversationHistory: history } : {}),
          ...(contextConsidered ? { personalMemory: contextConsidered } : {}),
        },
        isStream
          ? {
              signal: abortController.signal,
              onStatus: (phrase: string) => sendEvent("status", { phrase }),
              onToken: (delta: string) => sendEvent("token", { delta }),
              onResetTokens: () => sendEvent("reset_tokens", {}),
            }
          : {
              signal: abortController.signal,
            },
      );

      const durationMs = Date.now() - turnStartTime;
      const modelUsed = resolvedModel.id;
      const providerUsed = resolvedModel.provider;
      const outcome = companyAnswer.answer.startsWith("Insufficient Evidence:")
        ? "evidence_insufficient"
        : "success";

      let persistenceStatus: "saved" | "failed" = "saved";
      if (options.conversationStore && conversationId) {
        await options.conversationStore
          .appendMessage({
            conversationId,
            role: "assistant",
            content: companyAnswer.answer,
            metadata: {
              sources: companyAnswer.sources,
              personalMemory: {
                status: memoryStatus,
                answer: contextConsidered,
                sources: memorySources,
                memoryUpdated,
                ...(memoryUnavailableReason ? { reason: memoryUnavailableReason } : {}),
              },
              runId: companyAnswer.runId,
              toolCalls: companyAnswer.toolCalls,
              ...(companyAnswer.blocks ? { blocks: companyAnswer.blocks } : {}),
              durationMs,
              ttftMs,
              model: modelUsed,
              provider: providerUsed,
              outcome,
            },
          })
          .catch((error: unknown) => {
            request.log.error(
              { conversationId, reason: error instanceof Error ? error.message : String(error) },
              "Saving the answer failed",
            );
            persistenceStatus = "failed";
          });
      }

      let generatedTitle: string | undefined;
      if (
        isFirstTurn &&
        conversationId &&
        typeof (activeAgent as unknown as { generateTitle?: (m: string) => Promise<string> }).generateTitle === "function"
      ) {
        try {
          const t = await Promise.race([
            (activeAgent as unknown as { generateTitle: (m: string) => Promise<string> }).generateTitle(message),
            new Promise<null>((r) => setTimeout(() => r(null), 1000)),
          ]);
          if (t && t.trim()) {
            generatedTitle = t.trim();
            if (options.conversationStore) {
              await options.conversationStore.updateTitle(conversationId, userId, generatedTitle).catch(() => {});
            }
          }
        } catch (_) {}
      }

      const responsePayload = {
        ...companyAnswer,
        ...(conversationId ? { conversationId } : {}),
        ...(generatedTitle ? { title: generatedTitle } : {}),
        personalMemory: {
          status: memoryStatus,
          answer: contextConsidered,
          sources: memorySources,
          memoryUpdated,
          ...(memoryUnavailableReason ? { reason: memoryUnavailableReason } : {}),
        },
        durationMs,
        ttftMs,
        model: modelUsed,
        provider: providerUsed,
        outcome,
        persistenceStatus,
      };

      if (isStream) {
        sendEvent("answer", {
          text: companyAnswer.answer,
          sources: companyAnswer.sources,
        });
        if (generatedTitle) {
          sendEvent("title", {
            conversationId,
            title: generatedTitle,
          });
        }
        sendEvent("done", responsePayload);
        reply.raw.end();
        return;
      }

      return reply.send(responsePayload);
    } catch (error: unknown) {
      if (abortController.signal.aborted || reply.raw.destroyed) {
        request.log.info({ employeeId }, "Turn cancelled by client");
        if (isStream && !reply.raw.writableEnded) {
          reply.raw.end();
        }
        return;
      }
      request.log.error(
        { employeeId, reason: error instanceof Error ? error.message : "Unknown failure." },
        "Unified agent turn failed",
      );

      const isProvider500 =
        (typeof error === "object" && error !== null && "statusCode" in error && (error as { statusCode: number }).statusCode >= 500) ||
        (typeof error === "object" && error !== null && "error" in error && (error as { error: string }).error === "provider_unavailable") ||
        /gateway 500|internal server error|service unavailable|bad gateway|5\d\d/i.test(error instanceof Error ? error.message : "");

      const isInvalidOutput =
        (typeof error === "object" && error !== null && "error" in error && (error as { error: string }).error === "invalid_model_output") ||
        /non-object tool arguments|invalid json|unparseable/i.test(error instanceof Error ? error.message : "");

      if (isProvider500) {
        const payload = {
          error: "provider_unavailable",
          message: "The selected model is temporarily unavailable—retry.",
        };
        if (isStream) {
          sendEvent("error", payload);
          reply.raw.end();
          return;
        }
        return reply.code(503).send(payload);
      }

      if (isInvalidOutput) {
        const payload = {
          error: "invalid_model_output",
          message: "The model produced an invalid response.",
        };
        if (isStream) {
          sendEvent("error", payload);
          reply.raw.end();
          return;
        }
        return reply.code(502).send(payload);
      }

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
    }
  };

  app.post("/api/v1/agent/chat", async (request, reply) => {
    const employee = await requireEmployee(request, reply);
    if (!employee) return;
    const userId = employee.employeeId;
    const employeeId = employee.employeeId;

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
    const fields = body as Record<string, unknown>;
    const message = (typeof fields.message === "string" ? fields.message : String(fields.question ?? "")).trim();

    // Long enough for a pasted job description.
    if (!message || message.length > MAX_MESSAGE) {
      return reply.code(400).send({ message: "Provide a valid message (up to 8000 characters)." });
    }

    const conversationId =
      typeof (body as Record<string, unknown>).conversationId === "string"
        ? (body as Record<string, string>).conversationId.trim()
        : undefined;

    return handleAgentTurn(userId, employeeId, message, request, reply, conversationId);
  });

  app.get("/api/v1/auth/personas", async (_request, reply) => {
    try {
      const list = await options.companyKnowledge?.listEmployees?.();
      if (list && list.length > 0) {
        return reply.send(list);
      }
    } catch (error) {
      app.log.warn({ error }, "Failed to list employees from database");
    }
    return reply.send(options.personas ?? DEFAULT_PERSONAS);
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const employeeId = typeof body.employeeId === "string" ? body.employeeId.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!employeeId || !password) {
      return reply.code(400).send({ message: "employeeId and password are required." });
    }

    let persona: EmployeePersona | null = null;
    if (options.companyKnowledge?.verifyEmployeePassword) {
      try {
        persona = await options.companyKnowledge.verifyEmployeePassword(employeeId, password);
      } catch (error) {
        request.log.error({ error, employeeId }, "Database authentication failure");
        return reply.code(503).send({
          error: "database_unavailable",
          message: "Authentication service temporarily unavailable.",
        });
      }
    } else {
      const pool = options.personas ?? DEFAULT_PERSONAS;
      const found = pool.find((p) => p.employeeId === employeeId);
      if (found && password === "password") {
        persona = found;
      }
    }

    if (!persona) {
      return reply.code(401).send({ error: "invalid_credentials", message: "Invalid employee ID or password." });
    }

    const cookieHeader = identity.createSessionCookie(persona.employeeId);
    reply.header("Set-Cookie", cookieHeader);

    return reply.send({
      ok: true,
      employee: persona,
    });
  });

  app.post("/api/v1/auth/logout", async (_request, reply) => {
    const clearHeader = identity.clearSessionCookie();
    reply.header("Set-Cookie", clearHeader);
    return reply.send({ ok: true, message: "Logged out." });
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    try {
      const employee = await identity.requireEmployee(request);
      return reply.send({
        authenticated: true,
        employee,
      });
    } catch {
      return reply.code(401).send({
        authenticated: false,
        error: "unauthorized",
        message: "Not authenticated.",
      });
    }
  });

  app.get("/api/v1/conversations", async (request, reply) => {
    const employee = await requireEmployee(request, reply);
    if (!employee) return;
    const userId = employee.employeeId;

    if (!options.conversationStore) {
      return reply.send([]);
    }
    try {
      const list = await options.conversationStore.list(userId);
      return reply.send(list);
    } catch (err) {
      request.log.warn({ err }, "Could not fetch conversations list");
      return reply.send([]);
    }
  });

  app.post("/api/v1/conversations", async (request, reply) => {
    const employee = await requireEmployee(request, reply);
    if (!employee) return;
    const userId = employee.employeeId;

    if (!options.conversationStore) {
      return reply.code(503).send({ message: "Conversation store is not configured." });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const title = stringOf(body.title) || undefined;
    const created = await options.conversationStore.create(userId, title);
    return reply.code(201).send(created);
  });

  app.get<{ Params: { conversationId: string } }>(
    "/api/v1/conversations/:conversationId",
    async (request, reply) => {
      const employee = await requireEmployee(request, reply);
      if (!employee) return;
      const userId = employee.employeeId;

      if (!options.conversationStore) {
        return reply.code(503).send({ message: "Conversation store is not configured." });
      }
      const detail = await options.conversationStore.get(request.params.conversationId, userId);
      if (!detail) {
        return reply.code(404).send({ message: "Conversation not found." });
      }
      return reply.send(detail);
    },
  );

  app.delete<{ Params: { conversationId: string } }>(
    "/api/v1/conversations/:conversationId",
    async (request, reply) => {
      const employee = await requireEmployee(request, reply);
      if (!employee) return;
      const userId = employee.employeeId;

      if (!options.conversationStore) {
        return reply.code(503).send({ message: "Conversation store is not configured." });
      }
      const deleted = await options.conversationStore.delete(request.params.conversationId, userId);
      if (!deleted) {
        return reply.code(404).send({ message: "Conversation not found." });
      }
      return reply.send({ status: "deleted", conversationId: request.params.conversationId });
    },
  );

  app.delete("/api/v1/conversations", async (request, reply) => {
    const employee = await requireEmployee(request, reply);
    if (!employee) return;
    const userId = employee.employeeId;

    if (!options.conversationStore) {
      return reply.code(503).send({ message: "Conversation store is not configured." });
    }
    const count = typeof options.conversationStore.deleteAll === "function"
      ? await options.conversationStore.deleteAll(userId)
      : 0;
    return reply.send({ status: "cleared", count });
  });

  app.post("/api/v1/agent/questions", async (request, reply) => {
    const employee = await requireEmployee(request, reply);
    if (!employee) return;
    const userId = employee.employeeId;
    const employeeId = employee.employeeId;

    const body = request.body;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      (typeof (body as Record<string, unknown>).question !== "string" &&
        typeof (body as Record<string, unknown>).message !== "string")
    ) {
      return reply.code(400).send({ message: "question is required." });
    }
    const fields = body as Record<string, unknown>;
    const question = (typeof fields.question === "string" ? fields.question : String(fields.message ?? "")).trim();
    if (!userId || !employeeId || !question || question.length > MAX_MESSAGE) {
      return reply.code(400).send({ message: "Provide valid userId, employeeId, and question values." });
    }

    return handleAgentTurn(userId, employeeId, question, request, reply);
  });

  app.get<{ Params: { sourceId: string } }>(
    "/api/v1/company/sources/:sourceId",
    async (request, reply) => {
      const employee = await requireEmployee(request, reply);
      if (!employee) return;

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

  app.get("/api/v1/me/memory", async (request, reply) => {
    const employee = await requireEmployee(request, reply);
    if (!employee) return;

    const userId = employee.employeeId;
    try {
      if (typeof options.memory.getContext === "function") {
        const ctx = await options.memory.getContext(userId);
        if (ctx.status === "available") {
          return reply.send({
            employeeId: userId,
            status: "available",
            workingContext: ctx.workingContext,
            sources: ctx.sources,
          });
        }
        if (ctx.status === "unavailable") {
          return reply.code(503).send({
            employeeId: userId,
            status: "unavailable",
            reason: ctx.reason,
            workingContext: "",
            sources: [],
          });
        }
        return reply.send({
          employeeId: userId,
          status: "empty",
          workingContext: "",
          sources: [],
        });
      }
      if (typeof options.memory.getWorkingContextFast === "function") {
        const fast = await options.memory.getWorkingContextFast(userId);
        return reply.send({
          employeeId: userId,
          status: fast && fast.contextConsidered ? "available" : "empty",
          workingContext: fast?.contextConsidered || "",
          sources: fast?.sources || [],
        });
      }
      const answerResult = await application.ask({
        userId,
        question: "What is my current working context and project assignments?",
      });
      let workingContext = "";
      let sources: unknown[] = [];
      if (answerResult.statusCode === 200 && "answer" in answerResult.body) {
        workingContext = answerResult.body.answer;
        sources = answerResult.body.sources;
      }
      return reply.send({
        employeeId: userId,
        workingContext,
        sources,
      });
    } catch (err) {
      request.log.error({ err }, "Memory inspection failed");
      return reply.code(503).send({
        error: "memory_service_unavailable",
        message: "Memory service unavailable.",
      });
    }
  });

  app.get<{ Params: { userId: string } }>(
    "/api/v1/users/:userId/memory",
    async (request, reply) => {
      const employee = await requireEmployee(request, reply);
      if (!employee) return;
      if (employee.employeeId !== request.params.userId.trim().toLowerCase()) {
        return reply.code(403).send({ error: "forbidden", message: "Cannot inspect another employee's memory." });
      }
      try {
        const result = await application.inspect(request.params.userId);
        return reply.code(result.statusCode).send(result.body);
      } catch (error) {
        request.log.error({ error, userId: request.params.userId }, "Memory inspect failed");
        return reply.code(503).send({
          code: "memory_service_unavailable",
          message: "The personal memory service is temporarily unavailable. Please retry shortly.",
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
  app.get(
    "/vendor/rive.js",
    serve("vendor/rive.js", "text/javascript; charset=utf-8"),
  );
  app.get(
    "/vendor/rive.wasm",
    serve("vendor/rive.wasm", "application/wasm"),
  );
  app.get(
    "/assets/sobo.riv",
    serve("assets/sobo.riv", "application/octet-stream"),
  );
  app.get("/app.js", serve("app.js", "text/javascript; charset=utf-8"));
  app.get("/styles.css", serve("styles.css", "text/css; charset=utf-8"));
  app.get("/sme.js", serve("app.js", "text/javascript; charset=utf-8"));
  app.get("/sme.css", serve("styles.css", "text/css; charset=utf-8"));

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

  if (options.meetings) {
    const { service, replays, googleStatus } = options.meetings;
    registerMeetingRoutes(app, service, {
      ...(googleStatus ? { googleStatus } : {}),
      ...(replays
        ? {
            listReplays: () => replays.list(),
            loadReplay: (sourceId: string) => replays.load(sourceId),
            replay: (meetingId, segments, intervalMs) => {
              void replayTranscript(service, meetingId, segments, { intervalMs }).catch((error) =>
                app.log.error(
                  { meetingId, reason: error instanceof Error ? error.message : String(error) },
                  "Meeting replay failed",
                ),
              );
            },
          }
        : {}),
    });
    app.get("/meetings", serve("meetings.html", "text/html; charset=utf-8"));
    app.get("/meetings/", async (_request, reply) => reply.redirect("/meetings", 301));
    app.get("/meetings/app.js", serve("meetings.js", "text/javascript; charset=utf-8"));
    app.get("/meetings/styles.css", serve("meetings.css", "text/css; charset=utf-8"));
  }

  app.addHook("onClose", async () => {
    await options.memory.close?.();
    await options.companyKnowledge?.close?.();
    await options.conversationStore?.close?.();
  });

  return app;
}
