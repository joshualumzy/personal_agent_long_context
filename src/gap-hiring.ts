/**
 * Hiring proposals as people see and act on them: which are open on a day,
 * which already have a role, which were dismissed, and opening a role from one.
 *
 * The proposals themselves come from src/hiring-proposals.ts, recomputed from
 * domain health for the day asked about. What people did with them — opened a
 * role, dismissed one — is kept in a small ledger, which is today's state and
 * applies whatever day is being looked at.
 *
 * Opening a role only starts a draft in recruiting, with the proposal as its
 * origin. Confirming criteria, searching and outreach stay with a person
 * (docs/mvp.md, "Knowledge gaps and hiring proposals"). While a domain has a
 * role opened from a proposal, no other proposal for it is shown.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AsOf } from "./as-of.js";
import type { CompanyKnowledge } from "./company-domain.js";
import { proposalsThrough, type HiringProposal } from "./hiring-proposals.js";

export interface GapLedgerEntry {
  proposalId: string;
  domain: string;
  action: "role_opened" | "dismissed";
  roleId?: string;
  reason?: string;
  by: string;
  at: string;
}

export interface GapLedger {
  all(): Promise<GapLedgerEntry[]>;
  add(entry: GapLedgerEntry): Promise<void>;
}

export class MemoryGapLedger implements GapLedger {
  private readonly entries: GapLedgerEntry[] = [];
  async all() {
    return structuredClone(this.entries);
  }
  async add(entry: GapLedgerEntry) {
    this.entries.push(structuredClone(entry));
  }
}

/** One JSON file, written whole through a temporary file. */
export class JsonGapLedger implements GapLedger {
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  async all(): Promise<GapLedgerEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as { entries?: GapLedgerEntry[] };
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  add(entry: GapLedgerEntry): Promise<void> {
    // One write at a time, so two clicks cannot lose each other's entry.
    this.writing = this.writing.then(async () => {
      const entries = [...(await this.all()), entry];
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, JSON.stringify({ entries }, null, 2), { mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.writing;
  }
}

/** Where a role opened from a proposal came from; kept on the role. */
export interface GapRoleOrigin {
  kind: "knowledge_gap";
  proposalId: string;
  domain: string;
  name?: string;
  reasons: string[];
  evidence: string[];
  asOf: string;
}

/** What gap hiring needs from recruiting: start a draft role, and say whether one still exists. */
export interface RoleStarter {
  start(description: string, origin: GapRoleOrigin): Promise<{ roleId: string; title: string }>;
  exists(roleId: string): Promise<boolean>;
}

export interface ListedProposal extends HiringProposal {
  status: "open" | "role_opened" | "dismissed";
  roleId?: string;
}

export class GapHiringError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "unavailable", message: string) {
    super(message);
  }
}

export class GapHiring {
  constructor(
    private readonly knowledge: CompanyKnowledge,
    private readonly ledger: GapLedger,
    private readonly roles?: RoleStarter,
  ) {}

  /** Whether proposals can be made at all here. */
  get available(): boolean {
    return Boolean(this.knowledge.workingDays && this.knowledge.domainHealth);
  }

  get canOpenRoles(): boolean {
    return Boolean(this.roles);
  }

  /**
   * The proposals open on day D, each with what people did about it. A
   * dismissed one is listed as such; while a domain has a role opened from a
   * proposal, only that proposal is listed for it.
   */
  async list(day: AsOf): Promise<ListedProposal[]> {
    const proposals = await this.openOn(day);
    const entries = await this.ledger.all();
    const liveRoles = new Map<string, GapLedgerEntry>();
    for (const entry of entries) {
      if (entry.action === "role_opened" && entry.roleId && (await this.roleExists(entry.roleId))) {
        liveRoles.set(entry.domain, entry);
      }
    }
    const listed: ListedProposal[] = [];
    for (const proposal of proposals) {
      const role = liveRoles.get(proposal.domain);
      if (role) {
        if (role.proposalId === proposal.id) listed.push({ ...proposal, status: "role_opened", roleId: role.roleId! });
        continue;
      }
      const dismissed = entries.some((entry) => entry.action === "dismissed" && entry.proposalId === proposal.id);
      listed.push({ ...proposal, status: dismissed ? "dismissed" : "open" });
    }
    // A role opened from a proposal that has since closed is still worth showing.
    for (const [domain, entry] of liveRoles) {
      if (!listed.some((item) => item.domain === domain)) {
        const earlier = (await this.allThrough(day)).find((proposal) => proposal.id === entry.proposalId);
        if (earlier) listed.push({ ...earlier, status: "role_opened", roleId: entry.roleId! });
      }
    }
    return listed.sort((left, right) => left.openedOn.localeCompare(right.openedOn) || left.domain.localeCompare(right.domain));
  }

  /** Opens a draft role from an open proposal. Refuses a closed, dismissed or already-opened one. */
  async openRole(proposalId: string, day: AsOf, by: string): Promise<{ roleId: string; title: string }> {
    if (!this.roles) throw new GapHiringError("unavailable", "Recruiting is not configured here.");
    const listed = (await this.list(day)).find((proposal) => proposal.id === proposalId);
    if (!listed) throw new GapHiringError("not_found", "There is no open proposal by that id on this day.");
    if (listed.status === "role_opened") throw new GapHiringError("conflict", "A role is already open for this domain.");
    if (listed.status === "dismissed") throw new GapHiringError("conflict", "This proposal was dismissed.");
    const role = await this.roles.start(listed.suggestedDescription, {
      kind: "knowledge_gap",
      proposalId: listed.id,
      domain: listed.domain,
      name: listed.name,
      reasons: listed.reasons.map((reason) => reason.text),
      evidence: listed.evidence,
      asOf: day,
    });
    await this.ledger.add({
      proposalId: listed.id, domain: listed.domain, action: "role_opened", roleId: role.roleId,
      by, at: new Date().toISOString(),
    });
    return role;
  }

  async dismiss(proposalId: string, day: AsOf, by: string, reason?: string): Promise<void> {
    const listed = (await this.list(day)).find((proposal) => proposal.id === proposalId);
    if (!listed) throw new GapHiringError("not_found", "There is no open proposal by that id on this day.");
    if (listed.status === "role_opened") throw new GapHiringError("conflict", "A role is already open for this proposal.");
    if (listed.status === "dismissed") return;
    await this.ledger.add({
      proposalId: listed.id, domain: listed.domain, action: "dismissed",
      ...(reason?.trim() ? { reason: reason.trim().slice(0, 500) } : {}),
      by, at: new Date().toISOString(),
    });
  }

  private async roleExists(roleId: string): Promise<boolean> {
    return this.roles ? this.roles.exists(roleId) : true;
  }

  private async allThrough(day: AsOf): Promise<HiringProposal[]> {
    if (!this.knowledge.workingDays || !this.knowledge.domainHealth) {
      throw new GapHiringError("unavailable", "Domain health is not configured.");
    }
    const days = (await this.knowledge.workingDays()).filter((candidate) => candidate <= day);
    const health = this.knowledge.domainHealth.bind(this.knowledge);
    return proposalsThrough(days, (when) => health(when as AsOf));
  }

  private async openOn(day: AsOf): Promise<HiringProposal[]> {
    return (await this.allThrough(day)).filter((proposal) => proposal.closedOn === null || proposal.closedOn > day);
  }
}
