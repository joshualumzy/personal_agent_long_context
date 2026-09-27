import type { AgentExtension, ChatBlock, ToolDefinition } from "../agent-extension.js";
import { parseOperations } from "./agent.js";
import { RecruitingError, type CriterionKind } from "./domain.js";
import type { RoleBoard } from "./roles.js";
import type { RecruitingService } from "./service.js";

const PANEL_VIEWS = ["criteria", "pool", "candidate"] as const;
type PanelView = (typeof PANEL_VIEWS)[number];

const roleId = { type: "string", description: "The role's id from recruiting_status." };

/** A tool that acts on one role: role_id is added and required. */
function tool(
  name: string,
  description: string,
  parameters: { properties?: object; required?: string[] } = {},
  scoped = true,
): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: { ...(scoped ? { role_id: roleId } : {}), ...parameters.properties },
        required: [...(scoped ? ["role_id"] : []), ...(parameters.required ?? [])],
        additionalProperties: false,
      },
    },
  };
}

const tools: ToolDefinition[] = [
  tool(
    "recruiting_status",
    "List the open roles. With role_id, also read that role's criteria, candidates by tier and stage, and pending proposals. Call this first.",
    { properties: { role_id: roleId } },
    false,
  ),
  tool(
    "recruiting_start",
    "Open a new role from the founder's description of who to hire. Needs at least what the person does; if the founder has not said, ask instead of calling this. Other open roles are not touched.",
    {
      properties: {
        requirement: { type: "string", description: "The founder's description, as said, plus any gloss." },
      },
      required: ["requirement"],
    },
    false,
  ),
  tool("recruiting_revise_criteria", "Replace the draft criteria before they are confirmed.", {
    properties: {
      criteria: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Keep the id of a criterion you are keeping." },
            text: { type: "string" },
            kind: { type: "string", enum: ["must", "nice"] },
          },
          required: ["text", "kind"],
          additionalProperties: false,
        },
      },
    },
    required: ["criteria"],
  }),
  tool(
    "recruiting_confirm",
    "Confirm the draft criteria and start the search. Only when the founder approved them in this message.",
  ),
  tool(
    "recruiting_update",
    "Pass the founder's words when a role is confirmed: a criteria change, a keep or pass on a named person, a reply a candidate sent, or a question about why the search is the way it is.",
    {
      properties: { text: { type: "string", description: "The founder's words, as said." } },
      required: ["text"],
    },
  ),
  tool(
    "recruiting_change_criteria",
    "Change a confirmed role's criteria exactly, by id: add, remove, set_kind (must or nice), or edit the text. Prefer this over recruiting_update for criteria changes.",
    {
      properties: {
        changes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["add", "remove", "set_kind", "edit"] },
              id: { type: "string", description: "The criterion id, for remove, set_kind, and edit." },
              text: { type: "string", description: "For add and edit." },
              kind: { type: "string", enum: ["must", "nice"], description: "For add and set_kind." },
            },
            required: ["op"],
            additionalProperties: false,
          },
        },
        said: { type: "string", description: "The founder's words, kept as the reason in Memory." },
      },
      required: ["changes"],
    },
  ),
  tool(
    "recruiting_set_signature",
    "Set who outreach is from for this role (the founder's name, and a phrase about the company such as 'a 12-person fintech startup'), and redraft messages that are waiting to be sent.",
    {
      properties: {
        name: { type: "string" },
        company: { type: "string", description: "A short phrase about the company, as the founder would say it." },
      },
    },
  ),
  tool(
    "recruiting_find_more",
    "Add more people to a confirmed role without changing its criteria, by searching with new queries.",
  ),
  tool("recruiting_import_profiles", "Add people by public LinkedIn profile link.", {
    properties: { urls: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 } },
    required: ["urls"],
  }),
  tool(
    "recruiting_prepare_outreach",
    "Look up a work email and draft a first message for one candidate. Nothing is sent.",
    {
      properties: { candidate_id: { type: "string" } },
      required: ["candidate_id"],
    },
  ),
  tool(
    "recruiting_resolve_proposal",
    "Accept or decline a pending proposal. Only when the founder decided in this message.",
    {
      properties: { proposal_id: { type: "string" }, accept: { type: "boolean" } },
      required: ["proposal_id", "accept"],
    },
  ),
  tool(
    "show_recruiting_panel",
    "Show the live recruiting panel under your reply. criteria: the draft to review and confirm. pool: the orbit of candidates. candidate: one person's fit, career, and outreach draft with its send button.",
    {
      properties: {
        view: { type: "string", enum: [...PANEL_VIEWS] },
        candidate_id: { type: "string", description: "Required for the candidate view." },
      },
      required: ["view"],
    },
  ),
];

