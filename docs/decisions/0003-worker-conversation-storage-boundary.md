# ADR 0003 — Worker-Conversation Archival Storage Boundary

- **Status:** Accepted
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
