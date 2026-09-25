import type { ChatBlock } from "./agent-extension.js";

export interface EmployeeContext {
  employeeId: string;
  displayName: string;
  role?: string;
  department?: string;
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
  search(query: string, limit: number): Promise<Evidence[]>;
  related(sourceIds: string[], limit: number): Promise<Evidence[]>;
  sources(sourceIds: string[]): Promise<Evidence[]>;
  close?(): Promise<void>;
}

export interface CompanyQuestion {
  employeeId: string;
  question: string;
  /** User-scoped Letta context. It is context, never Company Evidence. */
  personalMemory?: string;
  /** The last few turns of this conversation, oldest first. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface CompanyAnswer {
  answer: string;
  sources: Evidence[];
  runId: string;
  toolCalls: Array<{ name: string; arguments: unknown }>;
  /** Live panels to show under the answer, in the order the model asked. */
  blocks?: ChatBlock[];
}
