import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { PersonalContextApplication, type ApplicationOptions } from "./application.js";
import {
  CONSENT_ATTESTATIONS,
  CONSENT_POLICY_VERSION,
  type MemoryProvider,
} from "./domain.js";

export interface BuildAppOptions extends ApplicationOptions {
  memory: MemoryProvider;
  logger?: boolean;
}

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));

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
  const application = new PersonalContextApplication(options.memory, options);

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/v1/policy", async () => ({
    policyVersion: CONSENT_POLICY_VERSION,
    attestations: CONSENT_ATTESTATIONS,
  }));

  app.post("/api/v1/transcripts", async (request, reply) => {
    const result = await application.submit(request.body);
    return reply.code(result.statusCode).send(result.body);
  });

  app.get<{ Params: { userId: string } }>(
    "/api/v1/users/:userId/memory",
    async (request, reply) => {
      try {
        const result = await application.inspect(request.params.userId);
        return reply.code(result.statusCode).send(result.body);
      } catch {
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

  app.get("/", serve("index.html", "text/html; charset=utf-8"));
  app.get("/app.js", serve("app.js", "text/javascript; charset=utf-8"));
  app.get("/styles.css", serve("styles.css", "text/css; charset=utf-8"));

  app.addHook("onClose", async () => {
    await options.memory.close?.();
  });

  return app;
}
