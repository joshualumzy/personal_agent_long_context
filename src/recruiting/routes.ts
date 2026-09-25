import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { RecruitingError, type ClosedReason, type CriterionKind } from "./domain.js";
import type { GmailClient } from "./gmail.js";
import type { RoleBoard } from "./roles.js";
import type { RecruitingService } from "./service.js";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(body: unknown, key: string): string {
  if (!isRecord(body) || typeof body[key] !== "string") {
    throw new RecruitingError("invalid_request", `"${key}" is required.`);
  }
  return body[key] as string;
}

/** Plain text from a requirement file. PDF and docx are parsed server side. */
export async function textFromFile(filename: string, content: Buffer): Promise<string> {
  // PDF fonts often map CJK characters to look-alike radical code points
  // (U+2F2F for 工). Fold only those back, so full-width punctuation survives.
  return (await rawTextFromFile(filename, content)).replace(/[\u2E80-\u2EFF\u2F00-\u2FDF]/g, (character) =>
    character.normalize("NFKC"),
  );
}

async function rawTextFromFile(filename: string, content: Buffer): Promise<string> {
  const extension = filename.toLowerCase().split(".").at(-1);
  if (extension === "txt" || extension === "md") return content.toString("utf8");
  if (extension === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const document = await getDocumentProxy(new Uint8Array(content));
    const { text } = await extractText(document, { mergePages: true });
    return text;
  }
  if (extension === "docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.default.extractRawText({ buffer: content });
    return value;
  }
  throw new RecruitingError("unsupported_file", "Upload a .txt, .md, .pdf, or .docx file.");
}

async function requirementFrom(body: unknown): Promise<string> {
  if (isRecord(body) && typeof body.contentBase64 === "string") {
    const content = Buffer.from(field(body, "contentBase64"), "base64");
    if (content.length > MAX_UPLOAD_BYTES) {
      throw new RecruitingError("file_too_large", "Keep the file under 5 MB.", 413);
    }
    const text = (await textFromFile(field(body, "filename"), content)).trim();
    if (!text) throw new RecruitingError("empty_file", "No text could be read from that file.");
    return text.slice(0, 8000);
  }
  return field(body, "text");
}

