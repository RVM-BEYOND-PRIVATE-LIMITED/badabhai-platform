import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { z } from "zod";
import type { ServerConfig } from "@badabhai/config";
import type { Database } from "@badabhai/db";
import { logSafeReason } from "../common/db-error";
import { SERVER_CONFIG } from "../config/config.module";
import { DATABASE } from "../database/database.module";
import { narrowNewsLinks, type FreeChatNewsLink } from "../profiling/free-chat/free-chat-news-links";
import { ttsField } from "../profiling/question-tts-text";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { withinRedisDeadline } from "../queue/redis-deadline";
import { chatTranscriptKey, newsLinksOfMetadata } from "./chat-transcript.buffer";
import {
  selectLiveSessionIds,
  selectProfilingRows,
  type ProfilingChatRow,
} from "./profiling-chat-lines.query";

export type { ProfilingChatRow } from "./profiling-chat-lines.query";

/** #2391 — at most this many profiling lines are read back (the newest). */
export const PROFILING_CHAT_LINES_MAX = 400;

/** #2391 — at most this many LIVE sessions have their in-flight transcript read from Redis. */
export const PROFILING_LIVE_SESSIONS_MAX = 3;

/** One line of a profiling chat as the Bada Bhai chat redraws it. */
export interface ProfilingChatLine {
  /** An opaque, stable id for the line — never the `chat_messages` row id itself. */
  readonly id: string;
  readonly sessionId: string;
  readonly role: "worker" | "bada_bhai";
  /** Display-ready: the `{{worker_name}}` vocative and any other template token removed. */
  readonly text: string;
  /** The reviewed Devanagari read-aloud twin, on a Bada Bhai line that has one. */
  readonly ttsText?: string;
  /** An answered live-news reply's tiles, on that Bada Bhai line only. */
  readonly newsLinks?: readonly FreeChatNewsLink[];
  readonly createdAt: Date;
}

/**
 * A read that may have failed: `ok: false` means "unknown", never "no chat". `truncated`: the
 * window held more lines than were returned, so lines older than the oldest one returned exist.
 */
export type ProfilingLinesRead =
  | { readonly ok: true; readonly value: ProfilingChatLine[]; readonly truncated: boolean }
  | { readonly ok: false };

/** The only Redis command this reader issues. */
interface RedisReadClient {
  mget(...keys: string[]): Promise<(string | null)[]>;
}

/**
 * The slice of a stored transcript buffer this reader needs. LENIENT on purpose: the buffer's own
 * class owns its shape, and this view reads only the owner and each line's role, text, time and
 * news tiles. A line that does not fit is dropped on its own.
 */
const BufferViewSchema = z.object({ workerId: z.string(), messages: z.array(z.unknown()) });
const BufferedLineViewSchema = z.object({
  role: z.enum(["worker", "assistant"]),
  text: z.string(),
  at: z.string(),
  newsLinks: z.unknown().optional(),
});

/** The vocative the persona writes as `{{worker_name}} ji, …` — the app's own strip, server-side. */
const WORKER_NAME_VOCATIVE = /\{\{\s*worker_name\s*\}\}\s*(ji\b)?[,\s]*/gi;
/** Any other template token: stripped rather than shown, as the live reply does. */
const ANY_TEMPLATE_TOKEN = /\{\{[^}]*\}\}/g;

