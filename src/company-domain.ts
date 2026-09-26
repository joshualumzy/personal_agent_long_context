import type { ChatBlock } from "./agent-extension.js";

export interface EmployeePersona {
  employeeId: string;
  displayName: string;
  role?: string;
  department?: string;
  avatar?: string;
}

export interface EmployeeContext extends EmployeePersona {
  currentAssignments: string[];
}

export interface Evidence {
  sourceId: string;
  sourceType: string;
  title: string;
  excerpt: string;
  occurredAt?: string;
  department?: string;
  score?: number;
}

export interface CompanyKnowledge {
  employee(employeeId: string): Promise<EmployeeContext | null>;
  listEmployees?(): Promise<EmployeePersona[]>;
  verifyEmployeePassword?(employeeId: string, password: string): Promise<EmployeePersona | null>;
  search(query: string, limit: number): Promise<Evidence[]>;
  related(sourceIds: string[], limit: number): Promise<Evidence[]>;
  sources(sourceIds: string[]): Promise<Evidence[]>;
  close?(): Promise<void>;
}

export interface ConversationTurnMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompanyQuestion {
  employeeId: string;
  question: string;
  /** User-scoped Letta context. It is context, never Company Evidence. */
  personalMemory?: string;
  conversationHistory?: ConversationTurnMessage[];
  /** The last few turns of this conversation, oldest first. */
  history?: ConversationTurnMessage[];
}

export interface CompanyAnswer {
  answer: string;
  sources: Evidence[];
  runId: string;
  toolCalls: Array<{ name: string; arguments: unknown }>;
  /** Live panels to show under the answer, in the order the model asked. */
  blocks?: ChatBlock[];
}
