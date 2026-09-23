import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CandidateProfile, EducationEntry, WorkEntry } from "./domain.js";

export interface CandidateSource {
  readonly name: string;
  search(query: string, limit: number): Promise<CandidateProfile[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stableId(url: string, name: string): string {
  return createHash("sha256").update(url || name).digest("hex").slice(0, 16);
}

/** Maps one Exa `category: "people"` result to the fields we keep. */
export function profileFromExaResult(result: unknown): CandidateProfile | null {
  if (!isRecord(result)) return null;
  const entities = Array.isArray(result.entities) ? result.entities : [];
  const person = entities.find(
    (entity): entity is Record<string, unknown> =>
      isRecord(entity) && entity.type === "person",
  );
  const properties = person && isRecord(person.properties) ? person.properties : {};

  const workHistory: WorkEntry[] = (
    Array.isArray(properties.workHistory) ? properties.workHistory : []
  )
    .filter(isRecord)
    .map((entry) => ({
      title: str(entry.title),
      company: isRecord(entry.company) ? str(entry.company.name) : "",
      ...(isRecord(entry.dates) && str(entry.dates.from) ? { from: str(entry.dates.from) } : {}),
      ...(isRecord(entry.dates) && str(entry.dates.to) ? { to: str(entry.dates.to) } : {}),
    }))
    .filter((entry) => entry.title || entry.company);

  const educationHistory: EducationEntry[] = (
    Array.isArray(properties.educationHistory) ? properties.educationHistory : []
  )
    .filter(isRecord)
    .map((entry) => ({
      degree: str(entry.degree),
      institution: isRecord(entry.institution) ? str(entry.institution.name) : "",
      ...(isRecord(entry.dates) && str(entry.dates.from) ? { from: str(entry.dates.from) } : {}),
      ...(isRecord(entry.dates) && str(entry.dates.to) ? { to: str(entry.dates.to) } : {}),
    }))
    .filter((entry) => entry.degree || entry.institution);

  const title = str(result.title);
  const name = str(properties.name) || title.split(/\s[-|–]\s/)[0]!.trim();
  if (!name) return null;
  const url = str(result.url);
  const current = workHistory.find((entry) => !entry.to) ?? workHistory[0];

  return {
    id: stableId(url, name),
    name,
    headline:
      title.split(/\s[-|–]\s/).slice(1).join(" · ") ||
      (current ? `${current.title} at ${current.company}` : ""),
    location: str(properties.location),
    profileUrl: url,
    workHistory,
    educationHistory,
    summary: str(result.text).slice(0, 2000),
  };
}

export class ExaPeopleSource implements CandidateSource {
  readonly name = "exa";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async search(query: string, limit: number): Promise<CandidateProfile[]> {
    const response = await this.fetchImpl("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        query,
        category: "people",
        type: "auto",
        numResults: Math.min(Math.max(limit, 1), 100),
        contents: { text: { maxCharacters: 2000 } },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Exa search failed with HTTP ${response.status}.`);
    }
    const body = (await response.json()) as { results?: unknown[] };
    return (body.results ?? [])
      .map(profileFromExaResult)
      .filter((profile): profile is CandidateProfile => profile !== null);
  }
}

/**
 * Serves invented profiles from a JSON file so the app runs without an Exa key.
 * Every profile it returns is fictional; the UI labels them as sample data.
 * Search is a crude keyword overlap, enough to make expansion visibly add people.
 */
export class SampleSource implements CandidateSource {
  readonly name = "sample";
  private profiles: Promise<CandidateProfile[]>;

  constructor(path: string) {
    this.profiles = readFile(path, "utf8").then(
      (content) => JSON.parse(content) as CandidateProfile[],
    );
  }

  async search(query: string, limit: number): Promise<CandidateProfile[]> {
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((word) => word.length > 2);
    const scored = (await this.profiles).map((profile) => {
      const haystack = JSON.stringify(profile).toLowerCase();
      return {
        profile,
        score: words.filter((word) => haystack.includes(word)).length,
      };
    });
    return scored
      .sort((left, right) => right.score - left.score || left.profile.id.localeCompare(right.profile.id))
      .slice(0, limit)
      .map((entry) => entry.profile);
  }
}
