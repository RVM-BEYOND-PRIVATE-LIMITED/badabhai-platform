import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { chatMessages, chatSessions, type Database } from "@badabhai/db";
import type { MessageDirection } from "@badabhai/types";

/** One stored profiling line, as the read selects it. */
export interface ProfilingChatRow {
  readonly id: string;
  readonly sessionId: string;
  readonly direction: MessageDirection;
  readonly bodyText: string | null;
  readonly metadata: unknown;
  readonly createdAt: Date;
}

/**
 * #2391 (ADR-0059) — THE WORKER'S STORED PROFILING LINES after `since`: the newest `limit`, handed
 * back OLDEST FIRST, in `ChatRepository.listMessages`' order. A turn's worker line and its reply
 * share one timestamp, and `outbound` sorts after `inbound`, so DESC plus the reverse puts the
 * worker's line first.
 *
 * ONLY WHAT WAS SAID IN THE CHAT. A row written into a session AFTER it closed is not a line of
 * that conversation: the review screen's spoken correction (#1272) appends the worker's corrected
 * words to the finished session as a lone inbound row, for extraction and the audit transcript.
 * Shown, it would read as an unprompted message after the chat ended.
 *
 * A LEAF, like `free-chat-summary.query.ts`: schema imports only, no write of any kind, so the
 * read-only reader that runs it reaches no chat writer.
 */
export async function selectProfilingRows(
  db: Database,
  workerId: string,
  since: Date,
  limit: number,
): Promise<ProfilingChatRow[]> {
  const rows = await db
    .select({
      id: chatMessages.id,
      sessionId: chatMessages.sessionId,
      direction: chatMessages.direction,
      bodyText: chatMessages.bodyText,
      metadata: chatMessages.metadata,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .innerJoin(chatSessions, eq(chatSessions.id, chatMessages.sessionId))
    .where(
      and(
        eq(chatMessages.workerId, workerId),
        gt(chatMessages.createdAt, since),
        or(isNull(chatSessions.endedAt), lte(chatMessages.createdAt, chatSessions.endedAt)),
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.direction))
    .limit(limit);
  return rows.reverse();
}

/**
 * #2391 — the worker's LIVE (`active`) session ids, newest activity first (the reattach order,
 * `coalesce(last_message_at, started_at) DESC`): the sessions whose lines may still be in Redis.
 */
export async function selectLiveSessionIds(
  db: Database,
  workerId: string,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(and(eq(chatSessions.workerId, workerId), eq(chatSessions.status, "active")))
    .orderBy(sql`coalesce(${chatSessions.lastMessageAt}, ${chatSessions.startedAt}) DESC`)
    .limit(limit);
  return rows.map((row) => row.id);
}
