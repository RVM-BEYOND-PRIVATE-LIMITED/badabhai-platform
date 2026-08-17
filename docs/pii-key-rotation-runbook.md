# PII Key Rotation Runbook

Reconstructed from `packages/db/src/reencrypt-pii-backfill.ts`'s own header/inline comments
(TD22-2) and `packages/config/src/server.ts`'s keyring validation (TD22-1) — the file was
deleted in the 2026-08-05 docs purge (`eb151468`) but is still cited 3 times, by name, from the
live backfill script that performs the rotation (`docs/audit/22_REMEDIATION_BACKLOG.md` BL-20,
`docs/audit/24_RISK_REGISTER.md` R46).

## What this covers

Rotating the AES-256-GCM key that encrypts at-rest PII columns (`workers.phone_e164`/`full_name`,
`payers.email_enc`/`phone_enc`/`org_name_enc`, `payer_orgs.name_enc`, `payer_members.email_enc`,
`agency_kyc.pan_enc`/`bank_account_enc`/`ifsc_enc`/`account_holder_name_enc`,
`admin_users.email_enc`) — the same crypto that `docs/decisions/0004-pii-at-rest-and-rls.md`
defines. It does **not** cover `PII_HASH_PEPPER` (the keyed HMAC pepper used for phone/IP
hashing) — that is a separate secret with no keyring/rotation mechanism in this codebase;
rotating it would invalidate every existing hash lookup and is out of scope here.

## The two-generation model (TD22-1 / TD22-2)

There are two distinct env-var shapes, and understanding the difference is the whole runbook:

- **Legacy, single-key (`PII_ENCRYPTION_KEY`)** — the original, pre-rotation scheme. Every
  environment still needs this set (`assertPiiCryptoConfig` requires it outside dev/test), because
  it is the ONLY way to decrypt any row still on a legacy `v1...` token.
- **Keyring (TD22-1: `PII_ENCRYPTION_KEYS` + `PII_ENCRYPTION_ACTIVE_KID`)** — an **opt-in**,
  both-or-neither pair:
  - `PII_ENCRYPTION_KEYS` — a JSON object mapping a key id ("kid", 1–32 chars of
    `[A-Za-z0-9_-]`, dot-free) → a base64-encoded 32-byte AES-256 key.
  - `PII_ENCRYPTION_ACTIVE_KID` — the kid **new writes** are minted under (must be a key present
    in `PII_ENCRYPTION_KEYS`).
  - Once set, new ciphertext is written as `v2.<activeKid>.<iv>.<tag>.<ciphertext>` (all
    base64-encoded parts). `decryptPiiWithKeyring` (`packages/db/src/crypto.ts`) reads **both**
    formats — legacy `v1...` (via the single `PII_ENCRYPTION_KEY`) and any `v2.<kid>...` whose kid
    is still present in the keyring — so old rows keep decrypting indefinitely without a backfill.
  - Both vars are validated **fail-closed at boot** by `assertPiiCryptoConfig`
    (`packages/config/src/server.ts`) — half-set (`KEYS` without `ACTIVE_KID` or vice versa), an
    empty string, a malformed JSON object, a duplicate top-level kid, an invalid kid shape, a key
    that is not base64-of-exactly-32-bytes, an all-zero key, or an active kid absent from the map
    all refuse to boot with a named error — never a silent partial rotation.

**Rotating a key means: (1) add the new kid to the keyring so new writes use it, then (2)
backfill every row still on an old kid/legacy token onto the new one, so the old kid can
eventually be retired.** Steps below.

## Step 1 — introduce the new key (no backfill yet)

1. Generate a fresh 32-byte key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Choose a new kid (e.g. a date-stamped tag like `k2026b`) — must match `[A-Za-z0-9_-]{1,32}`.
3. Set `PII_ENCRYPTION_KEYS` to a JSON object containing **both** the old kid(s) still needed to
   decrypt existing rows and the new kid, and set `PII_ENCRYPTION_ACTIVE_KID` to the **new** kid.
   `PII_ENCRYPTION_KEY` (the legacy single key) stays set unchanged — it is still required to
   decrypt any row that predates the keyring opt-in entirely.
4. Deploy this env change. From this point, **every new write** encrypts under the new kid; every
   existing row keeps decrypting under whichever kid/format it was already on (`decryptPiiWithKeyring`
   is read-both by design) — this step alone is fully backward compatible and requires no downtime
   or backfill to be safe.