/**
 * THE PROFILING CHAT, READ BACK FOR THE BADA BHAI CHAT (#2391, owner rulings 2026-10-21, ADR-0059).
 *
 * The Bada Bhai chat now opens on the conversation the worker had while profiling. This reads it:
 * every line of every profiling session in the window, from the worker's stored rows
 * (`chat_messages`, `selectProfilingRows`) and, for a session that is still `active` (an early
 * finish, before the idle sweep closes it), from its in-flight Redis transcript, exactly as
 * `GET /chat/sessions/:id/messages` prefers the buffer for a live session.
 *
 * READ-ONLY BY CONSTRUCTION. The two SELECTs of its leaf query file on the @Global database handle,
 * and one bounded `MGET` on the borrowed BullMQ connection. No `ChatRepository`, no
 * `ChatTranscriptBuffer` instance, so no chat-table or transcript WRITER is reachable from the
 * module that provides it (the companion's boot test pins this file). The buffer's key and its
 * news-tile narrowing are pure functions.
 *
 * THE WORKER'S OWN WORDS, TO THE WORKER. Every line is shown as the redraw shows it: the persona's
 * `{{worker_name}}` vocative is REMOVED (no name is ever decrypted here), the Devanagari twin rides a
 * Bada Bhai line that has one, and an answered news reply keeps its tiles unless the free chat's
 * kill switch is on. A line's id is opaque. Nothing is logged but ids and a closed reason.
 *
 * FAILS SOFT. A failed database read is `ok: false` (the caller shows what it has). A Redis read
 * that fails or exceeds its deadline drops only the live sessions; the stored rows still show.
 */
