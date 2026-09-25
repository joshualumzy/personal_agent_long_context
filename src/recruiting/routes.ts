import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { RecruitingError, type ClosedReason, type CriterionKind } from "./domain.js";
import { NoGmailError, type GmailClient } from "./gmail.js";
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

export function registerRecruitingRoutes(
  app: FastifyInstance,
  service: RecruitingService,
  gmail: GmailClient | null,
): void {
  const handle =
    <T>(work: (body: unknown, params: Record<string, string>) => Promise<T>) =>
    async (
      request: { body: unknown; params: unknown },
      reply: FastifyReply,
    ) => {
      try {
        const result = await work(request.body, (request.params ?? {}) as Record<string, string>);
        return reply.send({ result: result ?? null, state: await service.snapshot() });
      } catch (error) {
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
      }
    };

  app.get("/api/recruiting/state", async () => service.snapshot());

  app.post("/api/recruiting/say", handle(async (body) => service.say(field(body, "text"))));

  app.post(
    "/api/recruiting/upload",
    { bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 1.4) },
    handle(async (body) => {
      const content = Buffer.from(field(body, "contentBase64"), "base64");
      if (content.length > MAX_UPLOAD_BYTES) {
        throw new RecruitingError("file_too_large", "Keep the file under 5 MB.", 413);
      }
      const text = (await textFromFile(field(body, "filename"), content)).trim();
      if (!text) throw new RecruitingError("empty_file", "No text could be read from that file.");
      return service.start(text.slice(0, 8000));
    }),
  );

  app.post(
    "/api/recruiting/criteria/draft",
    handle(async (body) => {
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

  app.post("/api/recruiting/confirm", handle(async () => service.confirm()));

  app.post(
    "/api/recruiting/candidates/import",
    handle(async (body) => {
      if (!isRecord(body) || !Array.isArray(body.urls)) {
        throw new RecruitingError("invalid_request", "\"urls\" is required.");
      }
      return service.importProfiles(body.urls.filter((url): url is string => typeof url === "string"));
    }),
  );

  app.post(
    "/api/recruiting/candidates/:id/feedback",
    handle(async (body, params) => {
      const decision = field(body, "decision");
      if (decision !== "keep" && decision !== "pass") {
        throw new RecruitingError("invalid_request", "Decision is keep or pass.");
      }
      const reason = isRecord(body) && typeof body.reason === "string" ? body.reason.trim() : "";
      await service.feedback(params.id!, decision, reason || undefined);
    }),
  );

  app.post(
    "/api/recruiting/candidates/:id/outreach",
    handle(async (_body, params) => service.prepareOutreach(params.id!)),
  );

  app.post(
    "/api/recruiting/candidates/:id/draft",
    handle(async (body, params) => {
      const edit = isRecord(body) ? body : {};
      await service.editDraft(params.id!, {
        ...(typeof edit.subject === "string" ? { subject: edit.subject } : {}),
        ...(typeof edit.body === "string" ? { body: edit.body } : {}),
        ...(typeof edit.email === "string" ? { email: edit.email.trim() } : {}),
      });
    }),
  );

  app.post(
    "/api/recruiting/candidates/:id/send",
    handle(async (body, params) =>
      service.send(params.id!, isRecord(body) && body.manual === true),
    ),
  );

  app.post(
    "/api/recruiting/candidates/:id/reply",
    handle(async (body, params) => service.reply(field(body, "text"), params.id!, "pasted")),
  );

  app.post(
    "/api/recruiting/candidates/:id/close",
    handle(async (body, params) => {
      const reason = field(body, "reason") as ClosedReason;
      if (!["hired", "withdrawn", "declined"].includes(reason)) {
        throw new RecruitingError("invalid_request", "Close as hired, withdrawn, or declined.");
      }
      await service.close(params.id!, reason);
    }),
  );

  app.post(
    "/api/recruiting/proposals/:id",
    handle(async (body, params) =>
      service.resolveProposal(params.id!, isRecord(body) && body.accept === true),
    ),
  );

  app.post(
    "/api/recruiting/fast-forward",
    handle(async (body) => service.fastForward(isRecord(body) ? Number(body.days) : Number.NaN, true)),
  );

  /** The LinkedIn reader posts what it saw here; the model decides who it is from. */
  app.post(
    "/api/recruiting/inbox/linkedin",
    handle(async (body) => {
      if (!isRecord(body) || !Array.isArray(body.threads)) {
        throw new RecruitingError("invalid_request", "\"threads\" is required.");
      }
      const texts = body.threads
        .filter(isRecord)
        .map((thread) => (typeof thread.text === "string" ? thread.text.trim().slice(0, 4000) : ""))
        .filter(Boolean);
      const relevant = await service.relevantConversations(texts);
      const results = [];
      for (const text of relevant) results.push(await service.reply(text, null, "linkedin"));
      return { read: texts.length, ignored: texts.length - relevant.length, results };
    }),
  );

  app.post(
    "/api/recruiting/inbox/gmail",
    handle(async () => ({ read: await service.syncGmail() })),
  );

  app.post("/api/recruiting/ask", handle(async (body) => ({ answer: await service.ask(field(body, "question")) })));

  app.post("/api/recruiting/reset", handle(async () => service.reset()));

  app.post("/api/recruiting/dismiss-error", handle(async () => service.clearError()));

  // Google OAuth (Gmail, and calendar free/busy for meeting actions). The
  // state value ties the callback to a consent this server started and
  // remembers which page to return to.
  const oauthStates = new Map<string, string>();
  const RETURN_PAGES = new Set(["/recruiting", "/meetings"]);
  app.get<{ Querystring: { return?: string } }>("/api/recruiting/gmail/connect", async (request, reply) => {
    if (!gmail) {
      return reply.code(409).send({
        code: "gmail_not_configured",
        message: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.",
      });
    }
    const state = randomBytes(16).toString("hex");
    const back = request.query.return;
    oauthStates.set(state, back && RETURN_PAGES.has(back) ? back : "/recruiting");
    return reply.redirect(gmail.consentUrl(state, (await gmail.storedAddress()) ?? undefined));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/recruiting/gmail/callback",
    async (request, reply) => {
      const { code, state, error } = request.query;
      const back = state ? oauthStates.get(state) : undefined;
      if (!gmail || !state || !back) {
        return reply.code(400).send({ code: "invalid_oauth_callback", message: "Start from Connect Gmail." });
      }
      oauthStates.delete(state);
      // The person pressed Cancel on Google's consent screen.
      if (error || !code) return reply.redirect(`${back}?google=denied`);
      try {
        await gmail.exchangeCode(code);
      } catch (failure) {
        if (failure instanceof NoGmailError) return reply.redirect(`${back}?google=no-gmail`);
        throw failure;
      }
      return reply.redirect(`${back}?google=connected`);
    },
  );
}
