import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { emptyState, type RecruitingState } from "./domain.js";

export interface StateStore {
  load(): Promise<RecruitingState>;
  save(state: RecruitingState): Promise<void>;
}

/** Local JSON file, written atomically. Holds third-party records; git-ignored. */
export class JsonFileStore implements StateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<RecruitingState> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as RecruitingState;
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
