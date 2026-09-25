import { verdictFor, type Candidate, type Criterion, type Tier } from "./domain.js";

/**
 * 100: every active criterion is met.
 * 75: every must is met, some nice is not.
 * 50: exactly one must is not met or is unclear.
 * out: two or more musts are not met.
 * pending: a verdict is still missing.
 */
export function tierOf(candidate: Candidate, criteria: readonly Criterion[]): Tier {
  const active = criteria.filter((criterion) => criterion.active);
  if (active.length === 0) return "pending";

  let mustMisses = 0;
  let niceMisses = 0;
  for (const criterion of active) {
    const verdict = verdictFor(candidate, criterion.id);
    if (!verdict) return "pending";
    if (verdict.satisfied === "yes") continue;
    if (criterion.kind === "must") mustMisses += 1;
    else niceMisses += 1;
  }

  if (mustMisses === 0) return niceMisses === 0 ? 100 : 75;
  return mustMisses === 1 ? 50 : "out";
}

/** Whether a candidate still belongs in the orbit at all. */
export function isInPool(candidate: Candidate): boolean {
  return candidate.stage !== "closed";
}
