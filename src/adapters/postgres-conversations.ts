import pg from "pg";
import type {
  ConversationDetail,
  ConversationMessage,
  ConversationStore,
  ConversationSummary,
} from "../conversation-domain.js";

interface ConversationRow {
  conversation_id: string;
  user_id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
  message_count?: string | number;
}

interface MessageRow {
  message_id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  metadata: unknown;
  created_at: Date;
}

function summaryFromRow(row: ConversationRow): ConversationSummary {
  return {
    conversationId: row.conversation_id,
    userId: row.user_id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    messageCount: row.message_count !== undefined ? Number(row.message_count) : 0,
  };
}

function messageFromRow(row: MessageRow): ConversationMessage {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    metadata:
      typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdAt: row.created_at.toISOString(),
  };
}

export class PostgresConversationStore implements ConversationStore {
  readonly pool: pg.Pool;
  private readonly ownsPool: boolean;

  constructor(databaseUrlOrPool: string | pg.Pool) {
    if (typeof databaseUrlOrPool === "string") {
      this.pool = new pg.Pool({ connectionString: databaseUrlOrPool, max: 8 });
      this.ownsPool = true;
    } else {
      this.pool = databaseUrlOrPool;
      this.ownsPool = false;
    }
  }

  async list(userId: string): Promise<ConversationSummary[]> {
    const result = await this.pool.query<ConversationRow>(
      `SELECT c.conversation_id, c.user_id, c.title, c.created_at, c.updated_at,
              COUNT(m.message_id)::int AS message_count
       FROM conversations c
       LEFT JOIN conversation_messages m ON c.conversation_id = m.conversation_id
       WHERE c.user_id = $1
       GROUP BY c.conversation_id
       ORDER BY c.updated_at DESC`,
      [userId],
    );
    return result.rows.map(summaryFromRow);
  }

  async get(conversationId: string, userId: string): Promise<ConversationDetail | null> {
    const convResult = await this.pool.query<ConversationRow>(
      `SELECT conversation_id, user_id, title, created_at, updated_at
       FROM conversations
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    );
    const convRow = convResult.rows[0];
    if (!convRow) return null;

    const messagesResult = await this.pool.query<MessageRow>(
      `SELECT message_id, conversation_id, role, content, metadata, created_at
       FROM conversation_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [conversationId],
    );

    return {
      conversation: {
        ...summaryFromRow(convRow),
        messageCount: messagesResult.rowCount ?? messagesResult.rows.length,
      },
      messages: messagesResult.rows.map(messageFromRow),
    };
  }

  async create(userId: string, title?: string): Promise<ConversationSummary> {
    const conversationTitle = title?.trim() || "New conversation";
    const result = await this.pool.query<ConversationRow>(
      `INSERT INTO conversations (user_id, title)
       VALUES ($1, $2)
       RETURNING conversation_id, user_id, title, created_at, updated_at`,
      [userId, conversationTitle],
    );
    return summaryFromRow(result.rows[0]);
  }

  async appendMessage(params: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<ConversationMessage> {
    const metadataJson = JSON.stringify(params.metadata ?? {});
    const result = await this.pool.query<MessageRow>(
      `INSERT INTO conversation_messages (conversation_id, role, content, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING message_id, conversation_id, role, content, metadata, created_at`,
      [params.conversationId, params.role, params.content, metadataJson],
    );

    await this.pool.query(
      `UPDATE conversations
       SET updated_at = now()
       WHERE conversation_id = $1`,
      [params.conversationId],
    );

    return messageFromRow(result.rows[0]);
  }

  async updateTitle(conversationId: string, userId: string, title: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE conversations
       SET title = $3, updated_at = now()
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId, title.trim()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async delete(conversationId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM conversations
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}

/** In-memory implementation of ConversationStore for unit tests */
export class InMemoryConversationStore implements ConversationStore {
  private conversations = new Map<string, ConversationSummary>();
  private messages = new Map<string, ConversationMessage[]>();

  async list(userId: string): Promise<ConversationSummary[]> {
    return [...this.conversations.values()]
      .filter((c) => c.userId === userId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((c) => ({
        ...c,
        messageCount: this.messages.get(c.conversationId)?.length ?? 0,
      }));
  }

  async get(conversationId: string, userId: string): Promise<ConversationDetail | null> {
    const conv = this.conversations.get(conversationId);
    if (!conv || conv.userId !== userId) return null;
    const msgs = this.messages.get(conversationId) ?? [];
    return {
      conversation: { ...conv, messageCount: msgs.length },
      messages: [...msgs],
    };
  }

  async create(userId: string, title?: string): Promise<ConversationSummary> {
    const id = `conv-${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();
    const summary: ConversationSummary = {
      conversationId: id,
      userId,
      title: title?.trim() || "New conversation",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    this.conversations.set(id, summary);
    this.messages.set(id, []);
    return summary;
  }

  async appendMessage(params: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<ConversationMessage> {
    const conv = this.conversations.get(params.conversationId);
    if (!conv) throw new Error(`Conversation not found: ${params.conversationId}`);

    const now = new Date().toISOString();
    conv.updatedAt = now;

    const msg: ConversationMessage = {
      messageId: `msg-${Math.random().toString(36).slice(2, 10)}`,
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
      metadata: params.metadata ?? {},
      createdAt: now,
    };

    const list = this.messages.get(params.conversationId) ?? [];
    list.push(msg);
    this.messages.set(params.conversationId, list);
    return msg;
  }

  async updateTitle(conversationId: string, userId: string, title: string): Promise<boolean> {
    const conv = this.conversations.get(conversationId);
    if (!conv || conv.userId !== userId) return false;
    conv.title = title.trim();
    conv.updatedAt = new Date().toISOString();
    return true;
  }

  async delete(conversationId: string, userId: string): Promise<boolean> {
    const conv = this.conversations.get(conversationId);
    if (!conv || conv.userId !== userId) return false;
    this.conversations.delete(conversationId);
    this.messages.delete(conversationId);
    return true;
  }
}
