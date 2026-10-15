import { and, desc, eq, sql } from "drizzle-orm";
import { type Database, chatSessions } from "@badabhai/db";

/**
 * ADR-0051 §8 (Release 2) — THE ONE QUERY for the worker's latest rolling free-chat summary: the
 * NEWEST session (by `started_at`) whose state CARRIES a summary TEXT, as its id and the raw
 * `free_chat_summary` value — or undefined. The caller parses the value (`readFreeChatSummaryValue`,
 * strict, fails soft).
 *
 * A LEAF, ON PURPOSE. `ChatRepository.findLatestFreeChatSummary` runs it, and so does the
 * READ-ONLY `FreeChatSummaryReader` the Bada Bhai chat injects (ADR-0055 R4): one definition of
 * "the latest summary", and a reader that never touches `ChatRepository` or any of its writers.
 * Imports nothing but the schema, so neither side gains a runtime edge it did not have.
 *
 * Newest-started wins because each new session inherits the summary at open and folds onto its own
 * row, so the newest carrier holds the latest text. A watermark-only record (`text: null`) is no
 * summary and must not shadow an older session's text — hence the test in the WHERE clause. ONE
 * INDEXED READ: `chat_sessions_worker_id_idx` narrows to one worker's handful of rows.
 */
export async function selectLatestFreeChatSummary(
  db: Database,
  workerId: string,
): Promise<{ id: string; summary: unknown } | undefined> {
  const rows = await db
    .select({
      id: chatSessions.id,
      summary: sql<unknown>`${chatSessions.conversationState} -> 'free_chat_summary'`,
    })
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.workerId, workerId),
        sql`${chatSessions.conversationState} -> 'free_chat_summary' ->> 'text' IS NOT NULL`,
      ),
    )
    .orderBy(desc(chatSessions.startedAt))
    .limit(1);
  return rows[0];
}
