# ADR-0059: The Bada Bhai chat shows the profiling conversation

- **Status:** Accepted. Owner rulings by Divyanshu, 2026-10-21. Live on merge, with no flag and no migration.
- **Date:** 2026-10-21
- **Owner:** Divyanshu (Backend Platform)
- **Tracking:** #2391 (API); #2392 (worker app, Rishi)
- **Amends:**
  - [ADR-0044](0044-post-completion-chat-companion.md) **R4** ("the old interview transcript is not redrawn for a companion worker; the recap is the opening"). Overridden: the profiling chat is drawn, and the recap opens the tab only when there is no conversation to show.
  - [ADR-0056](0056-bada-bhai-chat-history.md) **H2/H3**. The 7-day window now covers the profiling chat too. The recap is no longer stored as the first line of the conversation.
- **Relates:**
  - [ADR-0047](0047-lift-pii-restriction.md): the worker's own words, shown back to the worker.
  - [ADR-0055](0055-bada-bhai-chat-free-chat-brain.md): untouched. The brain's model inputs are unchanged.

## 1. Context

A worker builds a profile by chat: typed answers, chips tapped, Bada Bhai's questions and replies. Then they land on the Bada Bhai chat tab. There they saw only the recap, the profile-summary bubble. The conversation they had just had was gone from the screen.

That was the design:

- ADR-0044 R4 replaced the transcript with the recap.
- ADR-0056 kept 7 days of the Bada Bhai chat's own lines only (`companion_messages`), with the stored recap as the first line.

The profiling lines live in `chat_messages`, or in the session's Redis transcript while it is still open. The companion never read them.

## 2. Rulings (owner, 2026-10-21)

| # | Ruling |
|---|---|
| **P1** | **The conversation is always on the Bada Bhai chat, for the last 7 days.** The tab shows the profiling chat, then an "End of conversation" divider, then the Bada Bhai chat messages. |
| **P2** | **Every profiling chat counts:** finished, quit midway, finished early ("Phir bhi profile banaiye"), and every redo. They are shown in time order with the Bada Bhai chat lines. Each profiling chat ends with its own divider. |
| **P3** | **The recap shows only when there is nothing to show** (no line of either kind in the last 7 days). While a profiling chat is the newest thing on screen, the recap's chips (jobs and the menu) still sit under the last line. |
| **P4** | **Display window only.** Nothing is deleted. `chat_messages` is the extraction transcript, the résumé's quote source and the admin journey's record, and it is kept as before. |

## 3. Design

**Read (`ProfilingChatLinesReader`, `apps/api/src/chat/`).**

