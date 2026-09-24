import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
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

export interface BuildAppOptions extends ApplicationOptions {
  memory: MemoryProvider;
  companyAgent?: SoCLaaSCompanyAgent;
  companyKnowledge?: CompanyKnowledge;
  /** Fastify logger configuration. Tests pass a stream to capture output. */
  logger?: FastifyServerOptions["logger"];
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

  app.post("/api/v1/agent/questions", async (request, reply) => {
    if (!options.companyAgent) {
      return reply.code(503).send({ message: "The company context agent is not configured." });
    }
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

    const memoryResult = await application.ask({ userId, question });
    if (memoryResult.statusCode !== 200 || memoryResult.body.status !== "answered") {
      return reply.code(memoryResult.statusCode).send(memoryResult.body);
    }
    const personalMemory = memoryResult.body;
    try {
      const companyAnswer = await options.companyAgent.answer({
        employeeId,
        question,
        ...(personalMemory.sources.length > 0 ? { personalMemory: personalMemory.answer } : {}),
      });
      return {
        ...companyAnswer,
        personalMemory: {
          answer: personalMemory.answer,
          sources: personalMemory.sources,
        },
      };
    } catch (error) {
      request.log.error(
        { employeeId, reason: error instanceof Error ? error.message : "Unknown failure." },
        "Unified agent question failed",
      );
      return reply.code(502).send({
        message: "The agent could not complete this question. Please try again.",
      });
    }
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
  app.get("/sme", serve("sme.html", "text/html; charset=utf-8"));
  app.get(
    "/vendor/marked.js",
    serveFile(markedBrowserBundle, "text/javascript; charset=utf-8"),
  );
  app.get(
    "/vendor/dompurify.js",
    serveFile(domPurifyBrowserBundle, "text/javascript; charset=utf-8"),
  );
  app.get("/sme.js", serve("sme.js", "text/javascript; charset=utf-8"));
  app.get("/sme.css", serve("sme.css", "text/css; charset=utf-8"));
  app.get("/app.js", serve("app.js", "text/javascript; charset=utf-8"));
  app.get("/styles.css", serve("styles.css", "text/css; charset=utf-8"));

  app.addHook("onClose", async () => {
    await options.memory.close?.();
    await options.companyKnowledge?.close?.();
  });

  return app;
}