5. This step is a **CLAUDE.md §7 human sign-off, staging-first** change (env/secret rotation,
   same class as any other production secret change) — not a code deploy, so it goes through
   whatever secret-provisioning path the environment uses (Lightsail box env / GitHub Environment
   secret), never a committed file.

## Step 2 — backfill existing rows onto the new active kid (TD22-2)

The backfill runner is `packages/db/src/reencrypt-pii-backfill.ts`
(`pnpm --filter @badabhai/db db:reencrypt:pii`).

**Guards (all enforced in code, not just convention):**

- **Dry-run is the default.** Classifying a token as "needs rotation" vs. "already current" is a
  string-prefix check (`v2.<activeKid>.`) — **no decrypt call happens** in dry-run. Only
  `--apply` decrypts + re-encrypts + writes, one row at a time, dropping the plaintext reference
  immediately after use.
- **Refuses `NODE_ENV=production` outright.** There is no override for this half of the gate — it
  must be run with a different `NODE_ENV` value pointed at the production `DATABASE_URL` (the
  same posture the migration/ops scripts in this family use).
- **`--apply` additionally requires `PII_REENCRYPT_CONFIRM=yes-reencrypt-prod-data`** — a second,
  deliberate key so a real rotation run can never be a one-flag accident. This is the CLAUDE.md
  §7 human sign-off gate made mechanical.
- **Optimistic concurrency:** each row update is `WHERE id = ? AND <column> = ?` (the value read
  at select time) — a row that changed between read and write is safely **skipped**, never
  clobbered, and is picked up by re-running.
- **Resumable:** safe to stop and re-run at any time. Rows already on the active kid are always
  skipped, so a re-run only ever does the remaining work.
- **PII-free logging:** every log line carries only a table name, column name, row id, and/or
  counts — never a plaintext value or a ciphertext token.

**Procedure:**

```bash
# 1. Dry run first — always. Prints per-table counts (total / already-current / needs-rotation),
#    touches nothing.
pnpm --filter @badabhai/db db:reencrypt:pii

# 2. Optionally scope to specific tables while validating the dry-run output:
pnpm --filter @badabhai/db db:reencrypt:pii --table=workers,payers

# 3. Apply (staging first, per CLAUDE.md §7). Requires the keyring env vars from Step 1
#    PLUS the legacy PII_ENCRYPTION_KEY PLUS the confirm token:
PII_REENCRYPT_CONFIRM=yes-reencrypt-prod-data \
  pnpm --filter @badabhai/db db:reencrypt:pii --apply

# 4. Optional tuning:
#    --batch-size=<n>   default 500, rows fetched per page per table
#    --table=<name>[,<name>...]   scope to specific tables
```

The summary printed at the end reports, per `table.column`: total rows scanned, rows already
current, rows that needed rotation, and (apply mode only) rows actually rotated / skipped on a
concurrent write / failed to decrypt. A decrypt failure logs the row id and is **not** retried
automatically — investigate manually before re-running (a systematic decrypt failure across many
rows likely means a wrong/missing old kid in the keyring, not a one-off bad row).

## Step 3 — retire the old kid

Only once `db:reencrypt:pii` (no `--table` filter) reports **zero** `needsRotation` across every
target does removing the old kid from `PII_ENCRYPTION_KEYS` become safe — before that, any row
still on the old kid/legacy token becomes permanently undecryptable the moment its key is removed.
There is no automated check that gates this step; it is a manual read of the dry-run summary
before editing the secret.

**Do not remove `PII_ENCRYPTION_KEY` (the legacy single key)** as part of a keyring rotation
unless a full-table dry run also confirms zero rows remain on the legacy `v1...` format — it is a
structurally different check from "zero rows need rotation onto the *current* kid" (a row already
on a *non-active* v2 kid also reports `needsRotation`, conflating the two). Read the per-table
`malformed`/`decryptFailed` counts, not just `alreadyCurrent`, before concluding legacy rows are
gone.

## What this runbook does not cover

Rotating `PII_HASH_PEPPER` (no rotation mechanism exists for it in this codebase — see above);
rotating `PIN_PEPPER`, `JWT_SECRET`, or `ADMIN_JWT_SECRET` (different secrets, different
invalidation blast radius — not PII-at-rest keys, out of scope for this specific runbook);
provisioning the keyring secret itself in a given environment's secret store (Lightsail box env
vs. a GitHub Environment secret — see `docs/rollback-guide.md` and `docs/github-actions.md` for
how each environment's secrets are wired).
