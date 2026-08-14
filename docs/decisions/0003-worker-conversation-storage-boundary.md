# ADR 0003 — Worker-Conversation Archival Storage Boundary

- **Status:** **Withdrawn (2026-08-14)** — never built; the archival tier is retired
  rather than completed. The decision below is preserved as the record of what was
  decided on 2026-06-10 and why it was not carried out. See
  [Withdrawal](#withdrawal-2026-08-14) at the foot of this document.
- **Date:** 2026-06-10
- **Phase:** 1 (Worker Profiling)
- **Relates to:** ADR-0001 (locked stack: Supabase), the `voice_notes.storage_path`
  pattern, invariant §2 (no raw PII leaves its boundary), §6 (DPDP consent gate)

## Context

The interview chat produces, per session, a full transcript plus a final
conversation-state snapshot. We want to retain that complete JSON as a durable
archival/training artifact, but the relational tables must stay the queryable,
event-emitting source of truth the ops console reads.

A private Supabase Storage bucket (`worker-conversations`) has been provisioned
for this. The free text in these JSON objects can contain raw PII (a worker may
type their phone/name/employer), so the bucket is the **same trust tier as
`voice_notes`**: backend service-role only, never reachable by the web or
worker-app clients.

This is a new storage boundary, hence an ADR. It reuses an existing stack
component (Supabase) — it is **not** a new datastore or framework.

## Decision

1. **Hybrid, not a replacement.** Postgres stays the spine. `chat_sessions` +
   `chat_messages` remain the queryable, event-emitting truth the ops console
   reads — they are **not** dropped. The bucket is an *artifact store* alongside
   the relational data, exactly like `voice_notes.storage_path` references audio
   today.

2. **Conversation state stays in Postgres.** The per-turn `conversation_state`
   read on every interview turn stays in Postgres (a column on `chat_sessions`),
   not the bucket — a bucket round-trip per message would add latency. *(That
   column is part of the chat-persistence / state-threading wiring and is owned
   by that work, not this ADR.)*

3. **The bucket holds the full conversation JSON** (complete transcript + final
   state snapshot) as an archival/training artifact, referenced by an opaque
   `conversation_storage_path` on `chat_sessions` (added here, nullable,
   backward-compatible — migration `0002`).

4. **Access mode A — Supabase Storage client, no new secrets.** Backend reaches
   the bucket via the Supabase Storage API using the existing `SUPABASE_URL` +
   `SUPABASE_SERVICE_ROLE_KEY`. The bucket name is configured as
   `CONVERSATIONS_BUCKET` (server env, default `worker-conversations`,
   backend-only). The S3-protocol path (separate access keys) was **not** chosen —
   it adds a new key surface for no Phase-1 benefit.

5. **Frozen object-key contract.** Object keys are built **only** by
   `conversationObjectKey` / `conversationWorkerPrefix` in
   [`@badabhai/validators`](../../packages/validators/src/index.ts):

   ```
   <bucket = CONVERSATIONS_BUCKET>/<worker_id>/<session_id>/v<version>.json
   ```

   The key carries opaque UUIDs + an integer version only. The helpers **fail
   closed** (throw) if an id is not a UUID, so PII can never become a path.
   Namespacing by `worker_id` makes per-worker deletion a single prefix op for
   DPDP erasure.

## Guardrails (enforced)

- **Private bucket; backend/service-role only.** Never exposed to web/Flutter; no
  anon/public access. Same trust tier as `voice_notes`.
- **No PII in the path.** Keys are opaque UUIDs only, enforced in code by the
  validators helpers (fail closed on non-UUID input).
- **Reference, never content, in the spine.** `events`, `ai_jobs`, `audit_logs`,
  and logs reference `conversation_storage_path` (and ids) — **never** the JSON
  body. (Invariant §2.)
- **Pseudonymization is unchanged.** The bucket is storage, never a path into the
  model. Pseudonymization still runs before any external LLM call; storing raw
  conversation JSON in a backend-only bucket does not relax that gate.
- **DPDP erasure.** On consent revoke, every object under
  `conversationWorkerPrefix(worker_id)` is deletable in one prefix sweep.

## Scope of this ADR vs. deferred wiring

**Delivered with this ADR (the foundation/contract):**

- `CONVERSATIONS_BUCKET` server config + `.env.example`.
- Nullable `conversation_storage_path` on `chat_sessions` + migration `0002`.
- The frozen object-key contract + per-worker prefix helpers (tested).

**Deferred to the chat-persistence wiring (not this ADR):**

- The backend Supabase Storage client/service that performs the actual
  `put` / signed-read / prefix-`delete` against the bucket (introduces
  `@supabase/supabase-js`; lands when it is exercised and tested end-to-end).
- Writing the conversation JSON on session archival and reading it back.
- The `conversation_state` column + per-turn threading.
- Wiring the prefix delete into the consent-revoke flow.

The wiring writes against the column, config, and key contract frozen here.

## Consequences

- **Positive:** event-first + the ops console stay intact; the bucket is durable
  JSON storage, not a relational replacement; the path contract is tested and
  PII-safe; per-worker DPDP deletion is trivial; no new secret surface (Mode A).
- **Negative / risks:** a second store to keep consistent with Postgres (the
  bucket is a best-effort archival mirror, not transactional); a new private
  bucket whose ACL must stay locked down (tracked as **R10** in the
  [risks register](../registers/risks-register.md)); raw PII at rest in the bucket
  means consent-revoke deletion must be wired before launch.

## Rollback

Additive and reversible. `conversation_storage_path` is nullable with no default;
rolling back is `ALTER TABLE chat_sessions DROP COLUMN conversation_storage_path;`
(no data migration, no dependents while the wiring is deferred). Config and helper
additions are inert until the wiring uses them.

---

## Withdrawal (2026-08-14)

**This ADR is withdrawn. The archival bucket is retired, not completed.**

Everything above describes a decision taken on 2026-06-10 whose deferred half was
never built. It is preserved verbatim because the *reasoning* still explains three
artifacts that exist in the tree today and would otherwise look unmotivated.

### What was actually built

Only the "foundation/contract" half of the scope split above ever landed, and all of
it is inert:

| Artifact | State |
| -------- | ----- |
| `CONVERSATIONS_BUCKET` server config + `.env.example` | Shipped |
| `chat_sessions.conversation_storage_path` (migration `0002`) | Shipped, **never written by any code path** |
| `conversationObjectKey` / `conversationWorkerPrefix` | Shipped + tested |
| The `worker-conversations` bucket itself | **Never provisioned** — the `insert` in `storage-buckets.sql` has always been commented out |
| The `put` / signed-read of conversation JSON | **Never written** |

So the bucket described in the Context section as "has been provisioned" was not,
and has held zero objects for its entire existence.

### Why it is withdrawn rather than finished

**The premise changed underneath it.** This ADR was written when the chat wrote rows
per turn and the relational tables were not a complete record. The chat-persistence
work that followed took a different shape: the in-flight interview buffers in Redis
and flushes **once, transactionally**, at completion — see
`apps/api/src/chat/chat-transcript.buffer.ts` and `ChatService.finalizeInterview`.

The consequence is that `chat_messages` is now *already* the complete, durable,
verbatim transcript of every finished interview, in Postgres, on the DSAR cascade,
RLS + REVOKE-locked. Decision 3 above — "the bucket holds the full conversation JSON
(complete transcript + final state snapshot)" — now describes **a second copy of data
Postgres holds in full**.

That copy is all cost and no capability:

- **It doubles the raw-PII surface.** A transcript can carry a phone, a name, an
  employer. Postgres holds one copy behind RLS and a FK cascade. The bucket would add
  a second behind an object ACL that can drift — which is precisely the exposure
  **R10** was raised about. Building it *creates* the risk; retiring it *removes* it.
- **It buys no query.** Nothing can be asked of the JSON blob that cannot be asked of
  `chat_messages` + `worker_pack_answers`, and those are indexed for it
  (`chat_messages_session_created_idx`).
- **The training-artifact goal is already served.** The relational rows are the
  extraction corpus today; the flush hands them to extraction directly.
- **It is a second store to keep consistent** — the ADR's own Consequences section
  names this ("a best-effort archival mirror, not transactional"). Consistency debt
  for a duplicate is a bad trade.

### What this changes in the tree

- **Removed:** `conversationObjectKey` + `ConversationObjectKeyParts` — dead code, no
  caller, and no future caller now.
- **Kept — deliberately:** `conversationWorkerPrefix` and `CONVERSATIONS_BUCKET`. They
  back a **live DSAR erasure leg**
  (`account-deletion.service.ts`, the `conversation_prefix` sweep). Removing an
  erasure leg to tidy up a retired feature would be a security regression, and the
  sweep costs one `list` call that 404s to `[]` on a bucket that does not exist. It
  stays as defence in depth.
- **Kept — deprecated, not dropped:** `chat_sessions.conversation_storage_path`.
  CLAUDE.md §3/§10 forbid removing production columns; the column is nullable, unread,
  and now carries a deprecation note in the schema rather than a `DROP`.
- **Unchanged:** the bucket stays unprovisioned. `storage-buckets.sql` now says
  *retired* rather than *provision when closing R10*.

### R10

**R10 is closed by this withdrawal** — see the
[risks register](../registers/risks-register.md). Its stated exit condition (the
consent-revoke prefix-delete) was independently met on 2026-07-27 (issue #260), and
the residual concern — raw conversation JSON at rest in a bucket — cannot occur in a
tier that will not be built.

### If archival is ever revived

Do not un-withdraw this ADR. Write a new one, because the justification has to be
rebuilt from a different starting point: Postgres already holds the complete
transcript, so a new archival tier must argue what it adds *beyond* a duplicate — and
must budget for the second erasure path and the ACL that R10 was raised about.
