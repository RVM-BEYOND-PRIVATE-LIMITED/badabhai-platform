# ADR-0056: The Bada Bhai chat keeps its conversation for 7 days

- **Status:** **Accepted — owner rulings of Divyanshu, 2026-10-15.** Live on merge, with no flag. The feature
  stays dormant until the owner applies migration 0135 in production (§6).
- **Date:** 2026-10-15
- **Owner:** Divyanshu (Backend Platform)
- **Tracking:** #2297 (API); #2298 (worker app, Rishi)
- **Relates:**
  - [ADR-0044](0044-post-completion-chat-companion.md): the companion. Until this ADR it stored nothing.
  - [ADR-0055](0055-bada-bhai-chat-free-chat-brain.md): the free-chat brain whose reply now reads this chat's
    own summary.
  - [ADR-0051](0051-profiling-stage-free-chat.md) §8: the rolling-summary machinery reused here.
  - [ADR-0047](0047-lift-pii-restriction.md): text at rest; name and phone stay encrypted in `workers` only.
  - [ADR-0031](0031-account-deletion-grace-window.md): account deletion, which removes this history by cascade.

---

## 1. Context

The Bada Bhai chat (the companion, `/bada-bhai`) never stored its messages. Its AI memory was six turns in Redis
for 30 minutes. When the worker closed and reopened the app, the conversation was gone and only the recap showed.

## 2. Rulings (owner, 2026-10-15)

| # | Ruling |
|---|---|
| **H1** | **History on the server**, in a new table deleted with the account. It survives a reinstall or a new phone. |
| **H2** | **A 7-day window.** Every message of the last 7 days is shown; older ones drop off. With none left, the chat opens with the recap, as before. |
| **H3** | **On reopen within 7 days, only the old conversation is shown**, with no new recap bubble. The recap bubble served on the first open is stored, so it heads that conversation. |
| **H4** | **The AI keeps a rolling summary of the whole conversation, carried for 7 days.** The reply gets it with every query. The classifier never does (ADR-0051 R24). Recent turns come from the stored history, so the AI also remembers across an app restart. |

## 3. Design

**Storage (migration 0135).**

`companion_messages` stores one row per line as the app draws it:
- the worker's message, as sent (the chip label for a tap);
- Bada Bhai's reply, with its read-aloud twin, its "never read aloud" marker, its chips and its news tiles;
- the recap bubble described in H3.

A partial unique index on (worker, submission, role) makes a replayed submission write nothing. `model_context`
marks the lines a later model call may read. It is set exactly for the turns the Redis memory would have kept, so a
distress turn or a trash verdict never reaches a model again (ADR-0055 F3/F4).

`companion_conversation_summaries` holds one row per worker: the screened notes, and `folded_through`, the
watermark. Its `summary` may be null: that is the ADR-0051 §8 watermark-only record.

Text is stored at rest unencrypted, like `chat_messages.body_text`.

**Write.** After every served message turn, the service stores the worker's line and the reply exactly as served.
- It runs in the background, after the turn is computed. A failed write is logged with ids and a closed reason and
  never fails the turn.
- On an open that finds no line in the window, the recap bubble is stored (`INSERT … WHERE NOT EXISTS`). An open
  that finds lines stores nothing.

**Read.** `GET /chat/companion` gains `history`: the newest 200 lines of the last 7 days, oldest first.
- It is absent when there are none.
- The recap fields are still on the response, for older apps.
- The contract is in #2297 and #2298, and in `CompanionHistoryItemSchema`.
- `ChatCompanionPolicy` never reads these tables; the interview-mode decision is unchanged.

**Recent turns.** On the brain, a model call reads the last `CHAT_COMPANION_V2_MEMORY_TURNS` lines that are
marked `model_context`, from the 7-day window. If that read fails, it reads the Redis memory, which is still
written. The worker's own name is redacted by the model call, as before.

**Rolling summary.** After a turn's lines are stored, on the brain, a fold may run.
- **When.** It runs in the background, under the worker's own lock (`FreeChatFoldLock`, key
  `companion:fold:{workerId}`). It needs at least 4 `model_context` lines that are both outside the reply's
  six-turn window and newer than the watermark. It folds the oldest of them, at most 24.
- **The call.** It sends the previous summary and those lines through the armed `profiling_free_summary` task.
  The API screens the answer with `screenFreeChatSummary`: identifiers, template tokens, the note format, abuse,
  injection, the worker's own name, and the length. It then stores the summary monotonically.
- **Outcomes.**
  - A real call that answers nothing usable consumes the batch: the watermark moves and the previous text is kept.
  - A transport failure leaves the batch to retry.
  - Each fold emits `chat.companion_summary_updated` v1, with counts and a closed outcome only.

**Which summary the reply reads.**
- The reply reads this chat's own summary while it is live: the newest line it covers (`folded_through`) is in
  the 7 days before the turn.
- Otherwise it reads the profiling chat's summary, as before (ADR-0055 R4).
- A summary whose newest covered line has left the window has expired: it is ignored even if the worker writes
  again before the sweep runs (a fresh line never revives it), and the sweep deletes it.

**Retention.** `CompanionHistorySweepProcessor` (queue `companion-history-sweep`) runs daily.
- It deletes lines older than 7 days, in bounded batches, as a range over `companion_messages_created_at_idx`
  (migration 0135), so a tick costs the rows it deletes, never a scan of the table.
- It then deletes every expired summary (its `folded_through` has left the window).
- Nothing else deletes rows.

## 4. The kill switch

`CHAT_FREE_CHAT_DISABLED=true` takes the chat back to the v2 path (ADR-0055 §5).

**Decision: history still applies under the kill switch.** History is UI: what the worker said and was told. It
does not depend on the brain, so every turn is stored and `history` is returned as usual.

**Brain-only parts.** These two run only on the brain:
- the stored recent turns, so under the kill switch the v2 path reads the Redis memory, byte for byte as before;
- the rolling summary, both the fold and the reply's read of it.

## 5. Deploy-safe without a flag

Code auto-deploys on merge; the owner applies migrations by hand. So every read and write of the two tables
tolerates `undefined_table` (42P01).
- Until 0135 is applied, the chat stores nothing, returns no `history`, reads no companion summary, and reads
  recent turns from Redis. That is exactly the chat as it was before this ADR.
- Each API process logs one warn line saying so.
- Any other database error is also fail-soft: history is best-effort and never fails a turn.
- The sweep reports the tables missing instead of failing.

## 6. Erasure, privacy and the manual step

**Erasure.** Both tables cascade on `workers.id`. Account deletion (ADR-0031) hard-deletes the `workers` row, so
every stored line and the summary go with it. The migration test and the DB test pin the cascade.

**Privacy.** The stored lines are the worker's own words at rest, a new place PII may be written (ADR-0047 allows
it; named in #2297).
- Erasure reaches it by the cascade above.
- RLS is forced and every Data-API role is revoked.
- Logs carry ids and closed reasons only. A query error's bound parameters are redacted (`logSafeReason`).
- The event carries counts only.

**The manual step.** The owner applies migration 0135 in production, then adopts its ledger row. The order and
the rollback are in the migration header and in `MIGRATIONS.md`. No flag and no redeploy are needed: the next
request uses the tables.

## 7. Out of scope

- The worker app drawing `history` (#2298, Rishi).
- Storing the turns of the confirm and cancel edit routes (`POST /chat/companion/edits/:id/confirm|cancel`). Only
  `POST /chat/companion/message` turns and the recap are stored.