export function registerRecruitingRoutes(
  app: FastifyInstance,
  board: RoleBoard,
  gmail: GmailClient | null,
): void {
  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof RecruitingError) {
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    }
    app.log.error(
      { reason: error instanceof Error ? error.message : String(error) },
      "Recruiting failure",
    );
    return reply.code(502).send({
      code: "upstream_failure",
      message: error instanceof Error ? error.message : "Something upstream failed.",
    });
  };

  /** A route under /api/recruiting/roles/:roleId that answers with that role's state. */
  const handle =
    <T>(work: (body: unknown, params: Record<string, string>, service: RecruitingService) => Promise<T>) =>
    async (
      request: { body: unknown; params: unknown },
      reply: FastifyReply,
    ) => {
      try {
        const params = (request.params ?? {}) as Record<string, string>;
        const service = await board.get(params.roleId ?? "");
        const result = await work(request.body, params, service);
        return reply.send({ result: result ?? null, state: await service.snapshot() });
      } catch (error) {
        return fail(reply, error);
      }
    };

  const role = (path: string) => `/api/recruiting/roles/:roleId${path}`;

  app.get("/api/recruiting/roles", async () => ({ roles: await board.list() }));

  /** A new role from typed or dictated words, or from an uploaded job description. */
  app.post(
    "/api/recruiting/roles",
    { bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 1.4) },
    async (request, reply) => {
      try {
        const requirement = await requirementFrom(request.body);
        const { id, service } = board.create();
        const result = await service.start(requirement);
        return reply.send({ roleId: id, result, state: await service.snapshot() });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.delete<{ Params: { roleId: string } }>("/api/recruiting/roles/:roleId", async (request, reply) => {
    try {
      await board.remove(request.params.roleId);
      return reply.send({ roles: await board.list() });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Params: { roleId: string } }>(role("/state"), async (request, reply) => {
    try {
      return reply.send(await (await board.get(request.params.roleId)).snapshot());
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post(role("/say"), handle(async (body, _params, service) => service.say(field(body, "text"))));

  app.post(
    role("/criteria/draft"),
    handle(async (body, _params, service) => {
      if (!isRecord(body) || !Array.isArray(body.criteria)) {
        throw new RecruitingError("invalid_request", "\"criteria\" is required.");
      }
      await service.reviseDraft(
        body.criteria.filter(isRecord).map((criterion) => ({
          ...(typeof criterion.id === "string" ? { id: criterion.id } : {}),
          text: String(criterion.text ?? ""),
          kind: (criterion.kind === "nice" ? "nice" : "must") as CriterionKind,
        })),
      );
    }),
  );

  app.post(role("/confirm"), handle(async (_body, _params, service) => service.confirm()));

  app.post(role("/more"), handle(async (_body, _params, service) => service.findMore()));

  app.post(
    role("/candidates/import"),
    handle(async (body, _params, service) => {
      if (!isRecord(body) || !Array.isArray(body.urls)) {
        throw new RecruitingError("invalid_request", "\"urls\" is required.");
      }
      return service.importProfiles(body.urls.filter((url): url is string => typeof url === "string"));
    }),
  );

  app.post(
    role("/candidates/:id/feedback"),
    handle(async (body, params, service) => {
      const decision = field(body, "decision");
      if (decision !== "keep" && decision !== "pass") {
        throw new RecruitingError("invalid_request", "Decision is keep or pass.");
      }
      const reason = isRecord(body) && typeof body.reason === "string" ? body.reason.trim() : "";
      await service.feedback(params.id!, decision, reason || undefined);
    }),
  );

  app.post(
    role("/candidates/:id/outreach"),
    handle(async (_body, params, service) => service.prepareOutreach(params.id!)),
  );

  app.post(
    role("/candidates/:id/draft"),
    handle(async (body, params, service) => {
      const edit = isRecord(body) ? body : {};
      await service.editDraft(params.id!, {
        ...(typeof edit.subject === "string" ? { subject: edit.subject } : {}),
        ...(typeof edit.body === "string" ? { body: edit.body } : {}),
        ...(typeof edit.email === "string" ? { email: edit.email.trim() } : {}),
      });
    }),
  );

  app.post(
    role("/candidates/:id/send"),
    handle(async (body, params, service) =>
      service.send(params.id!, isRecord(body) && body.manual === true),
    ),
  );

  app.post(
    role("/candidates/:id/reply"),
    handle(async (body, params, service) => service.reply(field(body, "text"), params.id!, "pasted")),
  );

  app.post(
    role("/candidates/:id/close"),
    handle(async (body, params, service) => {
      const reason = field(body, "reason") as ClosedReason;
      if (!["hired", "withdrawn", "declined"].includes(reason)) {
        throw new RecruitingError("invalid_request", "Close as hired, withdrawn, or declined.");
      }
      await service.close(params.id!, reason);
    }),
  );

  app.post(
    role("/proposals/:id"),
    handle(async (body, params, service) =>
      service.resolveProposal(params.id!, isRecord(body) && body.accept === true),
    ),
  );

  app.post(
    role("/fast-forward"),
    handle(async (body, _params, service) => service.fastForward(isRecord(body) ? Number(body.days) : Number.NaN, true)),
  );

  /**
   * The LinkedIn reader posts what it saw here. Each role keeps only the
   * conversations with people it contacted; the rest never reach the model.
   */
  app.post("/api/recruiting/inbox/linkedin", async (request, reply) => {
    try {
      const body = request.body;
      if (!isRecord(body) || !Array.isArray(body.threads)) {
        throw new RecruitingError("invalid_request", "\"threads\" is required.");
      }
      const texts = body.threads
        .filter(isRecord)
        .map((thread) => (typeof thread.text === "string" ? thread.text.trim().slice(0, 4000) : ""))
        .filter(Boolean);
      const matched = new Set<string>();
      const results = [];
      for (const { service } of await board.all()) {
        for (const text of await service.relevantConversations(texts)) {
          matched.add(text);
          results.push(await service.reply(text, null, "linkedin"));
        }
      }
      return reply.send({ result: { read: texts.length, ignored: texts.length - matched.size, results } });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/api/recruiting/inbox/gmail", async (_request, reply) => {
    try {
      let read = 0;
      for (const { service } of await board.all()) read += await service.syncGmail();
      return reply.send({ result: { read } });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post(role("/ask"), handle(async (body, _params, service) => ({ answer: await service.ask(field(body, "question")) })));

  app.post(role("/dismiss-error"), handle(async (_body, _params, service) => service.clearError()));

  // Gmail OAuth. The state value ties the callback to a consent this server started.
  const oauthStates = new Set<string>();
  app.get("/api/recruiting/gmail/connect", async (_request, reply) => {
    if (!gmail) {
      return reply.code(409).send({
        code: "gmail_not_configured",
        message: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.",
      });
    }
    const state = randomBytes(16).toString("hex");
    oauthStates.add(state);
    return reply.redirect(gmail.consentUrl(state));
  });

  app.get<{ Querystring: { code?: string; state?: string } }>(
    "/api/recruiting/gmail/callback",
    async (request, reply) => {
      const { code, state } = request.query;
      if (!gmail || !code || !state || !oauthStates.delete(state)) {
        return reply.code(400).send({ code: "invalid_oauth_callback", message: "Start from Connect Gmail." });
      }
      await gmail.exchangeCode(code);
      return reply.redirect("/recruiting");
    },
  );
}
