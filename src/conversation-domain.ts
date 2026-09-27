export interface ConversationSummary {
  conversationId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

export interface ConversationMessage {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  messages: ConversationMessage[];
}

export interface AppendTurnParams {
  conversationId: string;
  userId: string;
  userMessage: string;
  assistantMessage: string;
  assistantMetadata?: Record<string, unknown>;
}

export interface AppendTurnResult {
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
}

export interface ConversationStore {
  list(userId: string): Promise<ConversationSummary[]>;
  get(conversationId: string, userId: string): Promise<ConversationDetail | null>;
  create(userId: string, title?: string): Promise<ConversationSummary>;
  appendMessage(params: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<ConversationMessage>;
  appendTurn?(params: AppendTurnParams): Promise<AppendTurnResult>;
  updateTitle(conversationId: string, userId: string, title: string): Promise<boolean>;
  delete(conversationId: string, userId: string): Promise<boolean>;
  deleteAll?(userId: string): Promise<number>;
  close?(): Promise<void>;
}