- It runs two SELECTs on the @Global database handle (the leaf `profiling-chat-lines.query.ts`):
  - the worker's `chat_messages` after the window start, newest 400, in `ChatRepository.listMessages`' order (`created_at DESC, direction DESC`, so a shared timestamp puts the worker's line first). A row written into a session after it closed is left out: the review screen's spoken correction (#1272) appends one to the finished session for extraction, and it was never part of the chat;
  - the worker's `active` session ids (at most 3).
- For those live sessions it runs one `MGET` of their Redis transcripts, under `withinRedisDeadline`. A live session's buffer replaces its rows, exactly as `GET /chat/sessions/:id/messages` prefers it.
- Each line is shown as the redraw shows it:
  - the `{{worker_name}}` vocative is removed, and no name is decrypted;
  - the Devanagari twin rides a Bada Bhai line that has one;
  - news tiles are kept unless `CHAT_FREE_CHAT_DISABLED` is set;
  - a voice row with no transcript yet, a blank line and a name-only line are dropped;
  - a line's `id` is opaque: a hash of the row id (or, for a buffered line, of its session and position), never the row id itself (CLAUDE.md §9). It is stable within one read, not across a flush.
- A session with no worker line in the window is not a conversation and is left out.
- It reports `truncated` when the window held more lines than it returned.
- It is read-only by construction. It holds no `ChatRepository` and no `ChatTranscriptBuffer` instance; from the buffer's file it takes only the pure key and the pure news-tile narrowing. The companion's boot test pins the file.
- It fails soft. A failed database read means no profiling chat, and the recap is drawn. A failed or slow Redis read drops only the live sessions.

**Compose (`composeConversation`, pure).**

- It merges both sources oldest first. The sort is stable, and on an exact tie the profiling line comes first.
- It marks each profiling chat's last line with `ends_profiling_chat: true`, so the app draws the divider after it.
- **No gap.** Each source is read with its own limit (the Bada Bhai chat's newest 200, the profiling chat's newest 400). When either returned only its newest lines, every line older than its oldest is left out of both. The conversation then starts where the shorter view starts, and never skips lines one source could not return.
- It drops the recap stored before this ADR. A recap was stored only when the window held no line, so it is always the oldest line of any window it is in. A turn's reply always follows its worker line. So a `bada_bhai` line at the head of the stored lines is that recap, or a reply whose question the limit cut off, and either way it is dropped.
- It keeps at most 400 lines (the newest), and drops a line that fails the wire contract on its own.
- Chips:
  - the newest Bada Bhai chat reply's chips, which is the rule `history` already used;
  - when a profiling chat is newer than that reply (or there is none), the recap's chips instead (P3).

**Wire.** `GET /chat/companion` in companion mode gains an additive `conversation` field:

```
conversation?: {
  messages: Array<{
    id: string;                          // uuid
    source: "profiling" | "bada_bhai_chat";
    role: "worker" | "bada_bhai";
    text: string;
    tts_text?: string;
    read_aloud?: false;                  // a model-written Bada Bhai chat line
    news_links?: { title: string; url: string; site: string }[];
    ends_profiling_chat?: true;          // draw "End of conversation" right after this line
    created_at: string;                  // ISO
  }>;                                    // oldest first, 1..400
  suggested_options: { option_key: string; label_text: string; is_none_of_above: boolean }[];
  suggested_followups: string[];
}
```

- The field is absent when the window holds nothing; the app then draws the recap, which is still on the response.
- It is checked against its own schema: a conversation that fails is left out, never the open.
- `history` is built exactly as before. An app that predates `conversation` keeps drawing `history` or the recap; §5 has the one difference it sees.

**Write.** The recap is no longer stored (`keepRecap` and the repository's `appendIfNoneSince` are removed). It is never a line of a conversation, and an open writes nothing. The recap rows already stored age out of the 7-day window and are removed by the existing sweep.

## 4. Invariants

- **The companion writes no chat row.** The reader reaches no writer. The egress guard is unchanged, and the new pin covers the reader's source.
- **Events.** None added. The open is a read, and it already records `chat.companion_turn_served` v1 with counts only. The payload is unchanged.
- **Privacy (ADR-0047).**
  - The lines are the worker's own conversation, returned to the worker over the authenticated `GET /chat/companion`. The same data `GET /chat/sessions/:id/messages` already serves.
  - No name is decrypted, because the vocative is stripped.
  - Logs carry ids and closed reasons only.
- **AI.** No model reads the profiling lines through this path. The brain's inputs are unchanged.
- **Backward compatibility.** The change is additive on the wire. No schema change, no migration, no event change.

## 5. Consequences

- **Old app builds** read `history` and the recap, as before. One thing changes for them: a first open no longer stores the recap, so a reopen with Bada Bhai chat lines draws them without a recap at the top. That matches P3.
- **The worker app** must draw `conversation` instead of `history` and the recap when it is present (#2392, Rishi). Until it does, workers see no profiling chat.
- **Cost.** Each open adds two indexed reads and at most one bounded `MGET`. The Bada Bhai chat lines ride twice, in `history` (for old apps) and in `conversation`.
- **Known limits.**
  - A chat whose opener is rendered by the app only (the canned greeting, or the flag-gated one-shot opener) starts at the worker's first message. That opener is never stored.
  - A profiling chat that began more than 7 days ago shows only its lines from inside the window, by the same per-line rule as ADR-0056 H2.
  - The profiling chat's model-written free-chat replies carry no `read_aloud: false`, the same as the existing thread redraw (`GET /chat/sessions/:id/messages`).
