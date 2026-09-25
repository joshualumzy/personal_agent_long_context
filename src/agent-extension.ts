/** An OpenAI-style function tool, as sent in a chat-completions request. */
export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

/**
 * A live panel shown under an assistant message. It carries ids only; the
 * browser fetches the data itself, so the model never copies it.
 */
export type ChatBlock = {
  type: "recruiting";
  view: "criteria" | "pool" | "candidate";
  roleId: string;
  candidateId?: string;
};

/**
 * Extra tools for the chat agent that belong to one skill. They are offered to
 * the model only after it loads that skill.
 */
export interface AgentExtension {
  skill: string;
  tools: ToolDefinition[];
  run(name: string, args: Record<string, unknown>): Promise<{ content: string; block?: ChatBlock }>;
}
