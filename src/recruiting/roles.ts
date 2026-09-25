import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { RecruitingError, type RecruitingState } from "./domain.js";
import type { RecruitingService } from "./service.js";
import { JsonFileStore, MemoryStore, type StateStore } from "./store.js";

/**
 * Where each open role keeps its state. Local JSON files for now; a database
 * implementation only has to provide these three methods.
 */
export interface RoleRepository {
  /** Ids of every role that has been saved at least once. */
  list(): Promise<string[]>;
  store(roleId: string): StateStore;
  remove(roleId: string): Promise<void>;
}

const ROLE_ID = /^[a-z0-9]{1,40}$/;

function checkedId(roleId: string): string {
  if (!ROLE_ID.test(roleId)) throw new RecruitingError("unknown_role", "No such role.", 404);
  return roleId;
}

/** One file per role in a directory. Holds third-party records; git-ignored. */
export class JsonRoleRepository implements RoleRepository {
  constructor(private readonly directory: string) {}

  async list(): Promise<string[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    return names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => ROLE_ID.test(id));
  }

  store(roleId: string): StateStore {
    return new JsonFileStore(join(this.directory, `${checkedId(roleId)}.json`));
  }

  async remove(roleId: string): Promise<void> {
    await rm(join(this.directory, `${checkedId(roleId)}.json`), { force: true });
  }

  /**
   * Moves the single-role file earlier versions wrote into this directory,
   * once. Returns the new role id, or null when there was nothing to move.
   */
  async adoptLegacy(legacyPath: string): Promise<string | null> {
    const found = await stat(legacyPath).catch(() => null);
    if (!found?.isFile()) return null;
    const state = JSON.parse(await readFile(legacyPath, "utf8")) as RecruitingState;
    if (!state.role) return null;
    const roleId = newRoleId();
    await mkdir(this.directory, { recursive: true });
    await rename(legacyPath, join(this.directory, `${roleId}.json`));
    return roleId;
  }
}

export class MemoryRoleRepository implements RoleRepository {
  private readonly stores = new Map<string, MemoryStore>();
  private readonly saved = new Set<string>();

  async list(): Promise<string[]> {
    return [...this.saved];
  }

  store(roleId: string): StateStore {
    let store = this.stores.get(roleId);
    if (!store) {
      store = new MemoryStore();
      this.stores.set(roleId, store);
    }
    const inner = store;
    return {
      load: () => inner.load(),
      save: async (state) => {
        this.saved.add(roleId);
        await inner.save(state);
      },
    };
  }

  async remove(roleId: string): Promise<void> {
    this.stores.delete(roleId);
    this.saved.delete(roleId);
  }
}

function newRoleId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

export interface RoleSummary {
  id: string;
  title: string;
  confirmed: boolean;
  createdAt: string;
  candidates: number;
  strong: number;
}

/** Every open role, each with its own recruiting service over its own state. */
export class RoleBoard {
  private readonly services = new Map<string, RecruitingService>();
  /** Roles being or already deleted: never opened again, even by a request already in flight. */
  private readonly removed = new Set<string>();

  constructor(
    private readonly repository: RoleRepository,
    private readonly serviceFor: (store: StateStore) => RecruitingService,
    private readonly onUnreadable?: (roleId: string, error: unknown) => void,
  ) {}

  async get(roleId: string): Promise<RecruitingService> {
    if (this.removed.has(roleId)) throw new RecruitingError("unknown_role", "No such role.", 404);
    const cached = this.services.get(roleId);
    if (cached) return cached;
    if (!(await this.repository.list()).includes(roleId)) {
      throw new RecruitingError("unknown_role", "No such role.", 404);
    }
    if (this.removed.has(roleId)) throw new RecruitingError("unknown_role", "No such role.", 404);
    // Another request may have opened it while we listed; one service per role.
    return this.services.get(roleId) ?? this.open(roleId);
  }

  /** A new, empty role. It is listed once its first change is saved. */
  create(): { id: string; service: RecruitingService } {
    const id = newRoleId();
    return { id, service: this.open(id) };
  }

  /** Drops a role that was created but never saved (its start failed). */
  forget(roleId: string): void {
    this.services.delete(roleId);
  }

  async remove(roleId: string): Promise<void> {
    const service = await this.get(roleId);
    this.removed.add(roleId);
    this.services.delete(roleId);
    // Stop the role first, so its background work cannot write the file back.
    try {
      await service.dispose();
      await this.repository.remove(roleId);
    } catch (error) {
      // The data is still there, so the delete must stay possible to retry.
      this.removed.delete(roleId);
      throw error;
    }
  }

  /** Every role that can be read, newest first. One damaged file never takes the others down. */
  async all(): Promise<Array<{ id: string; service: RecruitingService }>> {
    const readable: Array<{ id: string; service: RecruitingService; createdAt: string }> = [];
    for (const id of await this.repository.list()) {
      try {
        const service = await this.get(id);
        const snapshot = await service.snapshot();
        readable.push({ id, service, createdAt: snapshot.role?.createdAt ?? "" });
      } catch (error) {
        this.onUnreadable?.(id, error);
      }
    }
    return readable
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ id, service }) => ({ id, service }));
  }

  /** Newest first. */
  async list(): Promise<RoleSummary[]> {
    const summaries: RoleSummary[] = [];
    for (const { id, service } of await this.all()) {
      const snapshot = await service.snapshot();
      if (!snapshot.role) continue;
      const open = snapshot.candidates.filter((candidate) => candidate.stage !== "closed");
      summaries.push({
        id,
        title: snapshot.role.title,
        confirmed: snapshot.role.confirmed,
        createdAt: snapshot.role.createdAt,
        candidates: open.filter((candidate) => candidate.tier !== "out").length,
        strong: open.filter((candidate) => candidate.tier === 100).length,
      });
    }
    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private open(roleId: string): RecruitingService {
    const service = this.serviceFor(this.repository.store(roleId));
    this.services.set(roleId, service);
    return service;
  }
}
