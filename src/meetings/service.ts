import { randomUUID } from "node:crypto";
import type { CompanyKnowledge } from "../company-domain.js";
import { detectProhibitedData } from "../prohibited-data.js";
import type { JsonModel } from "../recruiting/llm.js";
import { checkConflicts, type DraftResult } from "./drafter.js";
import type { ConflictChecker } from "./jev.js";
import {
  hashPayload,
  MeetingError,
  type ActionExecutor,
  type ActionKind,
  type ActionPayload,
  type ActionResult,
  type ActionStatus,
  type AnswerPayload,
  type CandidateAction,
  type CommitmentExtractor,
  type ConflictPayload,
  type Decision,
  type MeetingActions,
  type MeetingEvent,
  type MeetingState,
  type MeetingStore,
  type MeetingSummary,
  type ProposedAction,
  type Tier,
  type TraceEvent,
  type TraceStep,
  type TranscriptSegment,
} from "./domain.js";
import { screenSegment } from "./guard.js";
import { mustEscalate, tierFor } from "./policy.js";

/** What MeetingService needs from a drafter. `ActionDrafter` satisfies it;
 * tests can supply a fake with the same shape. */
export interface DrafterLike {
  draft(candidate: CandidateAction, meeting: MeetingState): Promise<DraftResult>;
}

export interface MeetingServiceDependencies {
  store: MeetingStore;
  extractor: CommitmentExtractor;
  drafter: DrafterLike;
  executor: ActionExecutor;
  knowledge: CompanyKnowledge;
  model: JsonModel;
  clock?: () => Date;
  id?: () => string;
  onError?: (context: string, error: unknown) => void;
  /** Checks a new decision against earlier ones; defaults to the meeting model (checkConflicts). */
  conflictChecker?: ConflictChecker;
}

/** Statuses a repeated mention of the same commitment should never touch
 * again. "executed" is deliberately not here: it is still found by the
 * dedupe lookup, then handled specially (skipped rather than updated). */
const TERMINAL_STATUSES: ReadonlySet<ActionStatus> = new Set(["rejected", "blocked", "superseded"]);

interface Runtime {
  /** Serialises every state change for one meeting, mutate() to mutate(). */
  chain: Promise<unknown>;
  listeners: Set<(event: MeetingEvent) => void>;
  busy: boolean;
  /** Batches of ok segments waiting for the extractor, so a burst of
   * append() calls never runs the extractor twice at once for one meeting. */
  queue: TranscriptSegment[][];
  idleWaiters: Array<() => void>;
}

/**
 * Implements the meeting-actions surface: listens to transcript segments,
 * recognises commitments and questions, drafts each into a ProposedAction,
 * and serialises every change to one meeting through `mutate`, the same
 * one-at-a-time pattern RecruitingService uses. Background work (extraction,
 * drafting, conflict checks) never blocks `append`'s return; `idle()` is how
 * tests and replays wait for it to settle.
 */
export class MeetingService implements MeetingActions {
  private readonly cache = new Map<string, MeetingState>();
  private readonly runtimes = new Map<string, Runtime>();

  constructor(private readonly deps: MeetingServiceDependencies) {}

  // ---------------------------------------------------------------- plumbing

