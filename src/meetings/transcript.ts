/**
 * Parses the OrgForge `zoom_transcript` body format into transcript turns,
 * and renders turns back for display.
 *
 * Observed shape (208 real rows checked in `aeriesec/orgforge`, dataset
 * revision "main"):
 *
 *   # Zoom Meeting Transcript
 *   **Date:** 2026-01-01
 *   **Topic:** aws tagging strategy design
 *   **Attendees:** Jax, Morgan, Yusuf, Tasha
 *
 *   ---
 *
 *   **[12:12:00] Jax:** hey everyone, goal is to lock down...
 *
 *   **[12:16:00] Morgan:** we can start by extending...
 *
 * Every real body starts with that header block, a `---` divider, then one
 * `**[HH:MM:SS] Speaker:** text` line per turn, blank-line separated. But a
 * turn is not always one line: about 15% of rows (checked directly) continue
 * a speaker's turn onto following lines with no new `**[...]** ` prefix —
 * numbered steps, a bullet list, a trailing sentence — before the blank line
 * that starts the next turn. This parser attaches any such line to the
 * previous speaker, per spec, rather than dropping it or misreading it as a
 * new turn.
 */

export interface ParsedSegment {
  speaker: string;
  text: string;
  /** ISO timestamp, present only when `occurredAt` was given to parseTranscript. */
  at?: string;
}

/** `**[H:MM:SS]` or `**[HH:MM:SS]`, optionally without the bold markers, a
 * speaker label up to the next colon, then optional same-line text. Anchored
 * on the bracketed clock time, which is the one structurally unmistakable
 * marker every real turn line carries. */
const TURN_LINE = /^\*{0,2}\[(\d{1,2}:\d{2}:\d{2})\]\s*([^:]+?):\*{0,2}\s?(.*)$/;

function normalizeTime(time: string): string {
  const [hours, minutes, seconds] = time.split(":");
  return `${(hours ?? "00").padStart(2, "0")}:${minutes ?? "00"}:${seconds ?? "00"}`;
}

/**
 * Splits a zoom_transcript body into speaker turns.
 *
 * `occurredAt` is the source document's occurred_at/timestamp (a full ISO
 * datetime carrying the meeting's date); each turn's `at` is that date
 * combined with the turn's own clock time. The body only ever carries a
 * time of day, never a date, so without `occurredAt` no `at` can be formed
 * and segments come back without one.
 *
 * Anything before the first recognised turn line (the `# Zoom Meeting
 * Transcript` header, `**Date:**`/`**Topic:**`/`**Attendees:**`, the `---`
 * divider) is metadata, not a turn, and is dropped rather than mis-attached.
 * Blank lines are turn separators and are dropped too. Any other line that
 * does not match a turn is a continuation of the previous turn, per spec.
 */
export function parseTranscript(body: string, occurredAt?: string): ParsedSegment[] {
  const baseDate = occurredAt && !Number.isNaN(Date.parse(occurredAt)) ? occurredAt.slice(0, 10) : undefined;
  const segments: ParsedSegment[] = [];

  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;

    const match = TURN_LINE.exec(line);
    if (match) {
      const [, time, speaker, rest] = match as unknown as [string, string, string, string];
      const segment: ParsedSegment = { speaker: speaker.trim(), text: rest.trim() };
      if (baseDate) segment.at = `${baseDate}T${normalizeTime(time)}.000Z`;
      segments.push(segment);
      continue;
    }

    const previous = segments[segments.length - 1];
    if (!previous) continue; // header/metadata line before any turn was seen
    previous.text = previous.text ? `${previous.text}\n${line}` : line;
  }

  return segments;
}

function timeOf(iso: string): string {
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return match ? match[1]! : "00:00:00";
}

/**
 * Inverse of parseTranscript, for display: one `**[HH:MM:SS] Speaker:**
 * text` block per segment (or `**Speaker:** text` when a segment has no
 * `at`), blank-line separated, matching the source format's own turn
 * layout. Does not reconstruct the `# Zoom Meeting Transcript` header,
 * since parseTranscript never returns that metadata as a segment either.
 */
export function formatTranscript(segments: ReadonlyArray<{ speaker: string; text: string; at?: string }>): string {
  return segments
    .map((segment) => {
      const label = segment.at ? `**[${timeOf(segment.at)}] ${segment.speaker}:**` : `**${segment.speaker}:**`;
      return `${label} ${segment.text}`;
    })
    .join("\n\n");
}
