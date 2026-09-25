import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { emptyState, type RecruitingState } from "./domain.js";

export interface StateStore {
  load(): Promise<RecruitingState>;
  save(state: RecruitingState): Promise<void>;
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
    role: record(saved.role) ? (saved.role as RecruitingState["role"]) : null,
    criteria: Array.isArray(saved.criteria) ? saved.criteria : [],
    candidates: (record(saved.candidates) as RecruitingState["candidates"]) ?? {},
    feedback: Array.isArray(saved.feedback) ? saved.feedback : [],
    proposals: Array.isArray(saved.proposals) ? saved.proposals : [],
    rounds: Array.isArray(saved.rounds) ? saved.rounds : [],
    events: Array.isArray(saved.events) ? saved.events : [],
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
