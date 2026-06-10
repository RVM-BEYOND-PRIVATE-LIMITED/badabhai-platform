import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import {
  type Database,
  chatSessions,
  chatMessages,
  type ChatSession,
  type ChatMessage,
  type NewChatMessage,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

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
    return this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(asc(chatMessages.createdAt));
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