/** must or nice, from the ways a model writes them; anything else is refused, not guessed. */
function kindOf(value: unknown): CriterionKind {
  const said = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_]+/g, "-") : "";
  if (["must", "must-have", "required", "requirement", "hard"].includes(said)) return "must";
  if (["nice", "nice-to-have", "optional", "bonus", "plus", "preferred", "soft"].includes(said)) return "nice";
  throw new RecruitingError("invalid_request", `kind must be "must" or "nice", not ${JSON.stringify(value)}.`);
}

/** A real yes or no. Accepting or declining changes the search, so a guess is not good enough. */
function yesOrNo(value: unknown): boolean {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new RecruitingError("invalid_request", "accept must be true or false.");
}

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new RecruitingError("invalid_request", `${key} is required.`);
  }
  return value.trim();
}

type Snapshot = Awaited<ReturnType<RecruitingService["snapshot"]>>;

function funnelOf(snapshot: Snapshot) {
  const all = snapshot.candidates;
  const open = all.filter((candidate) => candidate.stage !== "closed");
  const settled = all.filter((candidate) => candidate.settled);
  // The same (possibly provisional) tiers the panel shows, so numbers match the screen.
  const ring = (tier: number) => open.filter((candidate) => candidate.tier === tier).length;
  const said = (candidate: (typeof all)[number], direction: string) =>
    (candidate.messages ?? []).some((message) => message.direction === direction);
  const contacted = all.filter((candidate) => said(candidate, "outbound"));
  const replied = contacted.filter((candidate) => said(candidate, "inbound"));
  return {
    found: all.length,
    scored: settled.length,
    pending: open.filter((candidate) => !candidate.settled).length,
    in_view: ring(100) + ring(75) + ring(50),
    centre: ring(100),
    middle: ring(75),
    outer: ring(50),
    out: open.filter((candidate) => candidate.tier === "out").length,
    contacted: contacted.length,
    replied: replied.length,
    reply_rate: contacted.length ? Math.round((replied.length / contacted.length) * 100) / 100 : null,
    closed: all.length - open.length,
    drafts_waiting: open.filter((candidate) => candidate.draft && !candidate.draft.sending).length,
  };
}

/** What the model needs to decide; the panel shows the rest. */
export function statusForModel(snapshot: Snapshot) {
  const open = snapshot.candidates.filter((candidate) => candidate.stage !== "closed");
  const rank = (tier: unknown) => (typeof tier === "number" ? -tier : 0);
  const inView = open.filter((candidate) => candidate.tier !== "out").sort((a, b) => rank(a.tier) - rank(b.tier));
  return {
    role: snapshot.role ? { title: snapshot.role.title, confirmed: snapshot.role.confirmed } : null,
    criteria: snapshot.criteria.map(({ id, text, kind }) => ({ id, text, kind })),
    source: snapshot.integrations.source,
    searches: snapshot.rounds.map((round) => round.queries ?? [round.query]),
    busy: snapshot.busy,
    counts: {
      centre: open.filter((candidate) => candidate.tier === 100).length,
      middle: open.filter((candidate) => candidate.tier === 75).length,
      outer: open.filter((candidate) => candidate.tier === 50).length,
      pending: open.filter((candidate) => !candidate.settled).length,
      closed: snapshot.candidates.length - open.length,
    },
    // The numbers a founder asks for. "found" minus "in_view" is everyone the criteria ruled out,
    // so "found 15" and "0 in view" are never mistaken for each other.
    funnel: funnelOf(snapshot),
    candidates: inView
      .slice(0, 15)
      .map((candidate) => ({
        id: candidate.id,
        name: candidate.profile.name,
        headline: candidate.profile.headline,
        tier: candidate.tier,
        ring: candidate.tier === 100 ? "centre" : candidate.tier === 75 ? "middle" : candidate.tier === 50 ? "outer" : "not placed yet",
        stage: candidate.stage,
        kept: candidate.kept,
        email: candidate.contact ? candidate.contact.status : "none",
        has_draft: Boolean(candidate.draft),
      })),
    // Everyone else in view, briefly, so any of them can be named in a tool call.
    ...(inView.length > 15
      ? { more_in_view: inView.slice(15).map((candidate) => ({ id: candidate.id, name: candidate.profile.name, stage: candidate.stage })) }
      : {}),
    // People the criteria ruled out or the founder closed, briefly: the founder may still name
    // them ("draft to Zoe anyway", "keep Alex after all").
    ...(() => {
      const others = snapshot.candidates
        .filter((candidate) => candidate.stage === "closed" || candidate.tier === "out")
        // People the founder added, contacted or closed come first; the rest only fill up to 60.
        .sort((a, b) => Number(b.origin === "referral" || b.stage === "closed" || b.messages.length > 0) - Number(a.origin === "referral" || a.stage === "closed" || a.messages.length > 0))
        .slice(0, 60)
        .map((candidate) => ({
          id: candidate.id,
          name: candidate.profile.name,
          why: candidate.stage === "closed" ? `closed (${candidate.closedReason ?? "closed"})` : "ruled out by the criteria",
        }));
      return others.length ? { not_in_view: others } : {};
    })(),
    proposals: snapshot.proposals.map((proposal) => ({
      id: proposal.id,
      what: proposal.type === "criterion" ? `Add "${proposal.text}" (${proposal.kind})` : proposal.stepName,
      why: proposal.rationale,
    })),
    gmail_connected: snapshot.integrations.gmail === true,
    last_error: snapshot.lastError,
  };
}

