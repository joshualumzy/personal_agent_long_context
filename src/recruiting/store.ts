import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { emptyState, type RecruitingState } from "./domain.js";

export interface StateStore {
  load(): Promise<RecruitingState>;
  save(state: RecruitingState): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The object entries of a saved list; a null or stray value is dropped rather than crashing a reader. */
function records<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter(isRecord) as T[]) : [];
}

function normalizeRole(raw: unknown): RecruitingState["role"] {
  if (!isRecord(raw)) return null;
  return {
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : "Open role",
    requirement: typeof raw.requirement === "string" ? raw.requirement : "",
    confirmed: raw.confirmed === true,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
  };
}

/** Keeps every candidate that still has a usable profile, with the fields later code relies on. */
function normalizeCandidates(raw: unknown): RecruitingState["candidates"] {
  const candidates: RecruitingState["candidates"] = {};
  if (!isRecord(raw)) return candidates;
  for (const value of Object.values(raw)) {
    if (!isRecord(value) || !isRecord(value.profile) || typeof value.profile.id !== "string") continue;
    const profile = value.profile as Record<string, unknown>;
    // Every lookup goes by the profile id, so that is the key, whatever the file used.
    const id = profile.id as string;
    if (Object.hasOwn(candidates, id)) continue;
    candidates[id] = {
      ...(value as object),
      profile: {
        ...(profile as object),
        id: profile.id as string,
        name: typeof profile.name === "string" ? profile.name : "Unnamed",
        headline: typeof profile.headline === "string" ? profile.headline : "",
        location: typeof profile.location === "string" ? profile.location : "",
        profileUrl: typeof profile.profileUrl === "string" ? profile.profileUrl : "",
        workHistory: Array.isArray(profile.workHistory) ? profile.workHistory : [],
        educationHistory: Array.isArray(profile.educationHistory) ? profile.educationHistory : [],
        summary: typeof profile.summary === "string" ? profile.summary : "",
      },
      stage: typeof value.stage === "string" ? value.stage : "discovered",
      kept: value.kept === true,
      verdicts: isRecord(value.verdicts)
        ? Object.fromEntries(Object.entries(value.verdicts).filter(([, verdict]) => isRecord(verdict)))
        : {},
      messages: records(value.messages),
      followUps: typeof value.followUps === "number" ? value.followUps : 0,
      poolRound: typeof value.poolRound === "number" ? value.poolRound : 1,
      discoveredAt: typeof value.discoveredAt === "string" ? value.discoveredAt : new Date(0).toISOString(),
    } as RecruitingState["candidates"][string];
  }
  return candidates;
}

/** Fills in whatever a saved file lacks, so an old or damaged file loads as far as it can. */
export function normalizeState(raw: unknown): RecruitingState {
  const base = emptyState();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return base;
  const saved = raw as Partial<RecruitingState>;
  const record = (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  return {
    ...base,
    ...saved,
    role: normalizeRole(saved.role),
    criteria: records(saved.criteria),
    candidates: normalizeCandidates(saved.candidates),
    feedback: records(saved.feedback),
    proposals: records(saved.proposals),
    rounds: records(saved.rounds),
    events: records(saved.events),
    expansionStep: Number.isInteger(saved.expansionStep) ? saved.expansionStep! : 0,
    clockOffsetDays: Number.isFinite(saved.clockOffsetDays) ? saved.clockOffsetDays! : 0,
  };
}

/** Local JSON file, written atomically. Holds third-party records; git-ignored. */
export class JsonFileStore implements StateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<RecruitingState> {
    try {
      return normalizeState(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return emptyState();
      }
      throw error;
    }
  }

  async save(state: RecruitingState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

export class MemoryStore implements StateStore {
  private state = emptyState();

  async load(): Promise<RecruitingState> {
    return structuredClone(this.state);
  }

  async save(state: RecruitingState): Promise<void> {
    this.state = structuredClone(state);
  }
}
