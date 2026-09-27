import type { FastifyInstance, FastifyReply } from "fastify";
import type { ActionPayload, MeetingActions, MeetingEvent, MeetingParticipant } from "./domain.js";
import { MeetingError } from "./domain.js";
import type { Transcribe } from "./speech.js";
import { WebSocketServer, type WebSocket } from "ws";
import { openDoubaoStream, type LiveAsrConfig } from "./doubao.js";

export interface GoogleStatus {
  connected: boolean;
  /** The connected account has a Gmail mailbox (replies, contact lookups). */
  mailbox: boolean;
  /** Calendar free/busy granted, so invites can be checked. */
  calendar: boolean;
}

export interface RegisterMeetingRoutesOptions {
  /** Google connection, for the page to offer connecting it. Absent means Google is not configured. */
  googleStatus?: () => Promise<GoogleStatus>;
  /** Loads an OrgForge meeting to replay. Absent means replay is not configured. */
  loadReplay?: (
    sourceId: string,
  ) => Promise<{
    title: string;
    segments: Array<{ speaker: string; text: string; at?: string }>;
    /** The invite list, when the source has one. */
    participants?: MeetingParticipant[];
  } | null>;
  /** Feeds segments into the meeting over time, in the background. Not awaited by the route. */
  replay?: (
    meetingId: string,
    segments: Array<{ speaker: string; text: string; at?: string }>,
    intervalMs: number,
  ) => void;
  /** Lists the OrgForge meetings available to replay. */
  listReplays?: () => Promise<Array<{ sourceId: string; title: string }>>;
  /** Speech to text for recorded meeting audio. Omitted, the audio route answers 503. */
  transcribe?: Transcribe;
  /** Streaming recognition for live audio. Omitted, the page falls back to clips on /audio. */
  liveAsr?: LiveAsrConfig;
}

/** A pause this long ends a sentence, which then goes to the agent at once. */
const LIVE_SENTENCE_PAUSE_MS = 300;

const DEFAULT_REPLAY_EMPLOYEE_ID = "jax";
const DEFAULT_REPLAY_INTERVAL_MS = 1_500;
const MIN_REPLAY_INTERVAL_MS = 50;
const MAX_REPLAY_INTERVAL_MS = 60_000;
const MAX_SEGMENTS_PER_CALL = 50;
const MAX_SEGMENT_TEXT_LENGTH = 2_000;
const HEARTBEAT_MS = 15_000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(body: unknown, key: string, maxLength: number): string {
  if (!isRecord(body) || typeof body[key] !== "string") {
    throw new MeetingError("invalid_request", `"${key}" is required.`, 400);
  }
  const value = (body[key] as string).trim();
  if (!value || value.length > maxLength) {
    throw new MeetingError(
      "invalid_request",
      `Provide a valid "${key}" (up to ${maxLength} characters).`,
      400,
    );
  }
  return value;
}

function optionalReason(body: unknown): string | undefined {
  if (isRecord(body) && typeof body.reason === "string") {
    const reason = body.reason.trim().slice(0, 1_000);
    return reason || undefined;
  }
  return undefined;
}

function requiredPayload(body: unknown): ActionPayload {
  if (!isRecord(body) || !isRecord(body.payload)) {
    throw new MeetingError("invalid_request", '"payload" is required.', 400);
  }
  return body.payload as unknown as ActionPayload;
}

interface SegmentInput {
  speaker: string;
  text: string;
  at?: string;
}

function parseSegments(body: unknown): SegmentInput[] {
  if (!isRecord(body) || !Array.isArray(body.segments)) {
    throw new MeetingError("invalid_request", '"segments" is required.', 400);
  }
  const segments = body.segments;
  if (segments.length === 0) {
    throw new MeetingError("invalid_request", "Provide at least one segment.", 400);
  }
  if (segments.length > MAX_SEGMENTS_PER_CALL) {
    throw new MeetingError(
      "invalid_request",
      `Send at most ${MAX_SEGMENTS_PER_CALL} segments per call.`,
      400,
    );
  }
  return segments.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.speaker !== "string" || typeof entry.text !== "string") {
      throw new MeetingError("invalid_request", `Segment ${index} needs a "speaker" and "text".`, 400);
    }
    const speaker = entry.speaker.trim();
    const text = entry.text.trim();
    if (!speaker || !text || text.length > MAX_SEGMENT_TEXT_LENGTH) {
      throw new MeetingError(
        "invalid_request",
        `Segment ${index} has an invalid speaker or text (text up to ${MAX_SEGMENT_TEXT_LENGTH} characters).`,
        400,
      );
    }
    const at = typeof entry.at === "string" && entry.at.trim() ? entry.at.trim() : undefined;
    return { speaker, text, ...(at ? { at } : {}) };
  });
}

