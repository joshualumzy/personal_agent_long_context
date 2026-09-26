import { randomUUID } from "node:crypto";
import {
  draftMessage,
  EXPANSION_LADDER,
  extractBrief,
  findPattern,
  inferReason,
  interpret,
  judge,
  planExpansion,
  privateRemarksIn,
  readReply,
  retitle,
  writeQueries,
} from "./agent.js";
import { findContact, type ContactFinder } from "./contacts.js";
import {
  emptyState,
  RecruitingError,
  verdictFor,
  type Candidate,
  type CandidateProfile,
  type ClosedReason,
  type CriteriaOperation,
  type Criterion,
  type CriterionKind,
  type Draft,
  type HiringEvent,
  type Message,
  type Proposal,
  type RecruitingState,
  type Tier,
} from "./domain.js";
import type { GmailClient } from "./gmail.js";
import type { IntentMemory } from "./intent-memory.js";
import type { JsonModel } from "./llm.js";
import { canonicalProfileUrl, type CandidateSource } from "./sources.js";
import type { StateStore } from "./store.js";
import { isInPool, tierOf } from "./tiers.js";

const DAY_MS = 86_400_000;
/** Longest requirement passed to the model, typed or read from a file. */
const MAX_REQUIREMENT = 8000;

export interface RecruitingSettings {
  /** People to add per search round. The first round is kept small on purpose. */
  /** People asked of each search query. Everyone returned is scored. */
  resultsPerQuery: number;
  /** Same-direction decisions needed before the agent proposes a criterion. */
  preferenceThreshold: number;
  followUpAfterDays: number;
  coldAfterDays: number;
  expandAfterDays: number;
  retentionDays: number;
  judgeConcurrency: number;
  founderName?: string;
  companyName?: string;
  /** One sentence on what the company builds; gives outreach something real to say. */
  companyPitch?: string;
  /** Pause before candidates whose scoring failed are tried again, and how many times. */
  rescoreAfterMs: number;
  rescoreAttempts: number;
}

export const DEFAULT_SETTINGS: RecruitingSettings = {
  resultsPerQuery: 30,
  preferenceThreshold: 2,
  followUpAfterDays: 5,
  coldAfterDays: 7,
  expandAfterDays: 7,
  retentionDays: 30,
  judgeConcurrency: 8,
  rescoreAfterMs: 30_000,
  rescoreAttempts: 3,
};

export interface RecruitingDependencies {
  model: JsonModel;
  source: CandidateSource;
  store: StateStore;
  memory: IntentMemory;
  contactFinders: ContactFinder[];
  gmail: GmailClient | null;
  clock?: () => Date;
  settings?: Partial<RecruitingSettings>;
  onError?: (context: string, error: unknown) => void;
}

export interface SayResult {
  intent: string;
  message: string;
  /** For a reply: whether it was saved on someone's record. */
  recorded?: boolean;
  refused?: { text: string; characteristic: string }[];
}

/** Who a profile is, however the source spelled the address. */
function personKey(profile: CandidateProfile): string {
  return profile.profileUrl ? canonicalProfileUrl(profile.profileUrl) : profile.id;
}

/**
 * Keeps one record per person when the same profile arrived under two
 * addresses: the one the founder has done the most with. References to the
 * dropped record move to the kept one.
 */
function mergeDuplicatePeople(state: RecruitingState): void {
  const progress = (candidate: Candidate) =>
    // A decision the founder made (pass, hire, decline) outranks everything else.
    (candidate.stage === "closed" ? 10_000 : 0) +
    candidate.messages.length * 100 +
    (candidate.draft ? 50 : 0) +
    (candidate.kept ? 20 : 0) +
    (candidate.contact ? 10 : 0) +
    (candidate.stage === "discovered" ? 0 : 5) +
    Object.keys(candidate.verdicts).length;
  const byPerson = new Map<string, Candidate>();
  const renamed = new Map<string, string>();
  for (const candidate of Object.values(state.candidates)) {
    const key = personKey(candidate.profile);
    const other = byPerson.get(key);
    if (!other) {
      byPerson.set(key, candidate);
      continue;
    }
    const [kept, dropped] = progress(candidate) > progress(other) ? [candidate, other] : [other, candidate];
    byPerson.set(key, kept);
    renamed.set(dropped.profile.id, kept.profile.id);
    delete state.candidates[dropped.profile.id];
  }
  if (renamed.size === 0) return;
  // Three copies can rename a -> b and later b -> c; follow the chain to the survivor.
  const survivor = (id: string) => {
    let current = id;
    for (let hops = 0; renamed.has(current) && hops < renamed.size; hops += 1) current = renamed.get(current)!;
    return current;
  };
  for (const entry of state.feedback) entry.candidateId = survivor(entry.candidateId);
  for (const proposal of state.proposals) {
    if (proposal.type === "criterion") {
      proposal.supportingCandidateIds = [
        ...new Set(proposal.supportingCandidateIds.map(survivor)),
      ];
    }
  }
}

const UNCONFIRMED =
  "Gmail did not confirm this email, so it may have gone out. Check your Sent folder: if it is there, mark it as sent by hand; if not, edit the draft and send it again.";

/** Relayed text compared without time labels ("10:32 AM", "Tue", "Yesterday") or spacing. */
function sameRelayedText(a: string, b: string): boolean {
  const plain = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !TIME_LABEL.test(line))
      .join(" ")
      .replace(/\s+/g, " ")
      .toLowerCase();
  return plain(a) === plain(b);
}

const TIME_LABEL =
  /^(\d{1,2}:\d{2}(\s*[ap]m)?|now|yesterday|today|mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|[a-z]{3} \d{1,2}(, \d{4})?|\d{1,2}\/\d{1,2}(\/\d{2,4})?|\d+[mhdw])$/i;

function rewritten(): RecruitingError {
  return new RecruitingError("invalid_state", "You rewrote this draft yourself, so it is kept. Edit it in the outreach tab.", 409);
}

function beingSent(): RecruitingError {
  return new RecruitingError("already_sending", "The current draft is being sent, so it cannot be replaced.", 409);
}

/** Only a refusal (not connected, or Gmail answering with an error status) proves nothing went out. */
function certainlyNotSent(error: unknown): boolean {
  if (error instanceof RecruitingError) return true;
  const message = error instanceof Error ? error.message : String(error);
  // A reply Gmail sent but that could not be read (a proxy page) proves nothing either way.
  return /HTTP \d{3}|not connected/i.test(message);
}

interface SentMessage {
  draft: Draft;
  threadId: string | undefined;
  channel: "email" | "linkedin";
  /** When it went out, if known; Gmail sync reads replies after this. */
  realAt?: string;
}

export class RecruitingService {
  private state: RecruitingState | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private settling: Promise<void> | null = null;
  private settleAgain = false;
  private backgroundWork = 0;
  private lastError: string | null = null;
  private disposed = false;
  readonly settings: RecruitingSettings;

  constructor(private readonly deps: RecruitingDependencies) {
    this.settings = { ...DEFAULT_SETTINGS, ...deps.settings };
  }

  // ---------------------------------------------------------------- plumbing

  private now(state: RecruitingState): Date {
    const real = (this.deps.clock ?? (() => new Date()))();
    return new Date(real.getTime() + state.clockOffsetDays * DAY_MS);
  }

  private loading: Promise<RecruitingState> | null = null;

  private async current(): Promise<RecruitingState> {
    if (this.state) return this.state;
    // Concurrent first callers share one load, so an older copy can never land last.
    this.loading ??= this.load().catch((error: unknown) => {
      // A load that failed (a busy or damaged file) is tried again next time.
      this.loading = null;
      throw error;
    });
    return this.loading;
  }