  private now(): Date {
    return (this.deps.clock ?? (() => new Date()))();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private newId(): string {
    return this.deps.id?.() ?? randomUUID();
  }

  private async current(meetingId: string): Promise<MeetingState> {
    const cached = this.cache.get(meetingId);
    if (cached) return cached;
    const loaded = await this.deps.store.load(meetingId);
    if (!loaded) throw new MeetingError("not_found", "No such meeting.", 404);
    this.cache.set(meetingId, loaded);
    return loaded;
  }

  /** Runs one change against one meeting's state at a time, then saves it. */
  private mutate<T>(meetingId: string, change: (state: MeetingState) => T | Promise<T>): Promise<T> {
    const runtime = this.runtimeFor(meetingId);
    const run = runtime.chain.then(async () => {
      const state = await this.current(meetingId);
      const result = await change(state);
      await this.deps.store.save(state);
      return result;
    });
    runtime.chain = run.catch(() => undefined);
    return run;
  }

  private runtimeFor(meetingId: string): Runtime {
    let runtime = this.runtimes.get(meetingId);
    if (!runtime) {
      runtime = { chain: Promise.resolve(), listeners: new Set(), busy: false, queue: [], idleWaiters: [] };
      this.runtimes.set(meetingId, runtime);
    }
    return runtime;
  }

  private emitEvent(meetingId: string, event: MeetingEvent): void {
    for (const listener of this.runtimeFor(meetingId).listeners) listener(event);
  }

  /** State and actions are mutated in place internally (status, payload, and
   * so on keep changing on the same object as a meeting progresses). Every
   * value handed to a caller or a listener is a defensive copy, so nothing
   * outside this class can be surprised by a reference changing underneath
   * it later. */
  private cloneState(state: MeetingState): MeetingState {
    return structuredClone(state);
  }

  private cloneAction(action: ProposedAction): ProposedAction {
    return structuredClone(action);
  }

  private fail(meetingId: string, context: string, error: unknown): void {
    this.deps.onError?.(`${context} (meeting ${meetingId})`, error);
  }

  private pushTrace(
    state: MeetingState,
    step: TraceStep,
    actionId: string | undefined,
    segmentIndex: number | undefined,
    detail: string,
  ): TraceEvent {
    const event: TraceEvent = {
      at: this.nowIso(),
      step,
      detail,
      ...(actionId !== undefined ? { actionId } : {}),
      ...(segmentIndex !== undefined ? { segmentIndex } : {}),
    };
    state.trace.push(event);
    return event;
  }

  /** Records one trace line outside of any bigger state change, and emits it. */
  private async traceOnly(
    meetingId: string,
    step: TraceStep,
    actionId: string | undefined,
    segmentIndex: number | undefined,
    detail: string,
  ): Promise<void> {
    const trace = await this.mutate(meetingId, (state) => this.pushTrace(state, step, actionId, segmentIndex, detail));
    this.emitEvent(meetingId, { type: "trace", meetingId, trace });
  }

  // -------------------------------------------------------------- lifecycle

  async start(input: { title: string; employeeId: string; sourceId?: string }): Promise<MeetingState> {
    const state: MeetingState = {
      meetingId: this.newId(),
      title: input.title,
      employeeId: input.employeeId,
      status: "live",
      startedAt: this.nowIso(),
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      segments: [],
      decisions: [],
      actions: [],
      trace: [],
    };
    this.cache.set(state.meetingId, state);
    await this.deps.store.save(state);
    return this.cloneState(state);
  }

  async get(meetingId: string): Promise<MeetingState | null> {
    const cached = this.cache.get(meetingId);
    if (cached) return this.cloneState(cached);
    const loaded = await this.deps.store.load(meetingId);
    if (loaded) this.cache.set(meetingId, loaded);
    return loaded ? this.cloneState(loaded) : null;
  }

  async list(): Promise<MeetingSummary[]> {
    return this.deps.store.list();
  }

  async end(meetingId: string): Promise<MeetingState> {
    const state = await this.mutate(meetingId, (state) => {
      state.status = "ended";
      state.endedAt = this.nowIso();
      return state;
    });
    this.emitEvent(meetingId, { type: "meeting", meetingId, status: "ended" });
    return this.cloneState(state);
  }

  // ---------------------------------------------------------------- segments

  async append(
    meetingId: string,
    segments: Array<{ speaker: string; text: string; at?: string }>,
  ): Promise<TranscriptSegment[]> {
    if (segments.length === 0) return [];

    const { added, okSegments, actionEvents, traceEvents } = await this.mutate(meetingId, (state) => {
      const added: TranscriptSegment[] = [];
      const okSegments: TranscriptSegment[] = [];
      const actionEvents: MeetingEvent[] = [];
      const traceEvents: TraceEvent[] = [];

      for (const raw of segments) {
        const index = state.segments.length;
        const screen = screenSegment(raw.text);
        // Prohibited Data is redacted in storage so the value is never kept
        // anywhere, even for a blocked segment. An injection attempt is kept
        // verbatim: it holds no secret, and the trace needs to show exactly
        // what was said and blocked.
        const isProhibited = screen.verdict === "blocked" && detectProhibitedData(raw.text) !== null;
        const storedText = isProhibited ? `[withheld: ${screen.reason}]` : raw.text;
        const segment: TranscriptSegment = {
          index,
          speaker: raw.speaker,
          text: storedText,
          ...(raw.at ? { at: raw.at } : {}),
        };
        state.segments.push(segment);
        added.push(segment);
        traceEvents.push(
          this.pushTrace(
            state,
            "segment_screened",
            undefined,
            index,
            screen.verdict === "ok" ? "Passed screening." : `Blocked: ${screen.reason}`,
          ),
        );
        if (screen.verdict === "blocked") {
          const action = this.buildBlockedAction(meetingId, segment, screen.reason);
          state.actions.push(action);
          traceEvents.push(this.pushTrace(state, "blocked", action.id, index, screen.reason));
          actionEvents.push({ type: "action", meetingId, action: this.cloneAction(action) });
        } else {
          okSegments.push(segment);
        }
      }
      return { added, okSegments, actionEvents, traceEvents };
    });

    this.emitEvent(meetingId, { type: "segments", meetingId, segments: added });
    for (const trace of traceEvents) this.emitEvent(meetingId, { type: "trace", meetingId, trace });
    for (const event of actionEvents) this.emitEvent(meetingId, event);

    if (okSegments.length > 0) this.enqueue(meetingId, okSegments);
    return added;
  }

  private buildBlockedAction(meetingId: string, segment: TranscriptSegment, reason: string): ProposedAction {
    const payload = { reason };
    const createdAt = this.nowIso();
    return {
      id: this.newId(),
      meetingId,
      kind: "blocked",
      tier: "blocked",
      status: "blocked",
      title: "Blocked transcript segment",
      trigger: { segmentIndex: segment.index, speaker: segment.speaker, quote: segment.text.slice(0, 200) },
      payload,
      payloadHash: hashPayload(payload),
      version: 1,
      evidence: [],
      dedupeKey: `blocked:${meetingId}:${segment.index}`,
      createdAt,
      decidedAt: createdAt,
    };
  }

  // ------------------------------------------------------------ background

  private enqueue(meetingId: string, segments: TranscriptSegment[]): void {
    const runtime = this.runtimeFor(meetingId);
    runtime.queue.push(segments);
    if (!runtime.busy) this.drainQueue(meetingId);
  }

  private drainQueue(meetingId: string): void {
    const runtime = this.runtimeFor(meetingId);
    // Everything heard while the last batch was being handled goes to the
    // model as one batch: one call per segment fell minutes behind a live meeting.
    const pending = runtime.queue.splice(0);
    const next = pending.length > 0 ? pending.flat() : undefined;
    if (!next) {
      if (runtime.busy) {
        runtime.busy = false;
        this.emitEvent(meetingId, { type: "busy", meetingId, busy: false });
      }
      const waiters = runtime.idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
      return;
    }
    if (!runtime.busy) {
      runtime.busy = true;
      this.emitEvent(meetingId, { type: "busy", meetingId, busy: true });
    }
    void this.processBatch(meetingId, next)
      .catch((error) => this.fail(meetingId, "Processing meeting segments", error))
      .finally(() => this.drainQueue(meetingId));
  }

  async idle(meetingId: string): Promise<void> {
    const runtime = this.runtimeFor(meetingId);
    if (!runtime.busy && runtime.queue.length === 0) return;
    await new Promise<void>((resolve) => runtime.idleWaiters.push(resolve));
  }

  private async processBatch(meetingId: string, segments: TranscriptSegment[]): Promise<void> {
    const meeting = await this.current(meetingId);
    const result = await this.deps.extractor.extract({ meeting, newSegments: segments });
    await this.traceOnly(
      meetingId,
      "extracted",
      undefined,
      undefined,
      `Found ${result.candidates.length} candidate action(s) and ${result.decisions.length} decision(s).`,
    );

    // A decision that gives away money ("we'll offer a 20% discount") is also
    // a commitment beyond the employee's authority. The model sometimes files
    // it only as a decision, so policy turns it into an escalation here too.
    const cited = new Set(result.candidates.map((candidate) => candidate.trigger.segmentIndex));
    const candidates = [...result.candidates];
    for (const decision of result.decisions) {
      if (cited.has(decision.segmentIndex)) continue;
      const segment = segments.find((entry) => entry.index === decision.segmentIndex);
      if (!segment || !mustEscalate({ summary: decision.text, details: {} })) continue;
      candidates.push({
        kind: "escalation",
        trigger: { segmentIndex: decision.segmentIndex, speaker: segment.speaker, quote: segment.text },
        summary: decision.text,
        dedupeKey: `escalation:decision-${decision.segmentIndex}`,
        details: {},
      });
    }

    for (const candidate of candidates) {
      try {
        await this.processCandidate(meetingId, candidate);
      } catch (error) {
        this.fail(meetingId, `Handling a ${candidate.kind} candidate`, error);
        await this.traceOnly(
          meetingId,
          "failed",
          undefined,
          candidate.trigger.segmentIndex,
          `Could not prepare ${candidate.kind}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
        ).catch(() => undefined);
      }
    }
    for (const decision of result.decisions) {
      try {
        await this.processDecision(meetingId, decision);
      } catch (error) {
        this.fail(meetingId, "Checking a decision for conflicts", error);
      }
    }
  }

  private autoResult(kind: ActionKind, payload: ActionPayload): ActionResult {
    if (kind === "answer_question") {
      // The answer itself is on the card; the result only says what backs it.
      const answer = payload as AnswerPayload;
      const cited = answer.citedSourceIds.length;
      return {
        summary: answer.answer.startsWith("Insufficient Evidence")
          ? "Not enough evidence to answer; closest records attached."
          : `Answered with ${cited} cited source${cited === 1 ? "" : "s"}.`,
        simulated: false,
      };
    }
    if (kind === "flag_conflict") {
      return {
        summary: `Conflicts with an earlier decision: ${(payload as ConflictPayload).explanation}`.slice(0, 240),
        simulated: false,
      };
    }
    return { summary: "Handled automatically.", simulated: false };
  }

  private buildAction(meetingId: string, candidate: CandidateAction, draft: DraftResult, tier: Tier): ProposedAction {
    const createdAt = this.nowIso();
    const status: ActionStatus = tier === "escalate" ? "escalated" : tier === "auto" ? "executed" : "proposed";
    return {
      id: this.newId(),
      meetingId,
      kind: candidate.kind,
      tier,
      status,
      title: draft.title,
      trigger: candidate.trigger,
      payload: draft.payload,
      payloadHash: hashPayload(draft.payload),
      version: 1,
      evidence: draft.evidence,
      ...(draft.missing && draft.missing.length > 0 ? { missing: draft.missing } : {}),
      ...(draft.notes && draft.notes.length > 0 ? { notes: draft.notes } : {}),
      dedupeKey: candidate.dedupeKey,
      createdAt,
      ...(status === "executed" ? { decidedAt: createdAt, result: this.autoResult(candidate.kind, draft.payload) } : {}),
    };
  }

  private async processCandidate(meetingId: string, raw: CandidateAction): Promise<void> {
    const escalateReason = mustEscalate({ summary: `${raw.summary} ${raw.trigger.quote}`, details: raw.details });
    // Escalation is policy's call, not the model's: without money or contract
    // language there is nobody above the employee to route it to, so it is
    // dropped rather than parked in a queue no one owns.
    if (raw.kind === "escalation" && !escalateReason) {
      await this.traceOnly(
        meetingId,
        "tiered",
        undefined,
        raw.trigger.segmentIndex,
        `Not escalated: "${raw.summary}" names no money or contract commitment.`.slice(0, 300),
      );
      return;
    }
    const candidate: CandidateAction = escalateReason
      ? { ...raw, kind: "escalation", details: { ...raw.details, escalationReason: escalateReason } }
      : raw;

    const meeting = await this.current(meetingId);
    const existing = meeting.actions.find(
      (action) => action.dedupeKey === candidate.dedupeKey && !TERMINAL_STATUSES.has(action.status),
    );
    if (existing?.status === "executed") {
      await this.traceOnly(
        meetingId,
        "deduplicated",
        existing.id,
        candidate.trigger.segmentIndex,
        "Already executed; repeated mention ignored.",
      );
      return;
    }

    const draft = await this.deps.drafter.draft(candidate, meeting);
    const tier = tierFor(candidate.kind, candidate.details);
    if (draft.evidence.length > 0) {
      await this.traceOnly(
        meetingId,
        "evidence_retrieved",
        existing?.id,
        candidate.trigger.segmentIndex,
        `Retrieved ${draft.evidence.length} evidence item(s).`,
      );
    }
    for (const lookup of draft.lookups ?? []) {
      await this.traceOnly(meetingId, "looked_up", existing?.id, candidate.trigger.segmentIndex, lookup.slice(0, 300));
    }

    if (existing) {
      if (existing.status !== "proposed" && existing.status !== "escalated") {
        await this.traceOnly(
          meetingId,
          "deduplicated",
          existing.id,
          candidate.trigger.segmentIndex,
          `Repeated mention while the action is ${existing.status}; left unchanged.`,
        );
        return;
      }
      const { action, trace } = await this.mutate(meetingId, (state) => {
        const target = state.actions.find((entry) => entry.id === existing.id)!;
        // A later mention can settle what the commitment is ("a written
        // follow-up", then "the follow-up email"): the payload is drafted for
        // the new kind, so the kind must follow or it would execute wrongly.
        target.kind = candidate.kind;
        target.payload = draft.payload;
        target.evidence = draft.evidence;
        if (draft.missing && draft.missing.length > 0) target.missing = draft.missing;
        else delete target.missing;
        if (draft.notes && draft.notes.length > 0) target.notes = draft.notes;
        else delete target.notes;
        target.title = draft.title;
        target.tier = tier;
        target.payloadHash = hashPayload(draft.payload);
        target.version += 1;
        if (tier === "auto") {
          target.status = "executed";
          target.decidedAt = this.nowIso();
          target.result = this.autoResult(candidate.kind, draft.payload);
        } else if (tier === "escalate") {
          target.status = "escalated";
        } else {
          target.status = "proposed";
        }
        return {
          action: target,
          trace: this.pushTrace(
            state,
            "deduplicated",
            target.id,
            candidate.trigger.segmentIndex,
            "Repeated mention updated the existing action.",
          ),
        };
      });
      this.emitEvent(meetingId, { type: "trace", meetingId, trace });
      this.emitEvent(meetingId, { type: "action", meetingId, action: this.cloneAction(action) });
      return;
    }

    const action = this.buildAction(meetingId, candidate, draft, tier);
    const traceEvents = await this.mutate(meetingId, (state) => {
      state.actions.push(action);
      const evs = [
        this.pushTrace(state, "drafted", action.id, candidate.trigger.segmentIndex, `Drafted ${action.kind}.`),
        this.pushTrace(state, "tiered", action.id, candidate.trigger.segmentIndex, `Tier: ${action.tier}.`),
      ];
      if (action.status === "executed" && action.result) {
        evs.push(this.pushTrace(state, "executed", action.id, candidate.trigger.segmentIndex, action.result.summary));
      }
      return evs;
    });
    this.emitEvent(meetingId, { type: "action", meetingId, action: this.cloneAction(action) });
    for (const trace of traceEvents) this.emitEvent(meetingId, { type: "trace", meetingId, trace });
  }

  private buildConflictAction(
    meetingId: string,
    decision: Decision,
    segment: TranscriptSegment | undefined,
    conflict: ConflictPayload,
  ): ProposedAction {
    const createdAt = this.nowIso();
    return {
      id: this.newId(),
      meetingId,
      kind: "flag_conflict",
      tier: tierFor("flag_conflict", {}),
      status: "executed",
      title: `Conflict: ${decision.text}`.slice(0, 120),
      trigger: { segmentIndex: decision.segmentIndex, speaker: decision.speaker, quote: segment?.text ?? decision.text },
      payload: conflict,
      payloadHash: hashPayload(conflict),
      version: 1,
      evidence: [],
      dedupeKey: `conflict:${meetingId}:${decision.segmentIndex}`,
      createdAt,
      decidedAt: createdAt,
      result: { summary: conflict.explanation.slice(0, 240), simulated: false },
    };
  }

  private async processDecision(meetingId: string, decision: Decision): Promise<void> {
    const meeting = await this.current(meetingId);
    // Earlier decisions in this meeting, in the same shape store.priorDecisions
    // returns for other meetings, so checkConflicts can treat them alike.
    const priorInMeeting = meeting.decisions.map((entry) => ({
      ...entry,
      meetingId: meeting.meetingId,
      title: meeting.title,
    }));
    const priorAcrossMeetings = await this.deps.store.priorDecisions(meetingId, 20);
    const priors = [...priorAcrossMeetings, ...priorInMeeting];
    const conflict = this.deps.conflictChecker
      ? await this.deps.conflictChecker(decision, priors, this.deps.knowledge)
      : await checkConflicts(this.deps.model, decision, priors, this.deps.knowledge);
    const segment = meeting.segments.find((entry) => entry.index === decision.segmentIndex);

    let createdAction: ProposedAction | null = null;
    const traceEvents = await this.mutate(meetingId, (state) => {
      state.decisions.push(decision);
      const evs: TraceEvent[] = [
        this.pushTrace(
          state,
          "conflict_checked",
          undefined,
          decision.segmentIndex,
          conflict ? `Conflicts with a prior decision: ${conflict.explanation}` : "No conflict with prior decisions.",
        ),
      ];
      if (conflict) {
        const action = this.buildConflictAction(meetingId, decision, segment, conflict);
        state.actions.push(action);
        evs.push(this.pushTrace(state, "drafted", action.id, decision.segmentIndex, "Drafted a conflict flag."));
        evs.push(this.pushTrace(state, "tiered", action.id, decision.segmentIndex, `Tier: ${action.tier}.`));
        evs.push(this.pushTrace(state, "executed", action.id, decision.segmentIndex, action.result!.summary));
        createdAction = action;
      }
      return evs;
    });
    for (const trace of traceEvents) this.emitEvent(meetingId, { type: "trace", meetingId, trace });
    if (createdAction) this.emitEvent(meetingId, { type: "action", meetingId, action: this.cloneAction(createdAction) });
  }

  // -------------------------------------------------------------- decisions

  async approve(meetingId: string, actionId: string, payloadHash: string): Promise<ProposedAction> {
    const started = await this.mutate(meetingId, (state) => {
      const action = state.actions.find((entry) => entry.id === actionId);
      if (!action) throw new MeetingError("not_found", "No such action.", 404);
      if (action.tier !== "approval" || action.status !== "proposed") {
        throw new MeetingError("invalid_state", "This action is not waiting for approval.", 409);
      }
      if (action.payloadHash !== payloadHash) {
        throw new MeetingError("payload_changed", "The payload has changed since it was proposed.", 409);
      }
      action.status = "executing";
      return {
        action,
        trace: this.pushTrace(state, "approved", action.id, action.trigger.segmentIndex, "Approved by the employee."),
      };
    });
    this.emitEvent(meetingId, { type: "trace", meetingId, trace: started.trace });
    this.emitEvent(meetingId, { type: "action", meetingId, action: this.cloneAction(started.action) });

    const meeting = await this.current(meetingId);
    let outcome: { result?: ActionResult; error?: string };
    try {
      const result = await this.deps.executor.execute(started.action, meeting);
      outcome = { result };
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    }

    const finished = await this.mutate(meetingId, (state) => {
      const action = state.actions.find((entry) => entry.id === actionId)!;
      action.decidedAt = this.nowIso();
      if (outcome.result) {
        action.status = "executed";
        action.result = outcome.result;
        return {
          action,
          trace: this.pushTrace(state, "executed", action.id, action.trigger.segmentIndex, outcome.result.summary),
        };
      }
      action.status = "failed";
      action.error = outcome.error;
      return {
        action,
        trace: this.pushTrace(state, "failed", action.id, action.trigger.segmentIndex, outcome.error ?? "Execution failed."),
      };
    });
    this.emitEvent(meetingId, { type: "trace", meetingId, trace: finished.trace });
    this.emitEvent(meetingId, { type: "action", meetingId, action: this.cloneAction(finished.action) });
    return this.cloneAction(finished.action);
  }

  async reject(meetingId: string, actionId: string, reason?: string): Promise<ProposedAction> {
    const outcome = await this.mutate(meetingId, (state) => {
      const action = state.actions.find((entry) => entry.id === actionId);
      if (!action) throw new MeetingError("not_found", "No such action.", 404);
      if (action.status !== "proposed" && action.status !== "escalated") {
        throw new MeetingError("invalid_state", "This action cannot be rejected from its current status.", 409);
      }
      action.status = "rejected";
      action.decidedAt = this.nowIso();
      const trace = this.pushTrace(
        state,
        "rejected",
        action.id,
        action.trigger.segmentIndex,
        reason ? `Rejected: ${reason}` : "Rejected.",
      );
      return { action, trace };
    });
    this.emitEvent(meetingId, { type: "trace", meetingId, trace: outcome.trace });
    this.emitEvent(meetingId, { type: "action", meetingId, action: this.cloneAction(outcome.action) });
    return this.cloneAction(outcome.action);
  }

  async edit(meetingId: string, actionId: string, payload: ActionPayload): Promise<ProposedAction> {
    const outcome = await this.mutate(meetingId, (state) => {
      const action = state.actions.find((entry) => entry.id === actionId);
      if (!action) throw new MeetingError("not_found", "No such action.", 404);
      if (action.tier !== "approval" || action.status !== "proposed") {
        throw new MeetingError("invalid_state", "Only a proposed, approval-tier action can be edited.", 409);
      }
      if (!payloadMatchesKind(action.kind, payload)) {
        throw new MeetingError("invalid_payload", `That payload does not match a ${action.kind} action.`, 400);
      }
      action.payload = payload;
      action.payloadHash = hashPayload(payload);
      action.version += 1;
      // The employee has now filled in or changed the draft themselves, so the
      // agent's list of what was missing no longer describes it.
      delete action.missing;
      const trace = this.pushTrace(state, "edited", action.id, action.trigger.segmentIndex, `Edited (version ${action.version}).`);
      return { action, trace };
    });
    this.emitEvent(meetingId, { type: "trace", meetingId, trace: outcome.trace });
    this.emitEvent(meetingId, { type: "action", meetingId, action: this.cloneAction(outcome.action) });
    return this.cloneAction(outcome.action);
  }

  // ------------------------------------------------------------- listening

  subscribe(meetingId: string, listener: (event: MeetingEvent) => void): () => void {
    const runtime = this.runtimeFor(meetingId);
    runtime.listeners.add(listener);
    return () => {
      runtime.listeners.delete(listener);
    };
  }
}

function isStr(value: unknown): value is string {
  return typeof value === "string";
}

function isStrArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Checks a payload has the shape `edit` promises for its action's kind,
 * before it is trusted and hashed. */
function payloadMatchesKind(kind: ActionKind, payload: ActionPayload): boolean {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as unknown as Record<string, unknown>;
  switch (kind) {
    case "email_draft":
      return isStr(record.to) && isStr(record.subject) && isStr(record.body);
    case "ticket_draft":
      return isStr(record.title) && isStr(record.description);
    case "calendar_draft":
      return isStr(record.title) && isStrArray(record.attendees) && typeof record.durationMinutes === "number";
    case "message_draft":
      return isStr(record.recipient) && isStr(record.address) && isStr(record.text);
    case "doc_draft":
      return isStr(record.title) && isStr(record.body);
    case "sheet_draft":
      return (
        isStr(record.title) &&
        Array.isArray(record.rows) &&
        record.rows.length > 0 &&
        record.rows.every((row) => isStrArray(row))
      );
    case "hiring_request":
      return isStr(record.requirement) && record.requirement.length > 0;
    case "escalation":
      return isStr(record.subject) && isStr(record.reason) && isStr(record.requiredApprover);
    case "answer_question":
      return isStr(record.question) && isStr(record.answer) && isStrArray(record.citedSourceIds);
    default:
      // flag_conflict and blocked actions are never approval-tier, so edit
      // never reaches them; a false here just keeps the switch total.
      return false;
  }
}