/** Wraps a handler: maps MeetingError to {code,message} at its statusCode, else logs and answers 502. */
function route<T>(
  app: FastifyInstance,
  work: (
    body: unknown,
    params: Record<string, string>,
    query: Record<string, string>,
  ) => Promise<{ status: number; body: T }>,
) {
  return async (request: { body: unknown; params: unknown; query?: unknown }, reply: FastifyReply) => {
    try {
      const { status, body } = await work(
        request.body,
        (request.params ?? {}) as Record<string, string>,
        (request.query ?? {}) as Record<string, string>,
      );
      return reply.code(status).send(body);
    } catch (error) {
      if (error instanceof MeetingError) {
        return reply.code(error.statusCode).send({ code: error.code, message: error.message });
      }
      app.log.error(
        { reason: error instanceof Error ? error.message : String(error) },
        "Meeting route failure",
      );
      return reply.code(502).send({
        code: "upstream_failure",
        message: "The meetings agent could not complete this request.",
      });
    }
  };
}

export function registerMeetingRoutes(
  app: FastifyInstance,
  meetings: MeetingActions,
  options: RegisterMeetingRoutesOptions = {},
): void {
  app.get(
    "/api/v1/meetings",
    route(app, async () => ({ status: 200, body: await meetings.list() })),
  );

  if (options.liveAsr) registerLiveAudio(app, meetings, options.liveAsr);

  app.get(
    "/api/v1/meetings/integrations",
    route(app, async () => ({
      status: 200,
      body: {
        liveAsr: Boolean(options.liveAsr),
        google: options.googleStatus
          ? { ...(await options.googleStatus()), connectUrl: "/api/recruiting/gmail/connect?return=/meetings" }
          : null,
      },
    })),
  );

  app.post(
    "/api/v1/meetings",
    route(app, async (body) => {
      const title = requiredString(body, "title", 200);
      const employeeId = requiredString(body, "employeeId", 200);
      const meeting = await meetings.start({ title, employeeId });
      return { status: 201, body: meeting };
    }),
  );

  app.post(
    "/api/v1/meetings/replay",
    route(app, async (body) => {
      const sourceId = requiredString(body, "sourceId", 200);

      let intervalMs = DEFAULT_REPLAY_INTERVAL_MS;
      if (isRecord(body) && body.intervalMs !== undefined) {
        const value = Number(body.intervalMs);
        if (!Number.isFinite(value) || value < MIN_REPLAY_INTERVAL_MS || value > MAX_REPLAY_INTERVAL_MS) {
          throw new MeetingError(
            "invalid_request",
            `"intervalMs" must be a number between ${MIN_REPLAY_INTERVAL_MS} and ${MAX_REPLAY_INTERVAL_MS}.`,
            400,
          );
        }
        intervalMs = value;
      }

      if (!options.loadReplay) {
        throw new MeetingError("replay_not_configured", "Replay is not configured on this server.", 503);
      }
      const loaded = await options.loadReplay(sourceId);
      if (!loaded) {
        throw new MeetingError(
          "replay_source_not_found",
          "No OrgForge meeting with that source id was found.",
          404,
        );
      }

      const employeeId =
        isRecord(body) && typeof body.employeeId === "string" && body.employeeId.trim()
          ? body.employeeId.trim().slice(0, 200)
          : DEFAULT_REPLAY_EMPLOYEE_ID;

      const meeting = await meetings.start({
        title: loaded.title,
        employeeId,
        sourceId,
        ...(loaded.participants?.length ? { participants: loaded.participants } : {}),
      });
      options.replay?.(meeting.meetingId, loaded.segments, intervalMs);
      return { status: 201, body: meeting };
    }),
  );

  app.get(
    "/api/v1/meetings/replays",
    route(app, async () => ({
      status: 200,
      body: options.listReplays ? await options.listReplays() : [],
    })),
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/meetings/:id",
    route(app, async (_body, params) => {
      const meeting = await meetings.get(params.id!);
      if (!meeting) {
        throw new MeetingError("meeting_not_found", "No meeting with that id was found.", 404);
      }
      return { status: 200, body: meeting };
    }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/meetings/:id/segments",
    route(app, async (body, params) => {
      const segments = parseSegments(body);
      const appended = await meetings.append(params.id!, segments);
      return { status: 200, body: appended };
    }),
  );

  // Recorded audio arrives as raw bytes, a few seconds per request.
  app.addContentTypeParser(/^audio\//, { parseAs: "buffer", bodyLimit: MAX_AUDIO_BYTES }, (_request, body, done) =>
    done(null, body),
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/meetings/:id/audio",
    { bodyLimit: MAX_AUDIO_BYTES },
    route(app, async (body, params, query) => {
      if (!options.transcribe) {
        throw new MeetingError("transcription_not_configured", "Transcription is not configured on this server.", 503);
      }
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new MeetingError("invalid_request", "Send the recorded audio as the request body.", 400);
      }
      const speaker = (query.speaker ?? "").trim().slice(0, 80) || "Meeting";
      const language = /^[a-z]{2}$/.test(query.language ?? "") ? query.language : undefined;
      // A preview is the clip so far, shown while the speaker is still talking; only the final clip is kept.
      const preview = query.preview === "1";
      const text = (await options.transcribe(body, { ...(language ? { language } : {}), preview })).slice(
        0,
        MAX_SEGMENT_TEXT_LENGTH,
      );
      if (!text || preview) return { status: 200, body: { text } };
      await meetings.append(params.id!, [{ speaker, text }]);
      return { status: 200, body: { text } };
    }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/meetings/:id/end",
    route(app, async (_body, params) => {
      const meeting = await meetings.end(params.id!);
      return { status: 200, body: meeting };
    }),
  );

  app.post<{ Params: { id: string; actionId: string } }>(
    "/api/v1/meetings/:id/actions/:actionId/approve",
    route(app, async (body, params) => {
      const payloadHash = requiredString(body, "payloadHash", 128);
      const action = await meetings.approve(params.id!, params.actionId!, payloadHash);
      return { status: 200, body: action };
    }),
  );

  app.post<{ Params: { id: string; actionId: string } }>(
    "/api/v1/meetings/:id/actions/:actionId/reject",
    route(app, async (body, params) => {
      const reason = optionalReason(body);
      const action = await meetings.reject(params.id!, params.actionId!, reason);
      return { status: 200, body: action };
    }),
  );

  app.post<{ Params: { id: string; actionId: string } }>(
    "/api/v1/meetings/:id/actions/:actionId/edit",
    route(app, async (body, params) => {
      const payload = requiredPayload(body);
      const action = await meetings.edit(params.id!, params.actionId!, payload);
      return { status: 200, body: action };
    }),
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/meetings/:id/events",
    async (request, reply) => {
      const meetingId = request.params.id;
      const meeting = await meetings.get(meetingId);
      if (!meeting) {
        return reply.code(404).send({ code: "meeting_not_found", message: "No meeting with that id was found." });
      }

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const send = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Full current state first, so a browser that connects mid-meeting can render at once.
      send("snapshot", meeting);

      const unsubscribe = meetings.subscribe(meetingId, (event: MeetingEvent) => {
        send(event.type, event);
      });

      const heartbeat = setInterval(() => {
        reply.raw.write(": heartbeat\n\n");
      }, HEARTBEAT_MS);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.raw.on("close", cleanup);
      reply.raw.on("close", cleanup);
    },
  );
}

/**
 * WebSocket /api/v1/meetings/:id/stream. The page sends 16 kHz mono 16-bit PCM
 * as binary messages and the text "end" when it stops; it gets back
 * {"type":"partial","text"} for the sentence being spoken and {"type":"error"}.
 * Each final sentence is appended to the meeting like any other line, so the
 * transcript and the agent see it through the usual events. The recognition
 * key stays on the server.
 */
function registerLiveAudio(app: FastifyInstance, meetings: MeetingActions, config: LiveAsrConfig): void {
  const server = new WebSocketServer({ noServer: true });
  app.server.on("upgrade", (request, socket, head) => {
    const match = /^\/api\/v1\/meetings\/([^/?]+)\/stream(?:\?(.*))?$/.exec(request.url ?? "");
    if (!match) return;
    const query = new URLSearchParams(match[2] ?? "");
    server.handleUpgrade(request, socket, head, (client) =>
      relay(client, decodeURIComponent(match[1]!), (query.get("speaker") ?? "").trim().slice(0, 80) || "Meeting"),
    );
  });

  async function relay(client: WebSocket, meetingId: string, speaker: string): Promise<void> {
    const tell = (message: object) => {
      if (client.readyState === client.OPEN) client.send(JSON.stringify(message));
    };
    const meeting = await meetings.get(meetingId).catch(() => null);
    if (!meeting || meeting.status !== "live") {
      tell({ type: "error", message: "This meeting is not live." });
      client.close();
      return;
    }
    // Sentences are appended one at a time, in the order they were heard.
    let appending: Promise<unknown> = Promise.resolve();
    const upstream = openDoubaoStream(
      config,
      { speakers: false, endWindowMs: LIVE_SENTENCE_PAUSE_MS },
      {
        onPartial: (text) => tell({ type: "partial", text }),
        onFinal: (sentence) => {
          appending = appending.then(() =>
            meetings.append(meetingId, [{ speaker, text: sentence.text }]).catch((error: unknown) => {
              tell({ type: "error", message: error instanceof Error ? error.message : String(error) });
            }),
          );
        },
        onError: (error) => {
          app.log.error({ meetingId, reason: error.message }, "Live speech recognition failed");
          tell({ type: "error", message: error.message });
        },
        onClose: () => {
          void appending.finally(() => client.close());
        },
      },
    );
    client.on("message", (data, isBinary) => {
      if (isBinary) upstream.send(Buffer.from(data as Buffer));
      else if (data.toString() === "end") upstream.finish();
    });
    client.on("close", () => upstream.finish());
  }
}
