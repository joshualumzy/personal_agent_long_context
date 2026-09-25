import type { AgentExtension, ChatBlock, ToolDefinition } from "../agent-extension.js";
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

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new RecruitingError("invalid_request", `${key} is required.`);
  }
  return value.trim();
}

type Snapshot = Awaited<ReturnType<RecruitingService["snapshot"]>>;

/** What the model needs to decide; the panel shows the rest. */
export function statusForModel(snapshot: Snapshot) {
  const open = snapshot.candidates.filter((candidate) => candidate.stage !== "closed");
  const rank = (tier: unknown) => (typeof tier === "number" ? -tier : 0);
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
    candidates: open
      .filter((candidate) => candidate.tier !== "out")
      .sort((a, b) => rank(a.tier) - rank(b.tier))
      .slice(0, 15)
      .map((candidate) => ({
        id: candidate.id,
        name: candidate.profile.name,
        headline: candidate.profile.headline,
        tier: candidate.tier,
        stage: candidate.stage,
        kept: candidate.kept,
        email: candidate.contact ? candidate.contact.status : "none",
        has_draft: Boolean(candidate.draft),
      })),
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
        throw error;
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
    const chosen = typeof args.role_id === "string" ? args.role_id : roles.length === 1 ? roles[0]!.id : null;
    return {
      content: JSON.stringify({
        roles,
        ...(chosen ? { role_id: chosen, status: statusForModel(await (await board.get(chosen)).snapshot()) } : {}),
      }),
    };
  }
  if (name === "recruiting_start") {
    const { id, service } = board.create();
    const result = await service.start(text(args, "requirement"));
    return { content: JSON.stringify({ role_id: id, result, status: statusForModel(await service.snapshot()) }) };
  }

  const roleId = text(args, "role_id");
  const service = await board.get(roleId);
  const status = async (extra: object = {}) =>
    JSON.stringify({ ...extra, role_id: roleId, status: statusForModel(await service.snapshot()) });

  switch (name) {
    case "recruiting_revise_criteria": {
      const criteria = Array.isArray(args.criteria) ? args.criteria : [];
      await service.reviseDraft(
        criteria
          .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
          .map((entry) => ({
            ...(typeof entry.id === "string" ? { id: entry.id } : {}),
            text: String(entry.text ?? ""),
            kind: (entry.kind === "nice" ? "nice" : "must") as CriterionKind,
          })),
      );
      return { content: await status() };
    }
    case "recruiting_confirm":
      await service.confirm();
      return { content: await status({ result: "Confirmed. Scoring continues in the background." }) };
    case "recruiting_update":
      return { content: await status({ result: await service.say(text(args, "text")) }) };
    case "recruiting_find_more":
      return { content: await status({ result: await service.findMore() }) };
    case "recruiting_import_profiles": {
      const urls = Array.isArray(args.urls) ? args.urls.filter((url): url is string => typeof url === "string") : [];
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
      await service.resolveProposal(text(args, "proposal_id"), args.accept === true);
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
