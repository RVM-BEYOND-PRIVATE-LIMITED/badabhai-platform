# Runbook — PII Encryption Key Rotation (TD22)

> TD22-1 (keyring + v2 token format), TD22-2 (this runbook + the backfill runner), and
> TD22-3 (pepper posture, see [pii-crypto-posture.md](security/pii-crypto-posture.md)).
> Scope: the AES-256-GCM key that encrypts `phone_e164` / `full_name` / `*_enc` columns
> ([ADR-0004](decisions/0004-pii-at-rest-and-rls.md)). This is **NOT** about
> `PII_HASH_PEPPER` — the pepper is a separate secret and is **not rotatable** (see the
> posture doc; don't confuse the two).

## 1. Purpose & scope

AES keys should be rotated periodically or after a suspected compromise. BadaBhai's
key material lives only in backend config (never the DB), so rotation is: **mint a new
key → write new rows under it → re-encrypt old rows onto it → retire the old key.**
The runner in scope here is
[`packages/db/src/reencrypt-pii-backfill.ts`](../packages/db/src/reencrypt-pii-backfill.ts)
(`pnpm --filter @badabhai/db db:reencrypt:pii`) — step 3 below.

**Columns covered** (every `*_enc` / `phone_e164` / `full_name` column in `schema.ts`):
`workers.phone_e164`, `workers.full_name`, `payers.email_enc`, `payers.phone_enc`,
`payers.org_name_enc`, `payer_orgs.name_enc`, `payer_members.email_enc`,
`agency_kyc.pan_enc`, `agency_kyc.bank_account_enc`, `agency_kyc.ifsc_enc`,
`agency_kyc.account_holder_name_enc`, `admin_users.email_enc`. Adding a new encrypted
column later means adding one entry to `buildTargets()` in the runner — nothing else
in this runbook changes.

**Out of scope:** `PII_HASH_PEPPER` (permanent, see the posture doc),
`worker_credentials.pin_hash` (scrypt, not AES — there is no "key" to rotate, only a
pepper, same non-rotatable posture as `PII_HASH_PEPPER`).

## 2. Preconditions (before ANY step below runs against a shared/remote DB)

- [ ] **Named human sign-off recorded** (Prakash/Akshit) — this is a CLAUDE.md §7
      escalation gate (real secrets, touches every row of production PII). No step in
      this runbook may run against a shared/remote DB without it, regardless of how
      routine rotation becomes.
- [ ] Rotation reason logged (scheduled hygiene vs suspected compromise) — a
      suspected-compromise rotation additionally triggers the DPDP-breach process
      (see the posture doc §"Pepper rotation posture" for why partial secrets can't be
      silently rotated — the AES key CAN be rotated safely, unlike the pepper, but a
      compromise still requires disclosure, not just a quiet key swap).
- [ ] A recent, verified DB backup exists (standard precondition for any bulk PII write).
- [ ] Staging rehearsal completed (§3-§5 run once against staging with staging data)
      before the same steps touch production.
- [ ] The operator has `DATABASE_URL`, the CURRENT `PII_ENCRYPTION_KEY` (legacy) or
      keyring, and can mint a new 32-byte key (`openssl rand -base64 32`).

## 3. Procedure

### Step 1 — mint the new key, add it to the keyring (do NOT activate yet)

```bash
NEW_KEY=$(openssl rand -base64 32)   # never logged, never committed
```

Add the new kid to `PII_ENCRYPTION_KEYS` (JSON `kid -> base64 key` map) **alongside**
the existing kid(s) — do not remove any yet. Keep `PII_ENCRYPTION_ACTIVE_KID` pointed at
the OLD kid for now. Deploy this config change. Nothing behaviorally changes yet — reads
still decrypt correctly (`decryptPiiWithKeyring` reads every kid in the map), writes
still go under the old kid.

Pick a short, memorable kid convention, e.g. `k2026b` (year + letter) — 1-32 chars of
`[A-Za-z0-9_-]`, dot-free (`PII_KID_PATTERN` in `crypto.ts`).

### Step 2 — flip the active kid

Set `PII_ENCRYPTION_ACTIVE_KID` to the NEW kid (keep the old kid's key in the map — old
rows still need it to decrypt). Deploy. From this point, every NEW write mints a
`v2.<newKid>...` token; every EXISTING row still decrypts fine under its old kid via the
read-both path. **Zero rows have been touched yet.**

Verify: create/update one PII row (e.g. a test worker's `full_name` in staging) and
confirm its token now starts with `v2.<newKid>.`.

### Step 3 — run the backfill (dry-run first, always)

```bash
# Dry run — counts only, no writes, no decrypt calls at all:
pnpm --filter @badabhai/db db:reencrypt:pii

# Review the printed summary: "rotate" column = rows still on the old kid per table/column.
```

When ready to apply (staging first, then prod — each under its own sign-off per §2):

```bash
PII_REENCRYPT_CONFIRM=yes-reencrypt-prod-data \
  pnpm --filter @badabhai/db db:reencrypt:pii --apply
```

- The runner refuses to run at all with `NODE_ENV=production` set — this mirrors
  `retag-skills.ts`'s posture. Run it from an operator machine/bastion with
  `NODE_ENV` unset (or the environment's approved override), pointed at the target
  `DATABASE_URL` explicitly.
- It is **resumable** — safe to stop (Ctrl-C) and re-run; already-rotated rows are
  always skipped. If a run is interrupted, just re-run the same command.
- It is **safe under concurrent traffic** — each row update is optimistic-concurrency
  guarded (`WHERE id = ? AND col = ?`); a row that changed between read and write is
  skipped and reported (`skipped` column), never clobbered. Re-run to pick up any
  skipped rows on their next-read pass.
- Use `--table=workers,payers` to scope a run (e.g. rotate the highest-value tables
  first, or resume a partial rotation table-by-table).
- Use `--batch-size=<n>` (default 500) to tune throughput vs. lock/connection pressure
  on a live DB — start smaller (e.g. 100) for the first production run.

### Step 4 — verify

```sql
-- Spot-check: no v1 tokens should remain under the OLD kid for a fully-rotated table.
SELECT count(*) FROM workers WHERE phone_e164 NOT LIKE 'v2.<newKid>.%';
-- Expect 0 (or only rows that were NULL, which the runner already excludes from "rotate").
```

Re-run the dry-run (`db:reencrypt:pii` with no `--apply`) — the "rotate" column for
every table/column should read 0.

### Step 5 — retire the old kid (only after step 4 confirms 0 remaining)

Remove the old kid from `PII_ENCRYPTION_KEYS`, keeping only the active kid (or the
active kid + any OTHER kid still mid-rotation). Deploy. From this point, a row still
carrying the old kid's token would fail to decrypt with `unknown PII key id` — which is
exactly why step 4 must show zero before this step runs.

**Do not skip step 4.** Retiring a kid with rows still under it is a fail-closed data
loss (the row becomes permanently undecryptable — there is no way to recover the key
once removed from config, by design, since key material is never stored in the DB).

## 4. Rollback & undo semantics

- **Steps 1-2 (add kid, flip active) are reversible** — revert `PII_ENCRYPTION_KEYS`
  / `PII_ENCRYPTION_ACTIVE_KID` config and redeploy; no data was touched.
- **Step 3 (the backfill) is NOT meaningfully reversible** — a rotated row's plaintext
  is unchanged, only its ciphertext/kid changed, so there is nothing "wrong" to undo.
  If the NEW key is later found to be bad (e.g. minted incorrectly), treat it as a
  fresh rotation: mint another new key and re-run the backfill again (old kid must
  still be in the keyring to decrypt the just-rotated rows — do not retire early).
- **Step 5 (retiring a kid) has NO undo** — once a kid's key is removed from config, any
  row still under it is permanently undecryptable. This is why step 4's verification is
  a hard gate, not a suggestion.

## 5. Audit trail

The runner's dry-run/apply summary (table, column, counts) is PII-free by construction
(row ids and counts only — see the script's header) and is safe to paste into the
rotation ticket. No spine event is emitted (this is an offline ops runner over derived
ciphertext, not a worker-facing action — same posture as `retag-skills.ts`); the ticket
+ this runbook + the config-change PRs are the audit trail for a rotation.