/**
 * The recruiting direction as tools for the chat agent. Its tools are offered
 * only after the model loads the recruiting skill, and none of them sends.
 */
export function recruitingExtension(board: RoleBoard): AgentExtension {
  return {
    skill: "recruiting",
    tools,
    async run(name, args) {
      try {
        return await runTool(board, name, args);
      } catch (error) {
        if (error instanceof RecruitingError) {
          return { content: JSON.stringify({ error: error.message }) };
        }
        // An outage (model, search) is news for the founder, not a crash of the chat.
        return {
          content: JSON.stringify({
            error: `Something the recruiting tools depend on failed: ${error instanceof Error ? error.message : String(error)}. Tell the founder and suggest trying again shortly.`,
          }),
        };
      }
    },
  };
}

async function runTool(
  board: RoleBoard,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; block?: ChatBlock }> {
  if (name === "recruiting_status") {
    const roles = await board.list();
    const named = typeof args.role_id === "string" ? args.role_id.trim() : "";
    const chosen = named || (roles.length === 1 ? roles[0]!.id : null);
    return {
      content: JSON.stringify({
        roles,
        ...(chosen ? { role_id: chosen, status: statusForModel(await (await board.get(chosen)).snapshot()) } : {}),
      }),
    };
  }
  if (name === "recruiting_start") {
    const requirement = text(args, "requirement");
    const { id, service } = board.create();
    let result;
    try {
      result = await service.start(requirement);
    } catch (error) {
      // A start that failed leaves no role behind, not even in memory.
      board.forget(id);
      throw error;
    }
    return { content: JSON.stringify({ role_id: id, result, status: statusForModel(await service.snapshot()) }) };
  }

  const roleId = text(args, "role_id");
  const service = await board.get(roleId);
  const status = async (extra: object = {}) =>
    JSON.stringify({ ...extra, role_id: roleId, status: statusForModel(await service.snapshot()) });

  switch (name) {
    case "recruiting_revise_criteria": {
      if (!Array.isArray(args.criteria)) {
        throw new RecruitingError("invalid_request", "criteria must be a list of {text, kind}.");
      }
      const criteria = args.criteria.map((entry) => {
        if (typeof entry !== "object" || entry === null || typeof (entry as Record<string, unknown>).text !== "string") {
          throw new RecruitingError("invalid_request", "Each criterion must be an object with text and kind.");
        }
        const record = entry as Record<string, unknown>;
        return {
          ...(typeof record.id === "string" ? { id: record.id } : {}),
          text: record.text as string,
          kind: kindOf(record.kind),
        };
      });
      if (!criteria.some((criterion) => criterion.text.trim())) {
        throw new RecruitingError("invalid_request", "Keep at least one criterion; the draft was not changed.");
      }
      await service.reviseDraft(criteria);
      return { content: await status() };
    }
    case "recruiting_confirm":
      await service.confirm();
      return { content: await status({ result: "Confirmed. Scoring continues in the background." }) };
    case "recruiting_update":
      return { content: await status({ result: await service.say(text(args, "text")) }) };
    case "recruiting_change_criteria": {
      if (!Array.isArray(args.changes) || args.changes.length === 0) {
        throw new RecruitingError("invalid_request", "changes must be a non-empty list.");
      }
      const criteria = (await service.snapshot()).criteria;
      for (const change of args.changes) {
        if (typeof change !== "object" || change === null) throw new RecruitingError("invalid_request", "Each change must be an object.");
        const entry = change as Record<string, unknown>;
        // A kind of null means none given; remove and edit take no kind at all.
        if ((entry.op === "add" || entry.op === "set_kind") && entry.kind != null) kindOf(entry.kind);
        if (entry.op !== "add" && !criteria.some((criterion) => criterion.id === entry.id)) {
          throw new RecruitingError("invalid_request", `No criterion with id ${String(entry.id)}; read recruiting_status for the ids.`);
        }
      }
      const operations = parseOperations(
        args.changes.map((change) => {
          const entry = change as Record<string, unknown>;
          if (entry.op !== "add" && entry.op !== "set_kind") return { ...entry, kind: undefined };
          return entry.kind == null ? { ...entry, kind: undefined } : { ...entry, kind: kindOf(entry.kind) };
        }),
        criteria as never,
      );
      if (operations.length === 0) throw new RecruitingError("invalid_request", "None of the changes could be applied.");
      // All or nothing: applying part of a batch and calling it done would mislead the founder.
      if (operations.length < args.changes.length) {
        throw new RecruitingError("invalid_request", "Some changes were not understood (an empty text, an unknown op, or a missing kind). Nothing was changed; fix them and send the whole list again.");
      }
      const said = typeof args.said === "string" && args.said.trim() ? args.said.trim() : "changed in the chat";
      return { content: await status({ result: await service.changeCriteria(operations, said) }) };
    }
    case "recruiting_set_signature": {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const company = typeof args.company === "string" ? args.company.trim() : "";
      if (!name && !company) throw new RecruitingError("invalid_request", "Give a name, a company phrase, or both.");
      const redrafted = await service.setSender({ ...(name ? { name } : {}), ...(company ? { company } : {}) });
      return { content: await status({ result: `Outreach is now from ${name || "the same person"}${company ? `, ${company}` : ""}. Redrafted ${redrafted} waiting ${redrafted === 1 ? "message" : "messages"}.` }) };
    }
    case "recruiting_find_more": {
      const found = await service.findMore();
      const message = found.added
        ? `Added ${found.added} new people; they are being scored now.`
        : "No new people were found with new search angles. Nothing is still running; suggest relaxing a criterion.";
      return { content: await status({ result: { ...found, message } }) };
    }
    case "recruiting_import_profiles": {
      // One link or a list; "linkedin.com/in/x", "www…" and "http://…" become https links, as on the page.
      // A list sent as JSON text ("[\"a\", \"b\"]") is read as the list it is.
      let raw: unknown = args.urls;
      if (typeof raw === "string" && raw.trim().startsWith("[")) {
        try {
          raw = JSON.parse(raw);
        } catch {
          // not JSON after all: split it as text
        }
      }
      const given = typeof raw === "string"
        ? raw.split(/[\s,，、;；]+/).map((piece) => piece.replace(/^["'\[]+|["'\]]+$/g, ""))
        : Array.isArray(raw) ? raw : [];
      const urls = given
        .filter((url): url is string => typeof url === "string" && url.trim() !== "")
        .map((url) => url.trim().replace(/^(?:https?:\/\/)?((?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/)/i, "https://$1"));
      return { content: await status({ result: await service.importProfiles(urls) }) };
    }
    case "recruiting_prepare_outreach": {
      const candidateId = text(args, "candidate_id");
      await service.prepareOutreach(candidateId);
      const candidate = (await service.snapshot()).candidates.find((entry) => entry.id === candidateId);
      return {
        content: JSON.stringify({
          result: "Draft ready. The founder reviews and sends it from the candidate panel.",
          email: candidate?.contact ? candidate.contact.status : "none found",
          warnings: candidate?.draft?.warnings ?? [],
        }),
      };
    }
    case "recruiting_resolve_proposal":
      await service.resolveProposal(text(args, "proposal_id"), yesOrNo(args.accept));
      return { content: await status() };
    case "show_recruiting_panel": {
      const view = args.view as PanelView;
      if (!PANEL_VIEWS.includes(view)) throw new RecruitingError("invalid_request", "Unknown panel view.");
      if (view !== "candidate") return { content: "Shown.", block: { type: "recruiting", view, roleId } };
      const candidateId = text(args, "candidate_id");
      const known = (await service.snapshot()).candidates.some((entry) => entry.id === candidateId);
      if (!known) throw new RecruitingError("invalid_request", `No candidate with id ${candidateId} in this role.`);
      return { content: "Shown.", block: { type: "recruiting", view, roleId, candidateId } };
    }
    default:
      throw new Error(`Unknown recruiting tool ${name}.`);
  }
}
