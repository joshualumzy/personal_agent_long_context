/**
 * Hiring proposals: when a knowledge domain's health says the company should
 * consider hiring for it.
 *
 * A proposal is only a proposal (docs/mvp.md, "Knowledge gaps and hiring
 * proposals"). Opening a role from one starts a draft in recruiting; nothing
 * here confirms criteria, searches for people or sends anything.
 *
 * The rules read only src/domain-health.ts. Their thresholds were chosen by
 * scripts/backtest-hiring.ts against OrgForge's own record of departures and
 * hires (docs/evaluation/hiring-backtest.md says which and why):
 *
 *   orphaned    the owner has left and nobody has taken the domain on, for
 *               ORPHAN_MIN_DAYS working days running. One day is noise: three
 *               domains are orphaned on 2026-01-01 only because their hand-over
 *               is recorded on the 2nd.
 *   thin        over a full 30-day window, at most THIN_FRACTION of the
 *               contributors the median domain had that day. Needs a full
 *               window: early in the record everything looks thin.
 *   overloaded  the owner holds OVERLOAD_MIN_DOMAINS or more domains, and this
 *               one had OVERLOAD_MIN_INCIDENTS or more incidents in 30 days.
 *
 * A proposal opens the first working day any rule holds and closes the first
 * day none does. Its id is the domain and the day it opened, so the same
 * history always gives the same proposals.
 */
import type { DomainHealth } from "./domain-health.js";
import { HEALTH_WINDOW_DAYS } from "./domain-health.js";

export const ORPHAN_MIN_DAYS = 2;
export const THIN_FRACTION = 0.25;
export const OVERLOAD_MIN_DOMAINS = 3;
export const OVERLOAD_MIN_INCIDENTS = 2;

export type ProposalRule = "orphaned" | "thin" | "overloaded";

export interface ProposalReason {
  rule: ProposalRule;
  text: string;
}

export interface HiringProposal {
  /** `${domain}@${openedOn}` */
  id: string;
  domain: string;
  name: string;
  department: string | null;
  openedOn: string;
  /** The first working day no rule held; null while open. */
  closedOn: string | null;
  /** The reasons on the last day it was open (or the day asked about). */
  reasons: ProposalReason[];
  /** Every rule that held on some day while it was open, in first-seen order. */
  rulesSeen: ProposalRule[];
  /** Citable artifacts behind those reasons. */
  evidence: string[];
  suggestedTitle: string;
  suggestedDescription: string;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function listOf(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The reasons one domain gives on one day, given how long it has been orphaned. */
export function reasonsOn(
  health: DomainHealth,
  context: { orphanedDays: number; medianContributors: number; fullWindow: boolean },
): ProposalReason[] {
  const reasons: ProposalReason[] = [];
  if (health.owner && !health.ownerActive && context.orphanedDays >= ORPHAN_MIN_DAYS) {
    reasons.push({
      rule: "orphaned",
      text: `${health.owner}, who owned ${health.name}, ${health.ownerLeftOn ? `left on ${health.ownerLeftOn}` : "is no longer with the company"}, and nobody has taken it on for ${context.orphanedDays} working days.`,
    });
  }
  const contributors = health.activeContributors30d.length;
  if (context.fullWindow && contributors <= THIN_FRACTION * context.medianContributors) {
    reasons.push({
      rule: "thin",
      text: `Only ${contributors} ${contributors === 1 ? "person" : "people"} worked on ${health.name} in the last ${HEALTH_WINDOW_DAYS} days, against ${context.medianContributors} for the typical domain.`,
    });
  }
  if (health.owner && health.ownerActive && health.ownerLoad >= OVERLOAD_MIN_DOMAINS
      && health.incidents30d.length >= OVERLOAD_MIN_INCIDENTS) {
    reasons.push({
      rule: "overloaded",
      text: `${health.owner} owns ${health.ownerLoad} domains, and ${health.incidents30d.length} incidents (${health.incidents30d.join(", ")}) hit ${health.name} in the last ${HEALTH_WINDOW_DAYS} days.`,
    });
  }
  return reasons;
}

const FAMILY: Record<string, string> = {
  Engineering_Backend: "Backend engineer",
  Engineering_Mobile: "Mobile engineer",
  Product: "Product manager",
  Design: "Designer",
  QA_Support: "QA engineer",
  HR_Ops: "Operations specialist",
  Sales_Marketing: "Sales and marketing specialist",
};

/** A title and a description a person could start a role from, written from
 * what the proposal knows. Deterministic: no model writes it. */
export function suggestRole(health: DomainHealth, reasons: ProposalReason[]): { title: string; description: string } {
  const family = (health.department && FAMILY[health.department]) || "Engineer";
  const title = `${family} to own ${health.name}`;
  const peers = health.activeContributors30d.slice(0, 4);
  const description = [
    `We are hiring a ${family.toLowerCase()} to own ${health.name}${health.department ? ` in ${health.department.replace(/_/g, " ")}` : ""}.`,
    `Why now: ${reasons.map((reason) => reason.text).join(" ")}`,
    `They would take over ${health.name} end to end: its day-to-day work, its incidents, and keeping its documentation current${peers.length ? `, working with ${listOf(peers)}` : ""}.`,
    "Must: hands-on experience running " + health.name + " or a close equivalent in production.",
  ].join("\n\n");
  return { title, description };
}

/**
 * Walks the working days in order and returns every proposal opened on or
 * before the last day given. `healthOn(day)` is that day's health; only days
 * in `days` are read, so passing the days up to D keeps D's future out.
 */
export async function proposalsThrough(
  days: readonly string[],
  healthOn: (day: string) => Promise<DomainHealth[]>,
): Promise<HiringProposal[]> {
  const first = days[0];
  if (!first) return [];
  const orphanedFor = new Map<string, number>();
  const open = new Map<string, HiringProposal>();
  const all: HiringProposal[] = [];

  for (const day of days) {
    const health = await healthOn(day);
    const medianContributors = median(health.map((row) => row.activeContributors30d.length));
    const fullWindow = daysBetween(first, day) >= HEALTH_WINDOW_DAYS - 1;
    for (const row of health) {
      const orphanedDays = row.owner && !row.ownerActive ? (orphanedFor.get(row.domain) ?? 0) + 1 : 0;
      orphanedFor.set(row.domain, orphanedDays);
      const reasons = reasonsOn(row, { orphanedDays, medianContributors, fullWindow });
      const current = open.get(row.domain);
      if (!reasons.length) {
        if (current) {
          current.closedOn = day;
          open.delete(row.domain);
        }
        continue;
      }
      const evidence = [...new Set([...row.evidence.incidents, ...row.evidence.contributors])].slice(0, 12);
      const role = suggestRole(row, reasons);
      if (current) {
        for (const reason of reasons) if (!current.rulesSeen.includes(reason.rule)) current.rulesSeen.push(reason.rule);
        current.reasons = reasons;
        current.evidence = evidence;
        current.suggestedTitle = role.title;
        current.suggestedDescription = role.description;
        continue;
      }
      const proposal: HiringProposal = {
        id: `${row.domain}@${day}`,
        domain: row.domain,
        name: row.name,
        department: row.department,
        openedOn: day,
        closedOn: null,
        reasons,
        rulesSeen: reasons.map((reason) => reason.rule),
        evidence,
        suggestedTitle: role.title,
        suggestedDescription: role.description,
      };
      open.set(row.domain, proposal);
      all.push(proposal);
    }
  }
  return all;
}
