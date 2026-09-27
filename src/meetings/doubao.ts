import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import WebSocket from "ws";

/**
 * Doubao streaming speech recognition 2.0 (Volcengine), over its binary
 * WebSocket protocol. Audio goes in as 16 kHz mono 16-bit PCM, a few hundred
 * milliseconds at a time; what comes back is the sentence being spoken (for
 * live display) and each sentence once it is final.
 *
 * Protocol: https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket
 */

const URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";

export interface LiveAsrConfig {
  apiKey: string;
  resourceId: string;
}

export interface FinalSentence {
  text: string;
  startMs: number;
  endMs: number;
  speaker?: string;
}

export interface AsrHandlers {
  /** The sentence still being spoken, replaced by each call. */
  onPartial(text: string): void;
  onFinal(sentence: FinalSentence): void;
  onError(error: Error): void;
  onClose(): void;
}

export interface AsrStream {
  send(pcm: Buffer): void;
  /** No more audio: the service finishes the last sentence, then closes. */
  finish(): void;
  close(): void;
}

// Message types and flags from the protocol header.
const FULL_REQUEST = 0x1;
const AUDIO_ONLY = 0x2;
const SERVER_RESPONSE = 0x9;
const SERVER_ERROR = 0xf;
const POSITIVE_SEQUENCE = 0x1;
const LAST_WITH_SEQUENCE = 0x3;

function frame(type: number, flags: number, payload: Buffer, sequence: number): Buffer {
  const body = gzipSync(payload);
  const out = Buffer.alloc(12 + body.length);
  out[0] = 0x11; // protocol version 1, 4-byte header
  out[1] = (type << 4) | flags;
  out[2] = 0x11; // JSON, gzip
  out[3] = 0;
  out.writeInt32BE(sequence, 4);
  out.writeUInt32BE(body.length, 8);
  body.copy(out, 12);
  return out;
}

interface Utterance {
  text?: string;
  definite?: boolean;
  start_time?: number;
  end_time?: number;
  additions?: { speaker_id?: string };
}

function parse(data: Buffer): { error?: string; utterances?: Utterance[] } {
  const type = data[1]! >> 4;
  const flags = data[1]! & 0x0f;
  const gzipped = (data[2]! & 0x0f) === 1;
  let offset = 4;
  if (type === SERVER_ERROR) {
    const code = data.readUInt32BE(offset);
    const size = data.readUInt32BE(offset + 4);
    return { error: `${code}: ${data.subarray(offset + 8, offset + 8 + size).toString("utf8")}` };
  }
  if (type !== SERVER_RESPONSE) return {};
  if (flags & 0x1) offset += 4; // sequence number
  const size = data.readUInt32BE(offset);
  let body = data.subarray(offset + 4, offset + 4 + size);
  if (gzipped && body.length) body = gunzipSync(body);
  if (!body.length) return {};
  const json = JSON.parse(body.toString("utf8")) as { result?: { utterances?: Utterance[] } };
  return { utterances: json.result?.utterances ?? [] };
}

export function openDoubaoStream(
  config: LiveAsrConfig,
  options: { speakers: boolean; endWindowMs: number },
  handlers: AsrHandlers,
): AsrStream {
  const socket = new WebSocket(URL, {
    headers: {
      "X-Api-Key": config.apiKey,
      "X-Api-Resource-Id": config.resourceId,
      "X-Api-Request-Id": randomUUID(),
      "X-Api-Connect-Id": randomUUID(),
    },
  });
  let sequence = 1;
  let ready = false;
  let finished = false;
  const waiting: Buffer[] = [];
  const sentFinal = new Set<string>();

  const sendAudio = (pcm: Buffer, last: boolean) => {
    sequence += 1;
    socket.send(frame(AUDIO_ONLY, last ? LAST_WITH_SEQUENCE : POSITIVE_SEQUENCE, pcm, last ? -sequence : sequence));
  };

  socket.on("open", () => {
    const request = {
      user: { uid: "meeting" },
      audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
      request: {
        model_name: "bigmodel",
        enable_itn: true,
        enable_punc: true,
        show_utterances: true,
        result_type: "full",
        // A sentence is final once this much silence follows it; the second
        // pass then re-reads that sentence for the kept text.
        end_window_size: options.endWindowMs,
        enable_nonstream: true,
        enable_speaker_info: options.speakers,
      },
    };
    socket.send(frame(FULL_REQUEST, POSITIVE_SEQUENCE, Buffer.from(JSON.stringify(request)), sequence));
  });

  socket.on("message", (data: Buffer) => {
    let message: ReturnType<typeof parse>;
    try {
      message = parse(data);
    } catch (error) {
      handlers.onError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (message.error) {
      handlers.onError(new Error(`Speech recognition failed (${message.error})`));
      socket.close();
      return;
    }
    if (!ready) {
      // The first reply acknowledges the request; audio held until now goes out.
      ready = true;
      for (const pcm of waiting.splice(0)) sendAudio(pcm, false);
      if (finished) sendAudio(Buffer.alloc(0), true);
      return;
    }
    let partial = "";
    for (const utterance of message.utterances ?? []) {
      if (!utterance.text) continue;
      if (!utterance.definite) {
        partial = utterance.text;
        continue;
      }
      const key = `${utterance.start_time}-${utterance.end_time}`;
      if (sentFinal.has(key)) continue;
      sentFinal.add(key);
      handlers.onFinal({
        text: utterance.text,
        startMs: utterance.start_time ?? 0,
        endMs: utterance.end_time ?? 0,
        ...(utterance.additions?.speaker_id !== undefined ? { speaker: utterance.additions.speaker_id } : {}),
      });
    }
    handlers.onPartial(partial);
  });

  socket.on("error", (error) => handlers.onError(error));
  socket.on("close", () => handlers.onClose());

  return {
    send(pcm) {
      if (finished || socket.readyState > WebSocket.OPEN) return;
      if (ready) sendAudio(pcm, false);
      else waiting.push(pcm);
    },
    finish() {
      if (finished) return;
      finished = true;
      if (ready && socket.readyState === WebSocket.OPEN) sendAudio(Buffer.alloc(0), true);
    },
    close() {
      socket.close();
    },
  };
}