@Injectable()
export class ProfilingChatLinesReader {
  private readonly logger = new Logger(ProfilingChatLinesReader.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @Inject(DATABASE) private readonly db: Database,
    // Borrow BullMQ's existing Redis connection — nothing enqueues here.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /** Every profiling line after `since`, oldest first, at most {@link PROFILING_CHAT_LINES_MAX}. */
  async since(workerId: string, since: Date): Promise<ProfilingLinesRead> {
    let rows: ProfilingChatRow[];
    let liveSessionIds: string[];
    try {
      [rows, liveSessionIds] = await Promise.all([
        selectProfilingRows(this.db, workerId, since, PROFILING_CHAT_LINES_MAX),
        selectLiveSessionIds(this.db, workerId, PROFILING_LIVE_SESSIONS_MAX),
      ]);
    } catch (error) {
      this.logger.warn(
        `profiling chat lines unreadable for worker ${workerId}; the Bada Bhai chat goes without ` +
          `them: ${logSafeReason(error, "profiling chat lines read")}`,
      );
      return { ok: false };
    }
    const buffered = await this.bufferedLines(workerId, liveSessionIds, since);
    const tiles = this.config.CHAT_FREE_CHAT_DISABLED !== true;
    const stored = rows
      .filter((row) => !buffered.has(row.sessionId))
      .map((row) => lineOfRow(row, tiles))
      .filter((line): line is ProfilingChatLine => line !== null);
    const live = [...buffered.values()].flat();
    const lines = chatsTheWorkerSpokeIn(byTime([...stored, ...live]));
    return {
      ok: true,
      value: lines.slice(-PROFILING_CHAT_LINES_MAX),
      // The stored read hit its limit (older rows may exist), or the merge had to drop the oldest.
      truncated: rows.length >= PROFILING_CHAT_LINES_MAX || lines.length > PROFILING_CHAT_LINES_MAX,
    };
  }

  /**
   * Each live session's in-flight lines after `since`, keyed by session — only sessions whose
   * buffer holds at least one line and belongs to this worker. One `MGET` under the Redis deadline;
   * any failure reads as "no live lines".
   */
  private async bufferedLines(
    workerId: string,
    sessionIds: readonly string[],
    since: Date,
  ): Promise<Map<string, ProfilingChatLine[]>> {
    const out = new Map<string, ProfilingChatLine[]>();
    if (sessionIds.length === 0) return out;
    let values: (string | null)[];
    try {
      values = await withinRedisDeadline(async () => {
        const client = (await this.queue.client) as unknown as RedisReadClient;
        return client.mget(...sessionIds.map(chatTranscriptKey));
      });
    } catch (error) {
      this.logger.warn(
        `live profiling transcripts unreadable for worker ${workerId}; their lines are left out: ` +
          `${logSafeReason(error, "live transcript read")}`,
      );
      return out;
    }
    const tiles = this.config.CHAT_FREE_CHAT_DISABLED !== true;
    sessionIds.forEach((sessionId, index) => {
      const lines = linesOfBuffer(values[index] ?? null, workerId, sessionId, tiles);
      if (lines.length > 0) out.set(sessionId, lines.filter((line) => line.createdAt > since));
    });
    return out;
  }
}

/** A stored row as a redraw line, or null when it has nothing to show (a voice row before its transcript). */
export function lineOfRow(row: ProfilingChatRow, tiles: boolean): ProfilingChatLine | null {
  const role = row.direction === "inbound" ? "worker" : "bada_bhai";
  return displayLine({
    id: opaqueLineId(`chat-message:${row.id}`),
    sessionId: row.sessionId,
    role,
    raw: row.bodyText,
    newsLinks: role === "bada_bhai" && tiles ? newsLinksOfMetadata(row.metadata) : null,
    createdAt: row.createdAt,
  });
}

/**
 * A stored Redis transcript as redraw lines, or none when the value is absent, unreadable, or
 * belongs to another worker (the buffer's own tripwire). The buffer is append-only, so its order
 * is the conversation's.
 */
export function linesOfBuffer(
  raw: string | null,
  workerId: string,
  sessionId: string,
  tiles: boolean,
): ProfilingChatLine[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const buffer = BufferViewSchema.safeParse(parsed);
  if (!buffer.success || buffer.data.workerId !== workerId) return [];
  const lines: ProfilingChatLine[] = [];
  buffer.data.messages.forEach((value, index) => {
    const line = BufferedLineViewSchema.safeParse(value);
    if (!line.success) return;
    const createdAt = new Date(line.data.at);
    if (Number.isNaN(createdAt.getTime())) return;
    const role = line.data.role === "worker" ? "worker" : "bada_bhai";
    const shown = displayLine({
      id: opaqueLineId(`chat-transcript-line:${sessionId}:${index}`),
      sessionId,
      role,
      raw: line.data.text,
      newsLinks: role === "bada_bhai" && tiles ? narrowNewsLinks(line.data.newsLinks) : null,
      createdAt,
    });
    if (shown !== null) lines.push(shown);
  });
  return lines;
}

/**
 * An opaque, stable RFC 4122-shaped id for a line: the same seed always gives the same id, and it
 * never exposes the row id it was derived from (CLAUDE.md §9). A line still in the Redis buffer is
 * seeded by its session and position, so its id changes once the session is flushed to rows: an
 * id is stable within one read, not a key to dedupe by across opens.
 */
export function opaqueLineId(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Pack copy as the worker may see it: the vocative and every other template token removed. */
export function displayText(raw: string): string {
  return raw.replace(WORKER_NAME_VOCATIVE, "").replace(ANY_TEMPLATE_TOKEN, "").trim();
}

function displayLine(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly role: "worker" | "bada_bhai";
  readonly raw: string | null;
  readonly newsLinks: FreeChatNewsLink[] | null;
  readonly createdAt: Date;
}): ProfilingChatLine | null {
  if (input.raw === null) return null;
  // The worker's own words are shown exactly as typed; only Bada Bhai's copy carries tokens.
  const text = input.role === "worker" ? input.raw.trim() : displayText(input.raw);
  if (text.length === 0) return null;
  const tts = input.role === "bada_bhai" ? ttsField(input.raw).tts_text : undefined;
  const ttsText = tts === undefined ? "" : displayText(tts);
  return {
    id: input.id,
    sessionId: input.sessionId,
    role: input.role,
    text,
    ...(ttsText.length > 0 ? { ttsText } : {}),
    ...(input.newsLinks !== null && input.newsLinks.length > 0 ? { newsLinks: input.newsLinks } : {}),
    createdAt: input.createdAt,
  };
}

/** Oldest first. STABLE, so lines that share a timestamp keep each source's own order. */
function byTime(lines: readonly ProfilingChatLine[]): ProfilingChatLine[] {
  return [...lines].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * Only the chats the worker actually took part in: a session with no line of theirs in the window
 * (a stray empty mint, an opening question never answered) is not a conversation to show.
 */
export function chatsTheWorkerSpokeIn(lines: readonly ProfilingChatLine[]): ProfilingChatLine[] {
  const spoke = new Set(lines.filter((line) => line.role === "worker").map((line) => line.sessionId));
  return lines.filter((line) => spoke.has(line.sessionId));
}
