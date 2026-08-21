# PII Crypto Posture — Pepper Rotation & Crypto-Shred

## Pepper rotation posture

`PII_HASH_PEPPER` is the HMAC key for `hashPhone` (→ `phone_hash`, the dedup key on
`workers.phone_hash`) and `hashIp` (→ consent/audit IP digests). It is
**effectively not rotatable**. Three independent constraints make rotation
destructive:

1. **`hashIp` digests are forever unverifiable after re-pepper.** The raw IP is
   never stored — only its HMAC-SHA256 digest. After a pepper change, a new
   `hashIp(old_ip, new_pepper) != hashIp(old_ip, old_pepper)`, so every existing
   digest becomes a lookup miss: the app can no longer tell whether a given IP
   was previously seen. There is no stored plaintext to re-hash.

2. **Historical event `phone_hash` in the audit spine stops matching
   `workers.phone_hash`.** Shipped event payloads (e.g. `worker.otp_send_failed`
   carrying `phone_hash`) are never mutated (invariant #8). After a pepper
   change, `workers.phone_hash` is re-computed under the new pepper, so it no
   longer matches the `phone_hash` in any pre-rotation event. The audit spine
   becomes un-correlatable on the phone dimension.

3. **No re-hash source exists.** There is no stored plaintext phone or IP
   column that a backfill could re-hash under a new pepper. The ciphertext
   (`phone_e164` etc.) is AES-256-GCM encrypted, not hashed — and even if one
   decrypted every phone to re-hash, event payloads cannot be retroactively
   updated (invariant #8).

**Conclusion:** Treat `PII_HASH_PEPPER` as a permanent, long-lived secret.
Choose it once, protect it at rest, and never rotate it. If compromise is
suspected, the only honest response is a DPDP-breach disclosure — rotation
would silently destroy the correlation integrity of the audit spine and the
consent/IP dedup mechanism with no way to verify completeness.

## Crypto-shred procedure

Crypto-shred makes PII unrecoverable by **destroying the encryption key**
rather than deleting every ciphertext row. BadaBhai has two tiers:

### Tier 1: Per-worker DSAR erasure

A single worker's PII is erased via the existing **account-deletion sweep**
(ADR-0031 / PR #169):

1. Worker requests deletion (or ops triggers it via admin endpoint).
2. A 7-day grace window is set (`workers.marked_for_deletion_at`).
3. The `account-deletion` BullMQ processor (`AccountDeletionSweepProcessor`)
   runs hourly, hard-deleting rows past the grace window across the `workers`,
   `worker_consents`, `chat_sessions`, `chat_messages`, `voice_notes`,
   `worker_profiles`, `generated_resumes`, and related tables.
4. Events remain in the `events` spine (PII-free by construction, invariant #2)
   for audit integrity.

This path does NOT require key destruction — it deletes the rows that
reference encrypted PII. See `docs/worker-account-deletion-runbook.md`.

### Tier 2: Bulk crypto-shred (break-glass)

To make ALL PII under a given encryption key unrecoverable at once:

1. **Remove the key from `PII_ENCRYPTION_KEYS`** (the JSON
   `kid→base64-32B-key` map) and **remove that kid from
   `PII_ENCRYPTION_ACTIVE_KID`** if it was the active writer.
2. **Restart the API.** `PiiCryptoService` will fail to decrypt any row
   bearing that kid's `v2.<kid>...` token, throwing a constant `unknown PII
   key id` error (no kid echo, no known-kid enumeration, §2). Every affected
   read path (login, resume generation, payer contact reveal) will fail
   closed.
3. **Retain the key offline** (sealed backup) in case a lawful data recovery
   order requires it. DPDP does not require that crypto-shred be irreversible
   to the operator — only that the data is not routinely accessible.

**Important:** With a single shared kid (current Phase 1 posture), bulk
crypto-shred is an all-or-nothing lever — it erases EVERY worker's PII
simultaneously. Per-worker DSAR erasure (Tier 1) is the correct path for
individual rights requests. Bulk crypto-shred is reserved for:
  - DPDP breach response where the key is suspected compromised.
  - End-of-life data retirement (shutting down the service).

### What crypto-shred does NOT cover

- **Hashed values** (`phone_hash`, IP digests) are NOT encrypted — they are
  HMAC-SHA256 digests. Dropping the pepper does not "shred" them: the digests
  remain in the DB and events spine, they just become un-correlatable. True
  erasure of hashed values requires deleting the rows that carry them (Tier 1).
- **Append-only events spine.** Events carry no PII (invariant #2) and are never
  deleted. Crypto-shred does not affect them.
- **Human-authored free text**, which is stored in **plaintext** and therefore has no
  key to destroy: `voice_notes.transcript_text`/`transcript_english` and
  `chat_messages.body_text` (PII there is incidental — **R12**), and
  `worker_feedback.message` (#997), where it is expected rather than incidental: the
  worker is writing to us on purpose and may include their own name, employer or
  number, and an admin has to be able to read it, so putting it under a crypto
  envelope would defeat the feature rather than protect it. Tier 2 is not a lever on
  any of these. Tier 1 — deleting the rows, which the `ON DELETE cascade` from
  `workers` does for `worker_feedback` with no code of its own — is the only erasure
  path they have. Contained meanwhile by the same RLS+REVOKE lockout as every other
  spine table; a backend, backup or DB-level read still sees the plaintext.
