import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import {
  type Database,
  chatSessions,
  chatMessages,
  type ChatSession,
  type ChatMessage,
  type NewChatMessage,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * Safety bound for the per-session message-history read (the chat loop +
 * extraction transcript). Well above any realistic interview length, so a normal
 * session is returned in full; it only caps a pathological/abusive session so the
 * hot-path read can never load an unbounded result set. When capped, the MOST
 * RECENT messages are kept (recency matters for LLM context), still returned in
 * chronological order.
 */
export const CHAT_HISTORY_MAX = 500;

@Injectable()
export class ChatRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async createSession(workerId: string): Promise<ChatSession> {
    const inserted = await this.db
      .insert(chatSessions)
      .values({ workerId, status: "active" })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create chat session");
    return row;
  }

  async findSession(sessionId: string): Promise<ChatSession | undefined> {
    const rows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);
    return rows[0];
  }

  async insertMessage(input: NewChatMessage): Promise<ChatMessage> {
    const inserted = await this.db.insert(chatMessages).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to insert chat message");
    return row;
  }

  async listMessages(sessionId: string): Promise<ChatMessage[]> {
    // Bounded hot-path read: take the most recent CHAT_HISTORY_MAX, then return
    // them in chronological order. A realistic interview is well under the cap, so
    // this is byte-identical to the old unbounded `asc` read for normal sessions.
    const rows = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(CHAT_HISTORY_MAX);
    return rows.reverse();
  }

  async touchSession(sessionId: string, at: Date): Promise<void> {
    await this.db
      .update(chatSessions)
      .set({ lastMessageAt: at })
      .where(eq(chatSessions.id, sessionId));
  }

  /**
   * Persist the interview ConversationState for a session (and touch
   * lastMessageAt in the same write). Stored as loose JSONB; the caller owns the
   * shape (ai-contracts ConversationState). Profile signals only — never PII.
   */
  async saveConversationState(
    sessionId: string,
    state: Record<string, unknown>,
    at: Date,
  ): Promise<void> {
    await this.db
      .update(chatSessions)
      .set({ conversationState: state, lastMessageAt: at })
      .where(eq(chatSessions.id, sessionId));
  }
}