  private async load(): Promise<RecruitingState> {
    {
      const loaded = await this.deps.store.load();
      // A brief earlier version kept unscored search results aside. They are paid for; score them.
      const legacy = loaded as RecruitingState & { reserve?: CandidateProfile[] };
      if (legacy.reserve?.length) {
        const known = new Set(Object.values(loaded.candidates).map((candidate) => personKey(candidate.profile)));
        this.addToPool(loaded, legacy.reserve.filter((profile) => !known.has(personKey(profile))));
        delete legacy.reserve;
        queueMicrotask(() => this.settle());
      }
      mergeDuplicatePeople(loaded);
      // Earlier versions guessed addresses. A guess could reach a stranger, so drop it.
      for (const candidate of Object.values(loaded.candidates)) {
        if ((candidate.contact?.provider as string | undefined) === "guess") delete candidate.contact;
      }
      this.state = loaded;
      return loaded;
    }
  }

  /**
   * Runs one change at a time. The change edits a copy, which replaces the
   * state only after the change and the save both succeed: a change that
   * throws halfway leaves nothing behind.
   */
  private mutate<T>(change: (state: RecruitingState) => Promise<T> | T): Promise<T> {
    const run = this.chain.then(async () => {
      if (this.disposed) throw new RecruitingError("unknown_role", "No such role.", 404);
      this.uncommitted = [];
      const draft = structuredClone(await this.current());
      const result = await change(draft);
      if (this.disposed) return result;
      await this.deps.store.save(draft);
      this.state = draft;
      const events = this.uncommitted;
      this.uncommitted = [];
      for (const event of events) this.deps.memory.record(event);
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Events recorded by the change in progress; Memory hears them only once it is saved. */
  private uncommitted: HiringEvent[] = [];

  private record(state: RecruitingState, kind: string, summary: string): void {
    const event = { at: this.now(state).toISOString(), kind, summary };
    state.events.push(event);
    this.uncommitted.push(event);
  }

  private realNow(): string {
    return (this.deps.clock ?? (() => new Date()))().toISOString();
  }

  private fail(context: string, error: unknown): void {
    this.lastError = `${context}: ${error instanceof Error ? error.message : String(error)}`;
    this.deps.onError?.(context, error);
  }

  private background(context: string, work: () => Promise<void>): void {
    this.backgroundWork += 1;
    void work()
      .catch((error) => this.fail(context, error))
      .finally(() => {
        this.backgroundWork -= 1;
      });
  }

  private candidate(state: RecruitingState, id: string): Candidate {
    // Own keys only: an id like "__proto__" must never reach Object.prototype.
    const found = Object.hasOwn(state.candidates, id) ? state.candidates[id] : undefined;
    if (!found) throw new RecruitingError("unknown_candidate", "That candidate is not in the pool.", 404);
    return found;
  }

  private requireRole(state: RecruitingState) {
    if (!state.role?.confirmed) {
      throw new RecruitingError("no_role", "Confirm the role's criteria first.", 409);
    }
    return state.role;
  }

  private active(state: RecruitingState): Criterion[] {
    return state.criteria.filter((criterion) => criterion.active);
  }

  // ------------------------------------------------------------------ role

  /** Turns the founder's requirement into proposed criteria awaiting confirmation. */
  async start(requirement: string): Promise<SayResult> {
    const trimmed = requirement.trim().slice(0, MAX_REQUIREMENT);
    if (trimmed.length < 10) {
      throw new RecruitingError("invalid_request", "Describe the role in a sentence or more.");
    }
    const brief = await extractBrief(this.deps.model, trimmed);
    const kept = brief.criteria;
    return this.mutate((state) => {
      const at = this.now(state).toISOString();
      Object.assign(state, emptyState(), { clockOffsetDays: state.clockOffsetDays });
      state.role = { title: brief.title, requirement: trimmed, confirmed: false, createdAt: at };
      state.criteria = kept.map((criterion) => ({
        id: randomUUID().slice(0, 8),
        text: criterion.text,
        kind: criterion.kind,
        origin: "stated",
        active: true,
        createdAt: at,
      }));
      state.rounds = [{ round: 0, query: brief.queries[0] ?? "", queries: brief.queries, at, found: 0, added: 0 }];
      return {
        intent: "start",
        message: `Proposed ${kept.length} criteria for ${brief.title}. Check them, then confirm.`,
      };
    });
  }

  /** The founder edits the proposed criteria once before confirming. */
  async reviseDraft(criteria: { id?: string; text: string; kind: CriterionKind }[]) {
    return this.mutate((state) => {
      if (!state.role || state.role.confirmed) {
        throw new RecruitingError("invalid_state", "There are no draft criteria to revise.", 409);
      }
      const at = this.now(state).toISOString();
      const known = new Set(state.criteria.map((criterion) => criterion.id));
      const used = new Set<string>();
      // The same criterion twice would count twice in every tier.
      const texts = new Set<string>();
      state.criteria = criteria
        .filter((criterion) => {
          const key = criterion.text.trim().toLowerCase();
          if (!key || texts.has(key)) return false;
          texts.add(key);
          return true;
        })
        .map((criterion) => ({
          // Ids are ours: a client may keep an existing one once, never invent one.
          id: criterion.id && known.has(criterion.id) && !used.has(criterion.id)
            ? (used.add(criterion.id), criterion.id)
            : randomUUID().slice(0, 8),
          text: criterion.text.trim(),
          kind: criterion.kind === "nice" ? "nice" : "must",
          origin: "stated",
          active: true,
          createdAt: at,
        }));
    });
  }

  async confirm(): Promise<void> {
    await this.mutate(async (state) => {
      if (!state.role || state.role.confirmed) {
        throw new RecruitingError("invalid_state", "There are no draft criteria to confirm.", 409);
      }
      if (this.active(state).length === 0) {
        throw new RecruitingError("invalid_request", "Keep at least one criterion.");
      }
      state.role.confirmed = true;
      this.record(
        state,
        "criteria_confirmed",
        `Hiring a ${state.role.title}. Requirement as stated: "${state.role.requirement}". Criteria: ${this.describeCriteria(state)}.`,
      );
      const drafted = state.rounds[0]?.queries ?? (state.rounds[0]?.query ? [state.rounds[0].query] : []);
      const queries = drafted.length
        ? drafted
        : await writeQueries(this.deps.model, state.role.title, this.active(state));
      state.rounds = [];
      await this.searchRound(state, queries);
    });
    this.settle();
  }

  private describeCriteria(state: RecruitingState): string {
    return this.active(state)
      .map((criterion) => `${criterion.text} (${criterion.kind})`)
      .join("; ");
  }

  /**
   * Runs the queries side by side and adds everyone new they return, taking
   * from each query in turn. Everyone is scored: judging uses the model, which
   * costs nothing, while the search results are already paid for.
   */
  private async searchRound(state: RecruitingState, queries: string[]): Promise<number> {
    // One query failing (a timeout) does not throw away what the others found.
    const settled = await Promise.allSettled(
      queries.map((query) => this.deps.source.search(query, this.settings.resultsPerQuery)),
    );
    const failures = settled.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
    if (failures.length === settled.length && failures.length > 0) throw failures[0];
    if (failures.length) this.fail("Searching", failures[0]);
    const results = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
    const found: CandidateProfile[] = [];
    const seen = new Set(Object.values(state.candidates).map((candidate) => personKey(candidate.profile)));
    for (let index = 0; results.some((list) => index < list.length); index += 1) {
      for (const list of results) {
        const profile = list[index];
        if (profile && !seen.has(personKey(profile))) {
          seen.add(personKey(profile));
          found.push(profile);
        }
      }
    }
    this.addToPool(state, found);
    state.rounds.push({
      round: state.rounds.length + 1,
      query: queries[0] ?? "",
      queries,
      at: this.now(state).toISOString(),
      found: found.length,
      added: found.length,
    });
    return found.length;
  }

  private addToPool(state: RecruitingState, profiles: CandidateProfile[]): void {
    const at = this.now(state).toISOString();
    const round = state.rounds.length + 1;
    for (const profile of profiles) {
      state.candidates[profile.id] = {
        profile,
        poolRound: round,
        discoveredAt: at,
        stage: "discovered",
        kept: false,
        verdicts: {},
        messages: [],
        followUps: 0,
      };
    }
  }

  /** More people under the same criteria, from queries that take new angles. */
  async findMore(): Promise<{ added: number; searched: string[] }> {
    const state = await this.current();
    const role = this.requireRole(state);
    const previous = state.rounds.flatMap((round) => round.queries ?? [round.query]).filter(Boolean);
    const searched = await writeQueries(this.deps.model, role.title, this.active(state), previous);
    const added = await this.mutate((latest) => this.searchRound(latest, searched));
    this.settle();
    return { added, searched };
  }


  /** Adds people the founder already has in mind, by public LinkedIn link. */
  async importProfiles(urls: string[]): Promise<SayResult> {
    const state = await this.current();
    this.requireRole(state);
    // Share links from the LinkedIn app carry tracking parameters; the profile is the path.
    const clean = [...new Set(urls.map((url) => url.trim().replace(/[?#].*$/, "")).filter(Boolean))];
    if (clean.length === 0 || clean.length > 10) {
      throw new RecruitingError("invalid_request", "Paste between 1 and 10 LinkedIn profile links.");
    }
    const invalid = clean.find((url) => !/^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[^/?#\s]+\/?$/i.test(url));
    if (invalid) {
      throw new RecruitingError("invalid_request", `Not a LinkedIn profile link: ${invalid}`);
    }
    if (!this.deps.source.fetchProfiles) {
      throw new RecruitingError("not_supported", "Adding people by link needs an Exa key.", 409);
    }
    const profiles = await this.deps.source.fetchProfiles(clean);
    const added = await this.mutate((latest) => {
      const at = this.now(latest).toISOString();
      const names: string[] = [];
      const known = new Set(Object.values(latest.candidates).map((candidate) => personKey(candidate.profile)));
      for (const profile of profiles) {
        if (known.has(personKey(profile))) continue;
        known.add(personKey(profile));
        latest.candidates[profile.id] = {
          profile,
          poolRound: Math.max(latest.rounds.length, 1),
          origin: "referral",
          discoveredAt: at,
          stage: "discovered",
          kept: false,
          verdicts: {},
          messages: [],
          followUps: 0,
        };
        names.push(profile.name);
      }
      return names;
    });
    this.settle();
    const missing = clean.length - profiles.length;
    return {
      intent: "import",
      message:
        (added.length ? `Added ${added.join(", ")}. Scoring now.` : "They are already in the pool.") +
        (missing > 0 ? ` ${missing} link(s) could not be read.` : ""),
    };
  }

  // --------------------------------------------------------------- scoring

  /**
   * Judges every missing (candidate, criterion) pair in the background. Any
   * change that adds or edits a criterion just drops verdicts and calls this;
   * the orbit shows provisional tiers until it converges.
   */
  settle(): Promise<void> {
    if (this.settling) {
      this.settleAgain = true;
      return this.settling;
    }
    this.settling = (async () => {
      do {
        this.settleAgain = false;
        await this.settleOnce();
      } while (this.settleAgain);
    })()
      .catch((error) => this.fail("Scoring", error))
      .finally(() => {
        this.settling = null;
      });
    return this.settling;
  }

  private async settleOnce(): Promise<void> {
    const claimed = new Set<string>();
    const failed = new Set<string>();

    const next = (state: RecruitingState) => {
      const criteria = this.active(state);
      for (const candidate of Object.values(state.candidates)) {
        const id = candidate.profile.id;
        if (!isInPool(candidate) || claimed.has(id) || failed.has(id)) continue;
        // Someone who failed every retry is left alone until the criteria change.
        if ((this.scoringFailures.get(id) ?? 0) > this.settings.rescoreAttempts) continue;
        const missing = criteria.filter((criterion) => !verdictFor(candidate, criterion.id));
        if (missing.length) return { candidate, missing: missing.map((criterion) => ({ ...criterion })) };
      }
      return null;
    };

    // A pool of workers, each taking the next unjudged candidate as soon as it
    // is free, so one slow reply does not hold up a whole batch.
    const worker = async () => {
      for (;;) {
        const job = next(await this.current());
        if (!job) return;
        const id = job.candidate.profile.id;
        claimed.add(id);
        try {
          const verdicts = await judge(this.deps.model, job.candidate.profile, job.missing);
          await this.mutate((latest) => {
            const candidate = latest.candidates[id];
            if (!candidate) return;
            for (const verdict of verdicts) {
              const judgedText = job.missing.find((criterion) => criterion.id === verdict.criterionId)?.text;
              const criterion = latest.criteria.find((entry) => entry.id === verdict.criterionId);
              // A criterion edited while this judgement ran is judged again.
              if (!criterion?.active || criterion.text !== judgedText) continue;
              candidate.verdicts[verdict.criterionId] = verdict;
            }
            if (candidate.stage === "discovered" && tierOf(candidate, this.active(latest)) !== "pending") {
              candidate.stage = "scored";
            }
          });
          this.scoringFailures.delete(id);
        } catch (error) {
          failed.add(id);
          this.scoringFailures.set(id, (this.scoringFailures.get(id) ?? 0) + 1);
          if (this.disposed) return; // the role was deleted; nothing to report
          this.fail(`Scoring ${job.candidate.profile.name}`, error);
        } finally {
          claimed.delete(id);
        }
      }
    };

    await Promise.all(Array.from({ length: this.settings.judgeConcurrency }, worker));
    // People left unscored by a failure (a rate limit, an outage) are tried again after a
    // pause, a few times, instead of waiting for the founder to happen to change something.
    // Each person gets their own retries, so one who can never be scored does not use up
    // the retries of someone who was only rate limited once.
    const retryable = [...failed].some((id) => (this.scoringFailures.get(id) ?? 0) <= this.settings.rescoreAttempts);
    if (retryable && !this.disposed && !this.rescoreTimer) {
      this.rescoreTimer = setTimeout(() => {
        this.rescoreTimer = null;
        if (!this.disposed) this.settle();
      }, this.settings.rescoreAfterMs);
      this.rescoreTimer.unref?.();
    }
  }

  /** Failed scoring attempts in a row, per person. */
  private readonly scoringFailures = new Map<string, number>();
  private rescoreTimer: ReturnType<typeof setTimeout> | null = null;

  // -------------------------------------------------------------- talking

  /** One entry point for anything the founder types or dictates. */
  async say(text: string): Promise<SayResult> {
    const said = text.trim().slice(0, MAX_REQUIREMENT);
    if (!said) throw new RecruitingError("invalid_request", "Say something first.");
    const state = await this.current();
    if (!state.role) return this.start(said);
    if (!state.role.confirmed) {
      throw new RecruitingError("invalid_state", "Confirm or revise the draft criteria first.", 409);
    }

    const candidates = Object.values(state.candidates).map((candidate) => ({
      id: candidate.profile.id,
      name: candidate.profile.name,
    }));
    const instruction = await interpret(this.deps.model, said, state.criteria, candidates);
    switch (instruction.intent) {
      case "criteria":
        return this.changeCriteria(instruction.operations, said);
      case "feedback":
        await this.feedback(instruction.candidateId, instruction.decision, instruction.reason || undefined);
        return {
          intent: "feedback",
          message: `Noted: ${instruction.decision} ${state.candidates[instruction.candidateId]?.profile.name ?? ""}.`,
        };
      case "reply":
        return this.reply(instruction.text, instruction.candidateId, "pasted");
      case "question":
        return { intent: "question", message: await this.deps.memory.ask(instruction.question) };
      default:
        return {
          intent: "unknown",
          message: "I could not tell whether that changes the criteria, judges a candidate, or relays a reply. Try rephrasing.",
        };
    }
  }

  async changeCriteria(operations: CriteriaOperation[], said: string): Promise<SayResult> {
    if (operations.length === 0) {
      return { intent: "criteria", message: "I understood a change to the criteria but not what to change." };
    }
    const allowed = operations;
    const result = await this.mutate((state) => {
      this.requireRole(state);
      const summary = this.applyOperations(state, allowed, "stated");
      if (summary.length) {
        this.record(
          state,
          "criteria_changed",
          `The founder said: "${said}". Changes: ${summary.join("; ")}. Current criteria: ${this.describeCriteria(state)}.`,
        );
      }
      return summary;
    });
    if (result.length) this.scoringFailures.clear();
    this.settle();
    if (result.length) {
      await this.retitleRole();
      this.refreshPoolInBackground();
    }
    return {
      intent: "criteria",
      message: result.length ? `Updated: ${result.join("; ")}.` : "Nothing changed.",
    };
  }

  private applyOperations(
    state: RecruitingState,
    operations: CriteriaOperation[],
    origin: Criterion["origin"],
  ): string[] {
    const at = this.now(state).toISOString();
    const summary: string[] = [];
    const edited = new Set<string>();
    for (const operation of operations) {
      if (operation.op === "add") {
        // The same criterion twice would count twice in every tier.
        const same = (text: string) => text.trim().toLowerCase() === operation.text.trim().toLowerCase();
        if (this.active(state).some((criterion) => same(criterion.text))) continue;
        const id = randomUUID().slice(0, 8);
        state.criteria.push({ id, text: operation.text, kind: operation.kind, origin, active: true, createdAt: at });
        summary.push(`added ${operation.kind} "${operation.text}"`);
        continue;
      }
      const criterion = state.criteria.find((entry) => entry.id === operation.id && entry.active);
      if (!criterion) continue;
      // A pending widening planned against this criterion as it was; that part of it no longer applies.
      for (const proposal of state.proposals) {
        if (proposal.type !== "expansion" || proposal.status !== "pending") continue;
        proposal.operations = proposal.operations.filter((planned) => planned.op === "add" || planned.id !== criterion.id);
      }
      if (operation.op === "remove") {
        criterion.active = false;
        summary.push(`dropped "${criterion.text}"`);
      } else if (operation.op === "set_kind" && criterion.kind !== operation.kind) {
        criterion.kind = operation.kind;
        if (origin === "relaxed") criterion.origin = "relaxed";
        summary.push(`"${criterion.text}" is now ${operation.kind}`);
      } else if (operation.op === "edit" && criterion.text !== operation.text) {
        edited.add(criterion.id);
        // History stays in Memory; the projection keeps only the current text.
        summary.push(`"${criterion.text}" became "${operation.text}"`);
        criterion.text = operation.text;
        if (origin === "relaxed") criterion.origin = "relaxed";
        for (const candidate of Object.values(state.candidates)) delete candidate.verdicts[criterion.id];
      }
    }
    // An edit that ends up in another active criterion's words (judged after the whole batch,
    // so a removal later in it counts) merges the two: the edited one goes.
    const byText = new Map<string, Criterion>();
    for (const criterion of this.active(state)) {
      const key = criterion.text.trim().toLowerCase();
      const other = byText.get(key);
      if (!other) {
        byText.set(key, criterion);
        continue;
      }
      const merged = edited.has(criterion.id) ? criterion : other;
      const kept = merged === criterion ? other : criterion;
      merged.active = false;
      byText.set(key, kept);
      summary.push(`"${merged.text}" merged into "${kept.text}"`);
    }
    // Judging needs something to judge by; a confirmed role always keeps one criterion.
    if (state.role?.confirmed && this.active(state).length === 0) {
      throw new RecruitingError("invalid_request", "Keep at least one criterion.");
    }
    return summary;
  }

  /** Keeps the role's name in step with its criteria; drafts use it. */
  private async retitleRole(): Promise<void> {
    const state = await this.current();
    if (!state.role) return;
    try {
      const title = await retitle(this.deps.model, state.role.title, this.active(state));
      if (title !== state.role.title) {
        await this.mutate((latest) => {
          if (latest.role) latest.role.title = title;
        });
      }
    } catch (error) {
      this.fail("Renaming the role", error);
    }
  }

  /** After criteria change, look for a few more people who fit the new picture. */
  private refreshPoolInBackground(): void {
    this.background("Refreshing the pool", async () => {
      const state = await this.current();
      if (!state.role?.confirmed) return;
      const previous = state.rounds.flatMap((round) => round.queries ?? [round.query]).filter(Boolean);
      const queries = await writeQueries(this.deps.model, state.role.title, this.active(state), previous, 2);
      await this.mutate((latest) => this.searchRound(latest, queries));
      this.settle();
    });
  }

  // -------------------------------------------------------------- feedback

  async feedback(candidateId: string, decision: "keep" | "pass", statedReason?: string): Promise<void> {
    const state = await this.current();
    this.requireRole(state);
    const candidate = this.candidate(state, candidateId);
    const inferredReason = await inferReason(
      this.deps.model,
      candidate.profile,
      decision,
      state.criteria,
      statedReason,
    );
    let reopened = false;
    await this.mutate((latest) => {
      const target = this.candidate(latest, candidateId);
      const at = this.now(latest).toISOString();
      latest.feedback.push({
        candidateId,
        decision,
        ...(statedReason ? { statedReason } : {}),
        inferredReason,
        at,
      });
      // A pass on someone already closed (hired, declined) leaves that outcome as it is.
      if (decision === "pass") {
        if (target.stage !== "closed") this.closeCandidate(latest, target, "passed");
      }
      else {
        target.kept = true;
        // Keeping someone the founder passed on is changing their mind: they come back.
        // They pick up where the conversation had got to.
        if (target.stage === "closed" && ["passed", "cold", "declined"].includes(target.closedReason ?? "")) {
          const heard = target.messages.some((message) => message.direction === "inbound");
          const wrote = target.messages.some((message) => message.direction === "outbound");
          target.stage = heard ? "replied" : wrote ? "contacted" : "scored";
          delete target.closedReason;
          delete target.closedAt;
          reopened = true;
        }
      }
      this.record(
        latest,
        "candidate_feedback",
        // No profile text here: events outlive the 30-day erasure of the person.
        `The founder chose to ${decision} a candidate. Reason: ${
          statedReason ? `"${statedReason}"` : `not stated; inferred as "${inferredReason}"`
        }.`,
      );
    });
    // Criteria added while they were closed still need a verdict.
    if (reopened) this.settle();
    this.background("Looking for a preference", () => this.proposeFromFeedback(decision));
  }

  private async proposeFromFeedback(decision: "keep" | "pass"): Promise<void> {
    const state = await this.current();
    if (state.proposals.some((proposal) => proposal.type === "criterion" && proposal.status === "pending")) {
      return;
    }
    const consumed = new Set(
      state.proposals.flatMap((proposal) =>
        proposal.type === "criterion" ? proposal.supportingCandidateIds : [],
      ),
    );
    // One decision per person (the latest), and only people still on record.
    const latest = new Map<string, (typeof state.feedback)[number]>();
    for (const entry of state.feedback) latest.set(entry.candidateId, entry);
    const open = [...latest.values()].filter(
      (entry) =>
        entry.decision === decision && !consumed.has(entry.candidateId) && state.candidates[entry.candidateId],
    );
    if (open.length < this.settings.preferenceThreshold) return;

    const finding = await findPattern(
      this.deps.model,
      decision,
      open.map((entry) => ({
        candidateId: entry.candidateId,
        // The inferred reason already restates the founder's words as a trait,
        // which is what makes two differently worded passes comparable.
        reason: entry.inferredReason,
        profile: state.candidates[entry.candidateId]!.profile,
      })),
      state.criteria,
      this.settings.preferenceThreshold,
    );
    if (!finding) return;
    // A "preference" the criteria already hold is nothing new to ask about.
    const known = (text: string) => text.trim().toLowerCase() === finding.text.trim().toLowerCase();
    if (this.active(state).some((criterion) => known(criterion.text))) return;

    await this.mutate((latest) => {
      if (latest.proposals.some((proposal) => proposal.type === "criterion" && proposal.status === "pending")) {
        return;
      }
      latest.proposals.push({
        id: randomUUID().slice(0, 8),
        type: "criterion",
        status: "pending",
        createdAt: this.now(latest).toISOString(),
        ...finding,
      });
    });
  }

  async resolveProposal(id: string, accept: boolean): Promise<void> {
    let expansion: { query: string } | null = null;
    await this.mutate(async (state) => {
      const proposal = state.proposals.find((entry) => entry.id === id);
      if (!proposal || proposal.status !== "pending") {
        throw new RecruitingError("unknown_proposal", "That proposal is no longer open.", 404);
      }
      proposal.status = accept ? "accepted" : "declined";
      if (proposal.type === "criterion") {
        if (accept) {
          this.applyOperations(state, [{ op: "add", text: proposal.text, kind: proposal.kind }], "inferred");
        }
        this.record(
          state,
          accept ? "preference_accepted" : "preference_declined",
          `The agent noticed: ${proposal.rationale} It proposed the ${proposal.kind} criterion "${proposal.text}", and the founder ${accept ? "accepted" : "declined"} it.`,
        );
        return;
      }
      // Declining a step still moves past it, so the next stall offers the next rung.
      state.expansionStep = Math.max(state.expansionStep, proposal.step + 1);
      if (accept) {
        // Operations on a criterion the founder changed since the proposal was made are dropped.
        const targets = proposal.targets;
        const still = proposal.operations.filter((operation) => {
          if (operation.op === "add" || !targets || !(operation.id in targets)) return true;
          const criterion = state.criteria.find((entry) => entry.id === operation.id && entry.active);
          return criterion !== undefined && `${criterion.text}\u0000${criterion.kind}` === targets[operation.id];
        });
        const summary = this.applyOperations(state, still, "relaxed");
        this.record(
          state,
          "pool_expanded",
          `Hiring stalled, so the founder approved "${proposal.stepName}": ${proposal.rationale} ${summary.join("; ")}. Current criteria: ${this.describeCriteria(state)}.`,
        );
        expansion = { query: proposal.query };
      } else {
        this.record(state, "expansion_declined", `The founder declined to "${proposal.stepName}".`);
      }
    });
    // New criteria give everyone whose scoring kept failing a fresh start.
    if (accept) this.scoringFailures.clear();
    this.settle();
    await this.retitleRole();
    const approved = expansion as { query: string } | null;
    if (approved) {
      this.background("Expanding the pool", async () => {
        await this.mutate((state) => this.searchRound(state, [approved.query]));
        this.settle();
      });
    }
  }

  private closeCandidate(state: RecruitingState, candidate: Candidate, reason: ClosedReason) {
    // Nothing more goes to someone who is closed.
    delete candidate.draft;
    candidate.stage = "closed";
    candidate.closedReason = reason;
    candidate.closedAt = this.now(state).toISOString();
  }

  async close(candidateId: string, reason: ClosedReason): Promise<void> {
    await this.mutate((state) => {
      const candidate = this.candidate(state, candidateId);
      this.closeCandidate(state, candidate, reason);
      if (reason === "hired") {
        this.record(state, "hired", `The founder hired someone for the ${state.role?.title ?? "role"}.`);
      }
    });
  }

  // -------------------------------------------------------------- outreach

  private privateRemarks(state: RecruitingState): string[] {
    return state.feedback.flatMap((entry) => (entry.statedReason ? [entry.statedReason] : []));
  }

  private async makeDraft(state: RecruitingState, candidate: Candidate, kind: Draft["kind"]): Promise<Draft> {
    const matched = this.active(state)
      .filter((criterion) => verdictFor(candidate, criterion.id)?.satisfied === "yes")
      .map((criterion) => criterion.text);
    const { subject, body } = await draftMessage(this.deps.model, kind, {
      role: state.role?.title ?? "the role",
      channel: candidate.contact ? "email" : "linkedin",
      // What the founder said in the chat wins over the server's defaults.
      ...((state.sender?.company ?? this.settings.companyName) ? { company: state.sender?.company ?? this.settings.companyName } : {}),
      ...(this.settings.companyPitch ? { companyPitch: this.settings.companyPitch } : {}),
      ...((state.sender?.name ?? this.settings.founderName) ? { founderName: state.sender?.name ?? this.settings.founderName } : {}),
      profile: candidate.profile,
      matched,
      messages: candidate.messages,
    });
    return {
      kind,
      subject,
      body,
      createdAt: this.now(state).toISOString(),
      warnings: privateRemarksIn(`${subject}\n${body}`, this.privateRemarks(state)).map(
        (remark) => `The draft repeats something you said privately: "${remark}". Edit it before sending.`,
      ),
    };
  }

  /** Finds an email and drafts the first message. Nothing is sent. */
  async prepareOutreach(candidateId: string): Promise<void> {
    const state = await this.current();
    this.requireRole(state);
    const candidate = this.candidate(state, candidateId);
    if (candidate.stage === "closed") {
      throw new RecruitingError("invalid_state", "This candidate is closed.", 409);
    }
    if (candidate.draft?.sending) throw beingSent();
    if (candidate.draft?.editedByFounder) throw rewritten();
    // Once they are in a conversation, the next message answers them; it is never a cold intro.
    if (candidate.draft && candidate.draft.kind !== "intro") {
      throw new RecruitingError("invalid_state", "A reply to this person is already drafted. Edit it in the outreach tab.", 409);
    }
    const kind: Draft["kind"] =
      candidate.stage === "replied" || candidate.stage === "scheduling" ? "scheduling" : candidate.stage === "contacted" ? "follow_up" : "intro";
    const contact =
      candidate.contact ??
      (await findContact(this.deps.contactFinders, candidate.profile));
    const draft = await this.makeDraft(state, contact ? { ...candidate, contact } : candidate, kind);
    await this.mutate((latest) => {
      const target = this.candidate(latest, candidateId);
      // They may have been closed while the draft was being written.
      if (target.stage === "closed") {
        throw new RecruitingError("candidate_closed", "This candidate was closed, so the draft was dropped.", 409);
      }
      if (target.draft?.sending) throw beingSent();
      if (target.draft?.editedByFounder) throw rewritten();
      if (target.draft && target.draft.kind !== "intro") {
        throw new RecruitingError("invalid_state", "A reply to this person is already drafted. Edit it in the outreach tab.", 409);
      }
      if (contact) target.contact = contact;
      target.draft = draft;
      if (target.stage === "discovered" || target.stage === "scored") target.stage = "drafted";
    });
  }

  /** Sets who outreach is from and redrafts every message still waiting to be sent. */
  async setSender(sender: { name?: string; company?: string }): Promise<number> {
    await this.mutate((state) => {
      state.sender = { ...state.sender, ...sender };
    });
    const state = await this.current();
    let redrafted = 0;
    for (const candidate of Object.values(state.candidates)) {
      const waiting = candidate.draft;
      // The founder's own words are kept; only drafts they have not touched are rewritten.
      if (!waiting || waiting.sending || waiting.editedByFounder || candidate.stage === "closed") continue;
      const draft = await this.makeDraft(state, candidate, waiting.kind);
      await this.mutate((latest) => {
        const target = latest.candidates[candidate.profile.id];
        // Only replace the draft that was there when we started, never one being sent.
        if (target?.draft && !target.draft.sending && !target.draft.editedByFounder && target.draft.createdAt === waiting.createdAt) {
          target.draft = draft;
          redrafted += 1;
        }
      });
    }
    return redrafted;
  }

  async editDraft(candidateId: string, edit: { subject?: string; body?: string; email?: string }): Promise<void> {
    await this.mutate((state) => {
      const candidate = this.candidate(state, candidateId);
      if (!candidate.draft) throw new RecruitingError("no_draft", "There is no draft to edit.", 409);
      if (this.unconfirmedClaim(candidateId, candidate.draft)) {
        const changes =
          (edit.subject !== undefined && edit.subject !== candidate.draft.subject) ||
          (edit.body !== undefined && edit.body !== candidate.draft.body) ||
          (edit.email !== undefined && edit.email !== candidate.contact?.email);
        // Saving it unchanged (the panel saves before every send) settles nothing.
        if (!changes) return;
        // Changing a draft Gmail never confirmed means the founder found it was not sent.
        delete candidate.draft.sending;
        delete candidate.draft.unconfirmed;
        delete candidate.draft.claimedAt;
      }
      if (candidate.draft.sending) {
        throw new RecruitingError("already_sending", "This message is being sent and can no longer be edited.", 409);
      }
      if (edit.subject !== undefined && edit.subject !== candidate.draft.subject) {
        candidate.draft.subject = edit.subject;
        candidate.draft.editedByFounder = true;
      }
      if (edit.body !== undefined && edit.body !== candidate.draft.body) {
        candidate.draft.body = edit.body;
        candidate.draft.editedByFounder = true;
      }
      if (edit.email !== undefined) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(edit.email)) {
          throw new RecruitingError("invalid_request", "That is not an email address.");
        }
        candidate.contact = { email: edit.email, status: "verified", provider: "founder" };
      }
      candidate.draft.warnings = privateRemarksIn(
        `${candidate.draft.subject}\n${candidate.draft.body}`,
        this.privateRemarks(state),
      ).map((remark) => `The draft repeats something you said privately: "${remark}". Edit it before sending.`);
    });
  }

  /**
   * Sends the current draft. Only ever called from the founder's press of the
   * send button. Without Gmail, `manual` records that the founder sent it
   * themselves (for example as a LinkedIn message).
   */
  async send(candidateId: string, manual: boolean): Promise<void> {
    // One send per person at a time, decided before anything is awaited.
    if (this.inFlight.has(candidateId)) {
      throw new RecruitingError("already_sending", "This message is already being sent. Check your sent mail before trying again.", 409);
    }
    this.inFlight.add(candidateId);
    try {
      await this.sendOnce(candidateId, manual);
    } finally {
      this.inFlight.delete(candidateId);
    }
  }

  private async sendOnce(candidateId: string, manual: boolean): Promise<void> {
    // 0. Gmail already sent it but recording failed: record it now, never send it twice.
    const pending = this.unrecorded.get(candidateId);
    if (pending) {
      await this.recordSent(candidateId, pending);
      this.unrecorded.delete(candidateId);
      return;
    }

    // 1. Claim the draft and save the claim. A retry after a failed save below finds it
    //    claimed and cannot send it again.
    const claimed = await this.mutate((latest) => {
      const target = this.candidate(latest, candidateId);
      if (target.stage === "closed") {
        throw new RecruitingError("candidate_closed", "This candidate is closed, so nothing more is sent.", 409);
      }
      const draft = target.draft;
      if (!draft) throw new RecruitingError("no_draft", "There is no draft to send.", 409);
      // Claimed, yet nothing of ours is sending it: an earlier try never learned whether Gmail
      // sent it (or the server stopped mid-send). Only the founder, having checked Sent, can say.
      if (draft.sending) {
        if (!manual) throw new RecruitingError("send_unconfirmed", UNCONFIRMED, 409);
        return { draft: { ...draft }, contact: target.contact, threadId: target.gmailThreadId, confirmed: true, sender: null };
      }
      if (draft.warnings.length) {
        throw new RecruitingError("draft_has_warnings", draft.warnings[0]!, 409);
      }
      if (!manual && !target.contact) {
        throw new RecruitingError("no_email", "There is no email address for this person.", 409);
      }
      // A draft written as a LinkedIn message has no subject; an email needs one.
      if (!manual && !draft.subject.trim()) {
        throw new RecruitingError("no_subject", "Add a subject line before sending this as an email.", 409);
      }
      draft.sending = true;
      draft.claimedAt = this.realNow();
      return {
        draft: { ...draft },
        contact: target.contact,
        threadId: target.gmailThreadId,
        confirmed: false,
        sender: JSON.stringify(latest.sender ?? null),
      };
    });
    if (claimed.confirmed) {
      // Stamped with the time it was claimed, so replies since then are still read.
      await this.recordSent(candidateId, {
        draft: claimed.draft,
        threadId: claimed.threadId,
        channel: "email",
        ...(claimed.draft.claimedAt ? { realAt: claimed.draft.claimedAt } : {}),
      });
      return;
    }

    // 2. The one irreversible step, outside any change that could be rolled back.
    let threadId = claimed.threadId;
    if (!manual) {
      try {
        if (!this.deps.gmail || !(await this.deps.gmail.connected())) {
          throw new RecruitingError("gmail_not_connected", "Connect Gmail first, or mark it as sent by hand.", 409);
        }
        const sent = await this.deps.gmail.send({
          to: claimed.contact!.email,
          subject: claimed.draft.subject,
          body: claimed.draft.body,
          ...(threadId ? { threadId } : {}),
        });
        threadId = sent.threadId;
      } catch (error) {
        if (!certainlyNotSent(error)) {
          // The request may have reached Gmail. The claim stays, so a retry cannot send it twice.
          // The flag only tells the panel; a claim with nothing sending counts as unconfirmed anyway.
          await this.mutate((latest) => {
            const target = latest.candidates[candidateId];
            if (target?.draft?.sending) target.draft.unconfirmed = true;
          }).catch(() => undefined);
          throw new RecruitingError("send_unconfirmed", UNCONFIRMED, 502);
        }
        // Nothing went out: release the claim so the founder can try again.
        await this.mutate((latest) => {
          const target = latest.candidates[candidateId];
          if (target?.draft) {
            delete target.draft.sending;
            delete target.draft.claimedAt;
          }
        });
        await this.redraftIfSenderChanged(candidateId, claimed.draft, claimed.sender);
        throw error;
      }
    }

    // 3. Record it. If that fails, the send is remembered so the next press only records it.
    const sent: SentMessage = { draft: claimed.draft, threadId, channel: manual ? "linkedin" : "email", realAt: this.realNow() };
    this.unrecorded.set(candidateId, sent);
    await this.recordSent(candidateId, sent);
    this.unrecorded.delete(candidateId);
  }

  /** People whose send is running right now. */
  private readonly inFlight = new Set<string>();
  /** Sends that went out but are not yet saved, by candidate. */
  private readonly unrecorded = new Map<string, SentMessage>();

  /** A claimed draft that nothing is sending and nothing waits to record: its fate is unknown. */
  private unconfirmedClaim(candidateId: string, draft: Draft | undefined): boolean {
    return Boolean(draft?.sending) && !this.inFlight.has(candidateId) && !this.unrecorded.has(candidateId);
  }

  private async recordSent(candidateId: string, sent: SentMessage): Promise<void> {
    const { draft, threadId } = sent;
    await this.mutate((latest) => {
      const target = this.candidate(latest, candidateId);
      const at = this.now(latest).toISOString();
      target.messages.push({
        direction: "outbound",
        channel: sent.channel,
        at,
        realAt: sent.realAt ?? this.realNow(),
        text: `${draft.subject}\n\n${draft.body}`,
      });
      if (threadId) target.gmailThreadId = threadId;
      target.lastContactedAt = at;
      if (draft.kind === "follow_up") target.followUps += 1;
      // Closed while the email was going out (hired, or asked not to be contacted) stays closed.
      if (target.stage === "closed") {
        // nothing: the message is kept on record, the decision stands
      } else if (draft.kind === "scheduling") target.stage = "scheduling";
      else if (target.stage !== "replied" && target.stage !== "scheduling") target.stage = "contacted";
      delete target.draft;
    });
  }

  /** A draft released after a failed send is rewritten if the signature changed meanwhile. */
  private async redraftIfSenderChanged(candidateId: string, sentDraft: Draft, senderAtClaim: string | null): Promise<void> {
    try {
      const state = await this.current();
      const candidate = state.candidates[candidateId];
      if (!candidate?.draft || senderAtClaim === null || JSON.stringify(state.sender ?? null) === senderAtClaim) return;
      if (candidate.draft.editedByFounder || candidate.stage === "closed") return;
      const draft = await this.makeDraft(state, candidate, candidate.draft.kind);
      await this.mutate((latest) => {
        const target = latest.candidates[candidateId];
        if (target?.draft && !target.draft.sending && !target.draft.editedByFounder && target.draft.createdAt === sentDraft.createdAt) {
          target.draft = draft;
        }
      });
    } catch (error) {
      this.fail("Updating the signature", error);
    }
  }

  /** A reply relayed by paste, dictation, Gmail, or the LinkedIn reader. */
  async reply(
    text: string,
    candidateId: string | null,
    channel: Message["channel"],
    at?: string,
  ): Promise<SayResult> {
    text = typeof text === "string" ? text.trim().slice(0, MAX_REQUIREMENT) : "";
    if (!text) throw new RecruitingError("invalid_request", "The reply is empty.");
    const state = await this.current();
    // An unattributed message can only be from someone the founder wrote to;
    // matching it against the whole pool would pin strangers' messages on people.
    const contacted = Object.values(state.candidates)
      .filter((candidate) =>
        candidateId
          ? candidate.profile.id === candidateId
          : candidate.messages.some((message) => message.direction === "outbound"),
      )
      .map((candidate) => ({ id: candidate.profile.id, name: candidate.profile.name }));
    if (contacted.length === 0) {
      return { intent: "reply", message: "Nobody has been contacted yet, so this cannot be a reply." };
    }
    const reading = await readReply(this.deps.model, text, contacted, candidateId);
    if (!reading.candidateId) {
      return { intent: "reply", message: "I could not tell which candidate this reply is from." };
    }
    const id = reading.candidateId;
    // 1. The reply itself is saved first; nothing after this can lose it.
    const closedAs = await this.mutate((latest) => {
      const candidate = this.candidate(latest, id);
      // The same message relayed again (a LinkedIn preview whose time label changed, a sync
      // run twice) is already on record.
      const same = (message: Message) =>
        message.direction === "inbound" &&
        (channel === "email" ? message.text === text && message.realAt === at : sameRelayedText(message.text, text));
      if (candidate.messages.some(same)) return "duplicate";
      candidate.messages.push({
        direction: "inbound",
        channel,
        at: at ?? this.now(latest).toISOString(),
        realAt: at ?? this.realNow(),
        text,
      });
      // They answered, so "just checking in", or a cold first message, no longer fits.
      if ((candidate.draft?.kind === "follow_up" || candidate.draft?.kind === "intro") && !candidate.draft.sending) {
        delete candidate.draft;
      }
      // A closed person stays closed (hired stays hired); the message is kept on record. Only a
      // closure the system made on silence or a misread ("cold", "declined") gives way to a yes.
      if (candidate.stage === "closed") {
        const reopenable = candidate.closedReason === "cold" || candidate.closedReason === "declined";
        if (!(reopenable && reading.interested === true)) return candidate.closedReason ?? "closed";
        delete candidate.closedReason;
        delete candidate.closedAt;
      }
      if (reading.interested === false) {
        this.closeCandidate(latest, candidate, "declined");
        return null;
      }
      candidate.stage = "replied";
      return null;
    });
    const name = state.candidates[id]?.profile.name ?? "The candidate";
    if (closedAs === "duplicate") return { intent: "reply", recorded: true, message: `${name}: that message is already on record.` };
    if (closedAs) return { intent: "reply", recorded: true, message: `${name} is closed (${closedAs}). Their message is saved.` };
    if (reading.interested === false) return { intent: "reply", recorded: true, message: `${name} declined. Closed.` };

    // 2. A scheduling answer, if they want to talk. Failing here keeps the reply.
    let drafted = false;
    if (reading.interested || reading.wantsToSchedule) {
      try {
        const latest = await this.current();
        const candidate = latest.candidates[id];
        if (candidate) {
          const draft = await this.makeDraft(latest, candidate, "scheduling");
          await this.mutate((next) => {
            const target = next.candidates[id];
            if (target?.stage === "replied" && !target.draft) {
              target.draft = draft;
              drafted = true;
            }
          });
        }
      } catch (error) {
        this.fail(`Drafting a reply to ${name}`, error);
      }
    }
    return {
      intent: "reply",
      recorded: true,
      message: `${name}: ${reading.summary}${drafted ? " A scheduling reply is drafted." : ""}`,
    };
  }

  /**
   * Keeps only conversations that name someone the founder has written to.
   * A LinkedIn inbox holds private conversations that have nothing to do with
   * hiring; those never reach the model.
   */
  async relevantConversations(texts: string[]): Promise<string[]> {
    const state = await this.current();
    const names = Object.values(state.candidates)
      .filter((candidate) => candidate.messages.some((message) => message.direction === "outbound"))
      .map((candidate) => candidate.profile.name.toLowerCase());
    // Whole words only: "An" must not match "can".
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = names.flatMap((name) => {
      const first = name.split(/\s+/)[0]!;
      return [name, first].filter(Boolean).map((part) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(part)}(?=$|[^\\p{L}\\p{N}])`, "u"));
    });
    return texts.filter((text) => {
      const lower = text.toLowerCase();
      return patterns.some((pattern) => pattern.test(lower));
    });
  }

  /** Reads new replies in every Gmail thread the founder started from here. */
  syncGmail(): Promise<number> {
    // One sync at a time: two at once would read the same reply twice.
    this.syncing ??= this.syncGmailOnce().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private syncing: Promise<number> | null = null;

  private async syncGmailOnce(): Promise<number> {
    if (!this.deps.gmail || !(await this.deps.gmail.connected())) return 0;
    const state = await this.current();
    let count = 0;
    for (const candidate of Object.values(state.candidates)) {
      if (!candidate.gmailThreadId || candidate.stage === "closed") continue;
      // Gmail keeps real time, so the cut-off must too (fast-forward moves only the simulated clock).
      // The latest time on record, not the last message's: a send recorded late is dated earlier
      // than a reply already read, and must not move the cut-off back to before that reply.
      // Replies after the latest one already read; before any, everything since the first email.
      // The founder's own later sends do not move it, or a reply not yet read would be skipped.
      const latest = (messages: Message[]) =>
        messages
          .map((message) => message.realAt ?? message.at)
          .filter(Boolean)
          .reduce<string | undefined>((a, b) => (!a || Date.parse(b) > Date.parse(a) ? b : a), undefined);
      const earliest = (messages: Message[]) =>
        messages
          .map((message) => message.realAt ?? message.at)
          .filter(Boolean)
          .reduce<string | undefined>((a, b) => (!a || Date.parse(b) < Date.parse(a) ? b : a), undefined);
      const read = candidate.messages.filter((message) => message.direction === "inbound" && message.channel === "email");
      const emailed = candidate.messages.filter((message) => message.direction === "outbound" && message.channel === "email");
      const lastSeen = latest(read) ?? earliest(emailed) ?? candidate.discoveredAt;
      // One thread that fails is reported; the others are still read.
      try {
        const replies = await this.deps.gmail.repliesIn(candidate.gmailThreadId, lastSeen);
        for (const message of replies) {
          await this.reply(message.text, candidate.profile.id, "email", message.at);
          count += 1;
        }
      } catch (error) {
        this.fail(`Reading Gmail replies from ${candidate.profile.name}`, error);
      }
    }
    return count;
  }

  // ------------------------------------------------------------------ time

  /**
   * Moves the simulated clock. With `inBackground`, the drafting and stall
   * checks that follow run after the call returns, so the screen updates at
   * once and proposals arrive as they are ready.
   */
  async fastForward(days: number, inBackground = false): Promise<void> {
    if (!Number.isInteger(days) || days < 1 || days > 30) {
      throw new RecruitingError("invalid_request", "Fast-forward by 1 to 30 days.");
    }
    await this.mutate((state) => {
      state.clockOffsetDays += days;
    });
    if (inBackground) this.background("Checking in after the time skip", () => this.tick());
    else await this.tick();
  }

  /** Follow-ups, cold marking, stall detection, and retention. */
  async tick(): Promise<void> {
    const state = await this.current();
    const now = this.now(state).getTime();
    const daysSince = (iso: string) => (now - Date.parse(iso)) / DAY_MS;

    for (const candidate of Object.values(state.candidates)) {
      if (candidate.stage !== "contacted" || !candidate.lastContactedAt || candidate.draft) continue;
      const waited = daysSince(candidate.lastContactedAt);
      if (candidate.followUps === 0 && waited >= this.settings.followUpAfterDays) {
        try {
          const draft = await this.makeDraft(state, candidate, "follow_up");
          await this.mutate((latest) => {
            const target = latest.candidates[candidate.profile.id];
            // Only for someone still waiting on us: not replied, not closed since the tick began.
            if (target && !target.draft && target.stage === "contacted") target.draft = draft;
          });
        } catch (error) {
          this.fail(`Drafting a follow-up to ${candidate.profile.name}`, error);
        }
      } else if (candidate.followUps > 0 && waited >= this.settings.coldAfterDays) {
        await this.mutate((latest) => {
          const target = latest.candidates[candidate.profile.id];
          if (target?.stage === "contacted") this.closeCandidate(latest, target, "cold");
        });
      }
    }

    await this.mutate((latest) => {
      const cutoff = now - this.settings.retentionDays * DAY_MS;
      for (const [id, candidate] of Object.entries(latest.candidates)) {
        if (candidate.stage === "closed" && candidate.closedAt && Date.parse(candidate.closedAt) < cutoff) {
          delete latest.candidates[id];
        }
      }
    });

    await this.maybeProposeExpansion();
  }

  private async maybeProposeExpansion(): Promise<void> {
    const state = await this.current();
    if (!state.role?.confirmed) return;
    if (state.expansionStep >= EXPANSION_LADDER.length) return;
    if (state.proposals.some((proposal) => proposal.type === "expansion" && proposal.status === "pending")) return;
    const lastRound = state.rounds.at(-1);
    if (!lastRound) return;
    const now = this.now(state).getTime();
    if ((now - Date.parse(lastRound.at)) / DAY_MS < this.settings.expandAfterDays) return;
    const criteria = this.active(state);
    const engaged = Object.values(state.candidates).some((candidate) => {
      const tier = tierOf(candidate, criteria);
      return (tier === 100 || tier === 75) && (candidate.stage === "replied" || candidate.stage === "scheduling");
    });
    if (engaged) return;

    const step = state.expansionStep;
    const plan = await planExpansion(this.deps.model, step, state.role.title, state.criteria, lastRound.query);
    await this.mutate((latest) => {
      // Another tick may have proposed while the model was planning.
      if (latest.expansionStep !== step) return;
      if (latest.proposals.some((proposal) => proposal.type === "expansion" && proposal.status === "pending")) return;
      latest.proposals.push({
        id: randomUUID().slice(0, 8),
        type: "expansion",
        status: "pending",
        createdAt: this.now(latest).toISOString(),
        step,
        stepName: EXPANSION_LADDER[step]!.name,
        rationale: plan.rationale,
        query: plan.query,
        operations: plan.operations,
        // What each targeted criterion said, so a later change by the founder is not overwritten.
        targets: Object.fromEntries(
          plan.operations.flatMap((operation) => {
            if (operation.op === "add") return [];
            const criterion = latest.criteria.find((entry) => entry.id === operation.id);
            return criterion ? [[operation.id, `${criterion.text}\u0000${criterion.kind}`]] : [];
          }),
        ),
      });
    });
  }

  // ------------------------------------------------------------------ misc

  async ask(question: string): Promise<string> {
    return this.deps.memory.ask(question);
  }

  async reset(): Promise<void> {
    await this.mutate((state) => {
      Object.assign(state, emptyState());
    });
  }

  async snapshot() {
    const state = await this.current();
    const criteria = this.active(state);
    const judged = (candidate: Candidate) =>
      criteria.filter((criterion) => verdictFor(candidate, criterion.id));
    const candidates = Object.values(state.candidates).map((candidate) => {
      const tier = tierOf(candidate, criteria);
      // While new verdicts are pending, show the tier from the ones we have.
      const provisional: Tier = tier === "pending" ? tierOf(candidate, judged(candidate)) : tier;
      return {
        id: candidate.profile.id,
        profile: candidate.profile,
        tier: provisional,
        settled: tier !== "pending",
        stage: candidate.stage,
        closedReason: candidate.closedReason ?? null,
        kept: candidate.kept,
        poolRound: candidate.poolRound,
        origin: candidate.origin ?? "search",
        verdicts: criteria.map((criterion) => verdictFor(candidate, criterion.id) ?? null),
        contact: candidate.contact ?? null,
        draft: candidate.draft ?? null,
        messages: candidate.messages,
        followUps: candidate.followUps,
        lastContactedAt: candidate.lastContactedAt ?? null,
      };
    });
    return {
      role: state.role,
      criteria: state.criteria.filter((criterion) => criterion.active),
      retiredCriteria: state.criteria.filter((criterion) => !criterion.active),
      candidates,
      proposals: state.proposals.filter((proposal: Proposal) => proposal.status === "pending"),
      rounds: state.rounds,
      events: state.events.slice(-30),
      now: this.now(state).toISOString(),
      clockOffsetDays: state.clockOffsetDays,
      busy: this.settling !== null || this.backgroundWork > 0,
      memoryPending: this.deps.memory.pending(),
      lastError: this.lastError,
      integrations: {
        source: this.deps.source.name,
        contactFinders: this.deps.contactFinders.map((finder) => finder.provider),
        gmail: this.deps.gmail ? await this.deps.gmail.connected() : null,
      },
    };
  }

  /**
   * Stops this role for good: later changes are refused and nothing is saved
   * again, so background work cannot write a deleted role back. Resolves once
   * the change in progress, if any, has finished.
   */
  dispose(): Promise<void> {
    this.disposed = true;
    if (this.rescoreTimer) clearTimeout(this.rescoreTimer);
    return this.chain.then(() => undefined);
  }

  clearError(): void {
    this.lastError = null;
  }
}
