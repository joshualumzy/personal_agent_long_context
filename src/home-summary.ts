import type { JsonModel } from "./recruiting/llm.js";

/**
 * The line under the home's headline ("Jax, 5 things need you."), written by
 * the model the way a colleague would say it. The page shows its own plain
 * line first and swaps this in when it arrives; anything that is not one short
 * line is dropped, so the page keeps its own.
 */

export interface HomeItem {
  part: "needs" | "waiting" | "done";
  kind: string;
  title: string;
  meeting: string;
}

const MAX_ITEMS = 40;
const MAX_TEXT = 200;
const MAX_SENTENCE = 180;
const CACHE_SIZE = 200;

const SYSTEM = [
  "You write the one line under the headline of a work dashboard for an employee at a small company.",
  "The headline already says how many things need them. Your line says, the way a helpful colleague would, what those things are and where they came from.",
  "Name the one or two that matter most in plain words and refer to meetings the way people do ('the NOC call', 'the Kafka sync').",
  "If something is waiting on someone else, you may mention it briefly.",
  "One sentence, at most 24 words. No greeting, no name, no count repeated from the headline, no emoji, no quotation marks.",
  'Reply as JSON: {"sentence": "..."}',
].join(" ");

/** Parses a request body into items, or says why it cannot. */
export function readHomeItems(body: unknown): { name: string; items: HomeItem[] } | { error: string } {
  const value = (body ?? {}) as { name?: unknown; items?: unknown };
  if (!Array.isArray(value.items)) return { error: "items must be a list." };
  if (value.items.length > MAX_ITEMS) return { error: `At most ${MAX_ITEMS} items.` };
  const text = (entry: unknown) => (typeof entry === "string" ? entry.trim().slice(0, MAX_TEXT) : "");
  const items: HomeItem[] = [];
  for (const raw of value.items as Array<Record<string, unknown>>) {
    const part = raw?.part;
    if (part !== "needs" && part !== "waiting" && part !== "done") return { error: "Each item needs a part: needs, waiting or done." };
    items.push({ part, kind: text(raw.kind), title: text(raw.title), meeting: text(raw.meeting) });
  }
  return { name: text(value.name).slice(0, 60), items };
}

/** One short line, or nothing. */
export function oneShortLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = value.trim().replace(/^["'“”]+|["'“”]+$/g, "");
  if (!line || line.length > MAX_SENTENCE || /[\r\n]/.test(line)) return null;
  return line;
}

export class HomeSummarizer {
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly model: JsonModel) {}

  async summarize(name: string, items: HomeItem[]): Promise<string | null> {
    if (items.length === 0) return null;
    const key = JSON.stringify([name, items]);
    if (this.cache.has(key)) return this.cache.get(key)!;
    let sentence: string | null = null;
    try {
      const reply = await this.model.json<{ sentence?: unknown }>({
        task: "home-summary",
        system: SYSTEM,
        input: { name, items },
        fast: true,
      });
      sentence = oneShortLine(reply?.sentence);
    } catch {
      sentence = null;
    }
    // A failure is not remembered: the next visit may find the model back.
    if (sentence) {
      if (this.cache.size >= CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, sentence);
    }
    return sentence;
  }
}
