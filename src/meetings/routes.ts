import type { FastifyInstance, FastifyReply } from "fastify";
import type { ActionPayload, MeetingActions, MeetingEvent } from "./domain.js";
import { MeetingError } from "./domain.js";

export interface GoogleStatus {
  connected: boolean;
  /** Calendar free/busy granted, so invites can be checked. */
  calendar: boolean;
}

export interface RegisterMeetingRoutesOptions {
  /** Google connection, for the page to offer connecting it. Absent means Google is not configured. */
  googleStatus?: () => Promise<GoogleStatus>;
  /** Loads an OrgForge meeting to replay. Absent means replay is not configured. */
  loadReplay?: (
    sourceId: string,
  ) => Promise<{ title: string; segments: Array<{ speaker: string; text: string; at?: string }> } | null>;
  /** Feeds segments into the meeting over time, in the background. Not awaited by the route. */
  replay?: (
    meetingId: string,
    segments: Array<{ speaker: string; text: string; at?: string }>,
    intervalMs: number,
  ) => void;
  /** Lists the OrgForge meetings available to replay. */
  listReplays?: () => Promise<Array<{ sourceId: string; title: string }>>;
}

const DEFAULT_REPLAY_EMPLOYEE_ID = "jax";
const DEFAULT_REPLAY_INTERVAL_MS = 1_500;
const MIN_REPLAY_INTERVAL_MS = 50;
const MAX_REPLAY_INTERVAL_MS = 60_000;
const MAX_SEGMENTS_PER_CALL = 50;
const MAX_SEGMENT_TEXT_LENGTH = 2_000;
const HEARTBEAT_MS = 15_000;

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
  work: (body: unknown, params: Record<string, string>) => Promise<{ status: number; body: T }>,
) {
  return async (request: { body: unknown; params: unknown }, reply: FastifyReply) => {
    try {
      const { status, body } = await work(request.body, (request.params ?? {}) as Record<string, string>);
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

  app.get(
    "/api/v1/meetings/integrations",
    route(app, async () => ({
      status: 200,
      body: {
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

      const meeting = await meetings.start({ title: loaded.title, employeeId, sourceId });
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
