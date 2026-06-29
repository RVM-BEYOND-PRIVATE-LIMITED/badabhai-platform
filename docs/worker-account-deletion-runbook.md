# Runbook — Worker Account Deletion (DPDP erasure)

> ADR-0026 Phase 5. Worker-initiated, **irreversible** erasure of a worker's raw PII.
> Flow: `POST /auth/account/delete/request` → step-up OTP → `POST /auth/account/delete/confirm`.
> **The executed deletion has NO undo.** Only the endpoint/migration PRs are revertable.

## 1. Purpose & scope
- DPDP right-to-erasure for a worker who asks to delete their account.
- **Destroys (irreversible):** the `workers` row (raw phone/name ciphertext) + all `ON DELETE CASCADE`
  PII children — `worker_consents`, `worker_devices`, `worker_credentials` (PIN), `worker_profiles`,
  `chat_sessions`, `chat_messages`, `voice_notes`, `generated_resumes`, `worker_answers`, `applications`,
  `resume_downloads`, `worker_flags` — plus Supabase Storage objects (resume PDFs + archived conversations).
- **Retains (PII-free, lawful):** the `events` + `audit_logs` spine (opaque ids, no FK to `workers`) and the
  three billing/intent rows whose worker FK is `SET NULL` on delete — `unlocks` (paid contact-unlock),
  `resume_disclosures`, `invites.inviter_worker_id`. These carry no PII once the worker join is nulled.

## 2. Preconditions (before this runs in any non-local env)
- [ ] Migration **0031** (3 billing FKs `cascade → SET NULL` + nullable) **signed off (Prakash/Akshit) and
      applied** — else worker deletion would DESTROY paid-unlock / disclosure / referral rows. This is the §7 gate.
- [ ] `worker.account_deleted` event registered + deployed (event-first spine).
- [ ] `StorageService.deletePdf` / `deleteByPrefix` deployed.
- [ ] OTP path healthy (Fast2SMS reachable + Redis up) — step-up OTP must work or `/confirm` fails closed.

## 3. Normal (worker-driven) flow
1. Worker (authenticated) calls `POST /auth/account/delete/request` → receives an OTP on their phone.
2. Worker calls `POST /auth/account/delete/confirm` with the OTP → `204`.
3. No operator action. Verify via the emitted `worker.account_deleted` event (see §5).

## 4. Operator-assisted / DSAR-by-ticket flow
- For a worker who cannot self-serve (lost device, support ticket):
  - Authorization required from **Prakash/Akshit** (named approver recorded in the ticket).
  - Execution against prod is a **human-gated** step — the endpoint still requires the worker's own step-up OTP;
    do not bypass it. Record the approver + ticket id in the ops log.

## 5. Verification checklist (post-deletion)
- [ ] `workers` row gone (`SELECT … WHERE id = :id` → 0 rows).
- [ ] Cascade children gone — spot-check `worker_profiles`, `chat_messages`, `generated_resumes`, `worker_credentials`.
- [ ] Storage empty — `conversationWorkerPrefix(:id)` lists 0 objects; the captured resume keys 404.
- [ ] Billing rows SURVIVE with the worker FK NULL — `unlocks.worker_id`, `resume_disclosures.worker_id`,
      `invites.inviter_worker_id`.
- [ ] `worker.account_deleted` event present with `storage_objects_failed = 0` (see §6 if > 0).
- [ ] Redis cool-down key `deleted_phone:<phone_hash>` set (blocks immediate re-registration churn).
- [ ] No session can re-auth the deleted worker (revoke ran first).

## 6. Partial-failure recovery
- The orchestration is **idempotent / re-runnable** — re-invoking on a gone worker is a no-op.
- If the event shows `storage_objects_failed > 0`: an object/prefix delete failed (orphan keyed by an opaque
  UUID, non-PII-linkable). Re-run a storage sweep for the worker's conversation prefix + captured resume keys.
- The DB erasure is atomic (single transactional `DELETE` + cascade) — it either removed identity or did not;
  a storage hiccup never leaves the worker half-deleted in the DB. Revoke-sessions runs first, so a partially
  failed run never leaves a re-authable deleted worker.

## 7. Rollback-impossibility note
- The executed cascade has **no undo** — there is no "restore worker" path. Raw phone/name ciphertext is gone.
- Only the **endpoint PR** and the **0031 migration** are revertable (reverting 0031 requires that no billing
  row currently holds a NULL worker FK — see the migration's inline `-- ROLLBACK:` note).
- This irreversibility is WHY the gate is strong: step-up OTP + two-step request/confirm + human-gated prod runs.

## 8. Audit trail (what survives, and why it is lawful)
- The PII-free `events` (`worker.account_deleted` + the worker's prior opaque events) and `audit_logs` survive —
  opaque ids only, no raw PII. DPDP permits retaining a non-identifying record of processing.
- The `SET NULL`'d billing/intent rows record THAT a paid unlock / disclosure / referral occurred, with no
  worker identity attached — a legitimate financial-record interest, PII-free.
