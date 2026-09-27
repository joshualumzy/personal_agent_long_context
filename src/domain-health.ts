/**
 * How healthy each knowledge domain is on day D: who owns it and whether they
 * are still here, how much else that owner holds, who has actually worked in
 * it lately, and what has gone wrong in it.
 *
 * Read from what an employee could see and from approved projections only:
 * the graph (which pages, tickets and incidents are about a domain, and who
 * wrote or worked on them), the planner's ticket states, the roster and the
 * dated owner history. Never from OrgForge's own record of knowledge gaps,
 * which is the answer key the backtest scores this against (docs/mvp.md,
 * "Knowledge gaps and hiring proposals").
 */

/** How far back "lately" reaches: the 30 days ending on D. */
export const HEALTH_WINDOW_DAYS = 30;

export interface DomainHealth {
  domain: string;
  name: string;
  department: string | null;
  /** The designated owner on D, whether or not still employed. */
  owner: string | null;
  ownerSince: string | null;
  /** False when the owner has left: the domain is orphaned. */
  ownerActive: boolean;
  /** The day the owner left, when they have (from the roster). */
  ownerLeftOn: string | null;
  /** Domains that owner holds on D, this one included. 0 with no owner. */
  ownerLoad: number;
  /** Employed on D, and wrote a page, worked a ticket, or handled an incident
   * about this domain in the 30 days to D. */
  activeContributors30d: string[];
  /** Incident keys about this domain opened in the 30 days to D. */
  incidents30d: string[];
  /** Pages about or updating this domain in the 30 days to D. */
  pages30d: number;
  /** Citable artifacts behind the signals: pages, tickets, incidents. */
  evidence: { contributors: string[]; incidents: string[] };
}

/** The raw rows one day's health is assembled from. */
export interface DomainHealthInputs {
  domains: Array<{ key: string; name: string; department: string | null }>;
  /** Designated owner per domain on D. */
  owners: Array<{ domain: string; owner: string; since: string | null }>;
  /** People employed on D. */
  employed: Set<string>;
  /** Leave days known on D, by person. */
  leftOn?: Map<string, string>;
  /** One row per person's piece of work about a domain in the window. */
  work: Array<{ domain: string; person: string; sourceId: string; kind: "page" | "ticket" | "incident" }>;
  /** Incidents about a domain opened in the window. */
  incidents: Array<{ domain: string; key: string }>;
}

export function assembleHealth(inputs: DomainHealthInputs): DomainHealth[] {
  const ownerOf = new Map(inputs.owners.map((row) => [row.domain, row]));
  const load = new Map<string, number>();
  for (const row of inputs.owners) load.set(row.owner, (load.get(row.owner) ?? 0) + 1);

  return inputs.domains
    .map((domain) => {
      const owner = ownerOf.get(domain.key);
      const work = inputs.work.filter((row) => row.domain === domain.key);
      const contributors = [...new Set(work.filter((row) => inputs.employed.has(row.person)).map((row) => row.person))].sort();
      const incidents = [...new Set(inputs.incidents.filter((row) => row.domain === domain.key).map((row) => row.key))].sort();
      return {
        domain: domain.key,
        name: domain.name,
        department: domain.department,
        owner: owner?.owner ?? null,
        ownerSince: owner?.since ?? null,
        ownerActive: Boolean(owner && inputs.employed.has(owner.owner)),
        ownerLeftOn: owner ? inputs.leftOn?.get(owner.owner) ?? null : null,
        ownerLoad: owner ? load.get(owner.owner) ?? 0 : 0,
        activeContributors30d: contributors,
        incidents30d: incidents,
        pages30d: new Set(work.filter((row) => row.kind === "page").map((row) => row.sourceId)).size,
        evidence: {
          contributors: [...new Set(work.filter((row) => inputs.employed.has(row.person)).map((row) => row.sourceId))].sort(),
          incidents,
        },
      };
    })
    .sort((left, right) => left.domain.localeCompare(right.domain));
}
