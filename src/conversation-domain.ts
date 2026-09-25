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
  updateTitle(conversationId: string, userId: string, title: string): Promise<boolean>;
  delete(conversationId: string, userId: string): Promise<boolean>;
  close?(): Promise<void>;
}
