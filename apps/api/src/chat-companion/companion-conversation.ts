import type { ProfilingChatLine } from "../chat/profiling-chat-lines.reader";
import { toWireNewsLinks } from "../profiling/free-chat/free-chat-news-links";
import {
  COMPANION_CONVERSATION_MAX,
  CompanionConversationItemSchema,
  type CompanionConversation,
  type CompanionConversationItem,
  type CompanionHistoryItem,
  type CompanionTurn,
} from "./chat-companion.dto";

/** What the conversation is composed from. */
export interface ConversationSources {
  /** Every profiling chat line in the window, oldest first (`ProfilingChatLinesReader`). */
  readonly profiling: readonly ProfilingChatLine[];
  /** The read of `profiling` returned only the newest lines of the window. */
  readonly profilingTruncated: boolean;
  /** The Bada Bhai chat's stored lines in the window, oldest first (`CompanionHistoryService`). */
  readonly chat: readonly CompanionHistoryItem[];
  /** The read of `chat` returned only the newest lines of the window. */
  readonly chatTruncated: boolean;
  /** The recap's chips — shown when a profiling chat is newer than every Bada Bhai chat reply. */
  readonly recap: Pick<CompanionTurn, "suggested_options" | "suggested_followups">;
}

/** One line on its way into the conversation, with what the chip rule needs to know about it. */
interface Entry {
  readonly at: number;
  readonly item: CompanionConversationItem;
  /** The stored Bada Bhai chat line it came from, for its chips; absent on a profiling line. */
  readonly chat?: CompanionHistoryItem;
  /** The profiling session it belongs to; absent on a Bada Bhai chat line. */
  readonly session?: string;
}

/**
 * THE BADA BHAI CHAT'S WHOLE CONVERSATION (#2391, owner rulings 2026-10-21, ADR-0059) — pure, no
 * I/O. The owner's rule: the conversation is ALWAYS on the Bada Bhai chat, for the last 7 days.
 *
 *   - EVERY PROFILING CHAT, then the Bada Bhai chat, in time order: a redo's chat sits where it
 *     happened. Each profiling chat's last line carries `ends_profiling_chat`, so the app draws the
 *     "End of conversation" divider after it.
 *   - NO GAP. Each source is read with its own limit. When one returned only its newest lines,
 *     every line older than the oldest of them is left out of BOTH, so the conversation starts
 *     where the shorter view starts instead of skipping the lines one source could not return.
 *   - NO RECAP LINE. The recap is shown only when there is nothing here (the caller sends no
 *     conversation at all then). A recap stored as a line before #2391 is left out.
 *   - THE CHIPS: the newest Bada Bhai chat reply's, exactly as the stored history drew them; but
 *     when a profiling chat is newer than every Bada Bhai chat reply, the recap's — the jobs and
 *     the menu the worker would have seen under the recap.
 *   - AT MOST {@link COMPANION_CONVERSATION_MAX} lines, the newest.
 *
 * Undefined when there is no line of either kind: the app then draws the recap.
 */
export function composeConversation(
  sources: ConversationSources,
): CompanionConversation | undefined {
  const profiling = sources.profiling.map(profilingEntry);
  const chat = withoutStoredRecap(sources.chat).map(chatEntry);
  const from = Math.max(
    sources.profilingTruncated && profiling.length > 0 ? profiling[0]!.at : -Infinity,
    sources.chatTruncated && chat.length > 0 ? chat[0]!.at : -Infinity,
  );
  // STABLE, profiling first: on an exact tie a profiling line keeps its place before a chat line.
  // A line off the wire contract is dropped ON ITS OWN, before the dividers are placed.
  const entries = [...profiling, ...chat]
    .filter((entry) => entry.at >= from)
    .filter((entry) => CompanionConversationItemSchema.safeParse(entry.item).success)
    .sort((a, b) => a.at - b.at)
    .slice(-COMPANION_CONVERSATION_MAX);
  if (entries.length === 0) return undefined;

  const lastOfChat = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (entry.session !== undefined) lastOfChat.set(entry.session, index);
  });
  const ends = new Set(lastOfChat.values());
  const messages = entries.map((entry, index) =>
    ends.has(index) ? { ...entry.item, ends_profiling_chat: true as const } : entry.item,
  );
  return { messages, ...chipsFor(entries, sources.recap) };
}

/**
 * The Bada Bhai chat's stored lines WITHOUT the recap. Until #2391 an open with nothing in the
 * window stored the recap bubble as a `bada_bhai` line of its own, and only then (`INSERT … WHERE
 * NOT EXISTS` a line in the 7 days before it). So a stored recap is always the OLDEST line of any
 * window it is in, and at most one is. A turn's reply always follows its worker line, so a
 * `bada_bhai` line at the head is that recap, or a reply whose question the read's limit cut off;
 * either way it is left out. Nothing stores a recap any more, so this only ever drops lines
 * written before #2391, until they leave the window.
 */
export function withoutStoredRecap(
  lines: readonly CompanionHistoryItem[],
): CompanionHistoryItem[] {
  return lines[0]?.role === "bada_bhai" ? lines.slice(1) : [...lines];
}

/** The chips under the last line: see {@link composeConversation}. */
function chipsFor(
  entries: readonly Entry[],
  recap: ConversationSources["recap"],
): Pick<CompanionConversation, "suggested_options" | "suggested_followups"> {
  const newestReply = lastIndexOf(entries, (entry) => entry.chat?.role === "bada_bhai");
  const newestProfiling = lastIndexOf(entries, (entry) => entry.session !== undefined);
  const reply = newestReply >= 0 ? entries[newestReply]!.chat : undefined;
  if (reply === undefined || newestProfiling > newestReply) {
    return {
      suggested_options: [...recap.suggested_options],
      suggested_followups: [...recap.suggested_followups],
    };
  }
  return {
    suggested_options: [...(reply.suggested_options ?? [])],
    suggested_followups: [...(reply.suggested_followups ?? [])],
  };
}

/** The index of the last entry that matches, or -1 (the ES2022 lib has no `findLastIndex`). */
function lastIndexOf(entries: readonly Entry[], matches: (entry: Entry) => boolean): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (matches(entries[index]!)) return index;
  }
  return -1;
}

function profilingEntry(line: ProfilingChatLine): Entry {
  const item: CompanionConversationItem = {
    id: line.id,
    source: "profiling",
    role: line.role,
    text: line.text,
    ...(line.ttsText === undefined ? {} : { tts_text: line.ttsText }),
    ...(line.newsLinks === undefined ? {} : { news_links: toWireNewsLinks(line.newsLinks) }),
    created_at: line.createdAt.toISOString(),
  };
  return { at: line.createdAt.getTime(), item, session: line.sessionId };
}

function chatEntry(line: CompanionHistoryItem): Entry {
  const item: CompanionConversationItem = {
    id: line.id,
    source: "bada_bhai_chat",
    role: line.role,
    text: line.text,
    ...(line.tts_text === undefined ? {} : { tts_text: line.tts_text }),
    ...(line.read_aloud === undefined ? {} : { read_aloud: line.read_aloud }),
    ...(line.news_links === undefined ? {} : { news_links: line.news_links }),
    created_at: line.created_at,
  };
  return { at: Date.parse(line.created_at), item, chat: line };
}
