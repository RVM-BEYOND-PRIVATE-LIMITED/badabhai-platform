# Supabase Storage buckets — provisioning runbook

Storage buckets are **not** part of the Drizzle migration chain (that chain also runs
on plain Postgres in CI/local, which has no Supabase `storage` schema). They are
provisioned **out-of-band**, directly against the Supabase project, via the idempotent
[`storage-buckets.sql`](./storage-buckets.sql).

## Buckets

| Bucket | Purpose | Privacy | Access |
| ------ | ------- | ------- | ------ |
| `worker-resumes` | Rendered resume PDFs (TD5 / [ADR-0007](../../docs/decisions/0007-resume-render-node-boundary.md)). PDF bytes contain the worker's real name. | **PRIVATE** | Backend mints short-TTL **signed URLs** only (service_role); no anon/public read. Risk **R13**. |
| `interview-kits` | Rendered per-trade interview-kit PDFs (TD24, Task 4). PII-free (per-trade, never per-worker). | **PRIVATE** | Same model — signed-URL-only read. |
| `worker-profile-photos` | Worker profile photos ([ADR-0032](../../docs/decisions/0032-worker-profile-photo.md)). A face photo is high-sensitivity PII. | **PRIVATE** | Signed **upload** URL in (server-chosen opaque key), signed read URL for the worker's OWN photo. Never payer-readable (faceless invariant). |
| `worker-voice-notes` | Raw recorded voice notes ([ADR-0029](../../docs/decisions/0029-voice-audio-at-rest-and-upload-seam.md), TD29 G2). **Audio is PII** — the worker is speaking, so a clip can carry their own name, employer names, and a spoken phone number. | **PRIVATE** | Signed **upload** URL in (server-chosen opaque key `voice-notes/{workerId}/{uuid}.m4a`); read is service_role-only, by the ai-service, to transcribe. Never worker- or payer-readable. **R25** (#280) / **TD58** (#281). |
| `worker-feedback-attachments` | Images a worker attaches to a **feedback** submission (#1191). Personal data in the same class as the message: workers photograph payslips, gate passes, supervisors, themselves. | **PRIVATE** | Signed **upload** URL in (server-chosen opaque key `feedback-attachments/{workerId}/{uuid}.jpg`, re-validated against the session worker at submit); read is a short-TTL signed GET minted per admin page view, with `Content-Disposition: attachment`. Never payer-readable. **`allowed_mime_types = {image/jpeg}` is a security control** — it is what stops worker-supplied markup being rendered on the storage origin when an admin clicks a thumbnail. |
| ~~`worker-conversations`~~ | ~~Raw conversation JSON~~ — **RETIRED, do not provision.** [ADR-0003 is Withdrawn](../../docs/decisions/0003-worker-conversation-storage-boundary.md#withdrawal-2026-08-14); the bucket was never provisioned and nothing ever wrote `conversation_storage_path`. `chat_messages` is the durable transcript, so this bucket would be a second copy of raw PII — which was risk **R10**, now **Closed by the retirement**. | — | Not provisioned. `CONVERSATIONS_BUCKET` config remains only so the DSAR erasure sweep (`conversationWorkerPrefix`) keeps running as defence in depth. |

## Source of truth (CLI / config, not dashboard clicks)

Two version-controlled artifacts define bucket privacy — keep them in sync; never
flip a bucket public in the dashboard:

1. **[`supabase/config.toml`](../../supabase/config.toml)** — declares
   `[storage.buckets.worker-resumes]` / `[storage.buckets.interview-kits]` with
   `public = false`. This governs the **local** stack (`supabase start` /
   `supabase seed buckets`) and documents intent.
2. **[`storage-buckets.sql`](./storage-buckets.sql)** — the **remote** (staging/prod)
   apply: idempotent, and its `on conflict … do update set public = false` clause
   **re-asserts privacy on drift**.

## Apply (Supabase project only — never the local/CI plain Postgres)

Apply against the **linked** project via the Supabase CLI (preferred — no copy-pasting
a god-key into a shell, no dashboard clicks):

```bash
# One-time: link the repo to the STAGING project (stores the ref in supabase/.temp).
supabase link --project-ref <staging-project-ref>

# Run the idempotent bucket SQL against the linked DB. `--linked` resolves the
# connection from the link above; no raw connection string on the command line.
supabase db execute --linked --file infra/supabase/storage-buckets.sql
```

Fallback (older CLI without `db execute`) — use the pooled connection string from
`Project Settings → Database`:

```bash
psql "$SUPABASE_DB_URL" -f infra/supabase/storage-buckets.sql
```

This is a **launch gate** (R13 / TD24): the `worker-resumes` bucket must exist and be
PRIVATE **before** `RESUME_RENDER_ENABLED=true` in any environment that serves real
workers.

## Verify it is PRIVATE

1. **Exists + private** (expect `public = f`):
   ```sql
   select id, public, file_size_limit, allowed_mime_types
   from storage.buckets where id = 'worker-resumes';
   ```
2. **No anon read path** — the public object route must NOT serve the file (a private
   bucket rejects it):
   ```bash
   # Expect HTTP 400/403 (NOT 200) for the public path on a private bucket.
   curl -s -o /dev/null -w '%{http_code}\n' \
     "$SUPABASE_URL/storage/v1/object/public/worker-resumes/resumes/x/y/v1.pdf"
   ```
3. **Signed URL works** — the backend `GET /resume/:id/download` returns a URL that
   *does* serve the PDF, and stops serving it after `RESUME_SIGNED_URL_TTL_SECONDS`.

## Enable resume rendering in STAGING (TD24) — ordered runbook

Do these **in order**. Steps 1–2 are the gate; do not flip the switch (step 3) until
the bucket verifies PRIVATE.

1. **Provision + verify the private bucket** (above): `supabase db execute … storage-buckets.sql`,
   then the two checks under "Verify it is PRIVATE" — `public = f` and the public route
   returns 400/403.
2. **Confirm the binary is present.** The API image installs WeasyPrint
   ([`apps/api/Dockerfile`](../../apps/api/Dockerfile)); without it the renderer degrades
   to "no PDF" and `render_status` stays `pending`.
3. **Flip the switch — staging env only** (code default stays `false`):
   ```
   RESUME_RENDER_ENABLED=true
   RESUME_SIGNED_URL_TTL_SECONDS=900   # 15 min; tighten if desired
   ```
   See [`apps/api/.env.staging.example`](../../apps/api/.env.staging.example).
4. **Prove it end-to-end** with the credential-gated live test (uploads to the private
   bucket, mints a signed URL, and asserts: 200 happy path, anon route denied, expiry):
   ```bash
   RESUME_STORAGE_E2E=1 \
   SUPABASE_URL=https://<staging-ref>.supabase.co \
   SUPABASE_SERVICE_ROLE_KEY=<staging service-role key> \
   RESUMES_BUCKET=worker-resumes \
   pnpm --filter @badabhai/e2e test -- resume-signed-url
   ```
   ([`tests/e2e/resume-signed-url.e2e.test.ts`](../../tests/e2e/resume-signed-url.e2e.test.ts) —
   skips when the env is absent, so CI stays green.) For a full app-level proof, also
   drive `POST /resume/generate` → wait for `render_status: rendered` →
   `GET /resume/:id/download` (sends `x-internal-service-token`) → GET the returned URL.

**Rollback:** set `RESUME_RENDER_ENABLED=false` (renderer degrades to no-PDF; existing
download URLs keep working until they expire) and/or re-run `storage-buckets.sql` to
re-assert `public = false`.

## Enable voice notes in STAGING (issue #313 / G2) — ordered runbook

The whole voice pipeline is **built and wired real on both sides** (recorder + signed-upload
client in `apps/worker-app/lib/features/voice/`, `POST /voice/upload-url|upload|transcribe` in
`apps/api/src/voice/`, events `voice_note.uploaded` → `transcription_requested` →
`transcription_completed`/`_failed`). It is **DORMANT** purely because `VOICE_NOTES_BUCKET`
defaults to `""` ([`packages/config/src/server.ts`](../../packages/config/src/server.ts)) and
`voice.service.ts` **503s fail-closed** while it is unset. Arming it is these steps, in order.

1. **Provision + verify the private bucket:** `supabase db execute … storage-buckets.sql`, then
   the two checks under "Verify it is PRIVATE" against `worker-voice-notes` (`public = f`, and
   the public object route returns 400/403). **Do not proceed on a bucket that reads `public = t`.**
2. **Set the env var — staging only** (code default stays `""`, i.e. off):
   ```
   VOICE_NOTES_BUCKET=worker-voice-notes
   ```
   **Use this exact name, or set it in BOTH services.** The API's default is `""` (dormant) but
   the ai-service's default is the literal `worker-voice-notes`
   ([`apps/ai-service/app/config.py`](../../apps/ai-service/app/config.py) `voice_notes_bucket`).
   Provision a different name and set only the API's var and you get a silent split-brain: the
   API writes to your bucket, the ai-service reads `worker-voice-notes`, and every transcription
   fails closed to an empty transcript with nothing obviously broken.
3. **Handset verify (the actual G2 exit criteria):** record → upload → transcribe on a device,
   and confirm the event chain `voice_note.uploaded` → `transcription_requested` →
   `transcription_completed` (or `_failed` → safe empty transcript) with **no PII in logs**.
   Mock STT is fine for this — it completes within one client poll.
4. **Do NOT arm real STT as part of this.** `AI_ENABLE_REAL_CALLS=true` + `SARVAM_API_KEY` are a
   separate §7 human-gated flip with their own blockers ([TD59](../../docs/registers/tech-debt-register.md)
   — the worker-app's ~14s poll budget strands any note over ~30s; [R30](../../docs/registers/risks-register.md)
   — the word-split phone seam). Provisioning this bucket does not and must not imply that flip.

**Two open register items ride this bucket — neither is paid by provisioning it:**

- **R25** (#280, [risks-register](../../docs/registers/risks-register.md)) — the DSAR /
  account-deletion sweep erases audio by iterating `voice_notes.storage_path` against
  `VOICE_NOTES_BUCKET`. Audio that lands in any **other** bucket survives a worker's deletion
  request. That is the whole reason step 2 must match what the code actually writes to.
- **TD58** (#281, [tech-debt-register](../../docs/registers/tech-debt-register.md)) — retention is
  still `retain_indefinitely` / `hot` by default. Once armed, raw audio accumulates here with no
  TTL, no cold-tier lifecycle, and no orphan sweep (uploaded-but-never-registered objects are
  invisible to the DSAR sweep, which is row-driven). A ratified retention window is a
  product + security decision, not an infra one.

**Rollback:** unset `VOICE_NOTES_BUCKET` (the voice routes 503 fail-closed again; already-stored
objects stay put and stay private) and/or re-run `storage-buckets.sql` to re-assert `public = false`.
Note (#1271): a DSAR erasure for a worker who had audio stored **before** this rollback no longer
reads as a silent success — `AccountDeletionService` now gates the two audio-deletion legs on
whether the worker's `voice_notes` rows exist (captured pre-cascade), not on the live config
value, so a post-rollback erasure request for such a worker is recorded/reported `failed` /
`INCOMPLETE` rather than `skipped`. There is still no per-row bucket-name record, so once rolled
back there is no way to actually complete that worker's audio erasure in code — re-arming the
same bucket name is the only path to a clean re-run.

**Known gap (follow-up, not this change):** `supabase/config.toml` declares only
`worker-resumes` / `interview-kits`, so `worker-voice-notes` exists in the **remote** apply but
not in the **local** `supabase start` stack. Add a `[storage.buckets.worker-voice-notes]` block
with `public = false` to keep the two source-of-truth artifacts in sync.

## Enable feedback image attachments (#1191 / #1225) — ordered runbook

Both halves of this feature are built and shipped — the picker + resize + signed-PUT client in
`apps/worker-app/lib/features/feedback/`, `POST /workers/me/feedback/attachment/upload-url` and
the IDOR-checked `POST /workers/me/feedback` in `apps/api/src/feedback/`, and the
signed-thumbnail read on the admin `/feedback` screen. It is **DORMANT** purely because
`WORKER_FEEDBACK_ATTACHMENTS_BUCKET` defaults to `""`
([`packages/config/src/server.ts`](../../packages/config/src/server.ts)) and
`feedback.service.ts` **503s fail-closed** while it is unset.

**THIS BUCKET HAS A SCHEMA PRECONDITION AND THE OTHER TWO DO NOT. Do step 1 first.** Migration
`0092` adds `worker_feedback.attachment_paths`, and `FeedbackRepository.insert` names the
drizzle model's **whole column list** — so against a database without it **every** feedback
submission 500s, including the ones carrying no image at all, and `AdminFeedbackRepository.list`
names it in an explicit SELECT so `GET /admin/feedback` 500s too. Neither is behind the bucket
flag: the dormant-bucket 503 gates only the MINT route and protects nothing here. Arming the
bucket first would additionally mean workers upload real images that no row can reference —
orphans keyed by an opaque uuid, erasable only by the DSAR prefix sweep.

1. **Apply migration `0092` and confirm it.** Manual, per the locked convention in
   [`docs/ops/production-release-runbook.md`](../../docs/ops/production-release-runbook.md).
   `ADD COLUMN … jsonb` with no default is catalog-only; run under `SET lock_timeout = '3s';`
   and retry on `55P03`. Then record the journal row and prove the database is ready:
   ```bash
   npx tsx adopt-migrations.ts --only 0092_flawless_glorian --apply --expect-host <pooler host>
   pnpm --filter @badabhai/db db:audit:schema-contract       # expect READY
   ```
   **Smoke before continuing:** text-only feedback returns 201 and admin `/feedback` renders.
   If either still 500s, stop — the rest of this runbook cannot fix it.

2. **Provision + verify the private bucket:** run `storage-buckets.sql` (above), then the two
   checks under "Verify it is PRIVATE" against `worker-feedback-attachments` — `public = f`, and
   the public object route returns 400/403. **Do not create this one through the dashboard's
   "New bucket" button.** `allowed_mime_types = {image/jpeg}` is a **security control** here, not
   hygiene: the submit path deliberately performs no per-object `getObjectInfo` (it would sit
   inside the transaction carrying the worker's typed message), so the bucket is the only thing
   refusing worker-supplied `text/html` that an admin's click would render on the storage origin.
   `file_size_limit` is likewise the **only** enforcement of the 5 MiB ceiling —
   `FEEDBACK_ATTACHMENT_MAX_BYTES` exists so that number has one name in the repo and is not read
   on the submit path. A hand-made bucket silently drops both.

3. **⚠ Check `supabase` credentials BEFORE you set the bucket name.**
   ```bash
   curl -s https://<host>/health | jq '.checks.storage_config'
   ```
   `armed_without_credentials` is one of the few things that **gates** `/health`
   ([`health.controller.ts`](../../apps/api/src/health/health.controller.ts)) — it returns
   **503**. A bucket name set while `supabase` reads `not_configured` therefore takes the API's
   health red, and `wait_healthy`'s `curl -sf` in
   [`scripts/deploy/staging-deploy.sh`](../../scripts/deploy/staging-deploy.sh) then **fails
   every subsequent deploy**. Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in the same edit,
   or confirm they are already there.

4. **Set the env var — and note WHERE, because it is not where the other secrets live:**
   ```
   WORKER_FEEDBACK_ATTACHMENTS_BUCKET=worker-feedback-attachments
   ```
   `docker-compose.staging.yml` declares the `${VAR:-}` pass-through (asserted by
   `feedback-attachments-compose.guard.test.ts`), but this name — like `WORKER_PHOTOS_BUCKET`,
   `VOICE_NOTES_BUCKET` and the `SUPABASE_*` pair — is **NOT in the `deploy-lightsail` secrets
   bridge** in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml). The ssh action
   forwards only the names its `envs:` list enumerates, so **adding a GitHub Actions secret puts
   the value nowhere the container can read it.** It must live in the environment file in the
   deploy directory (`~/deployments/badabhai-platform`), which is where the deploy script `cd`s
   before invoking compose and which the per-deploy `git pull` leaves alone.

   Use this **exact** bucket name. It is what `storage-buckets.sql` provisions and, more
   importantly, what `AccountDeletionService` sweeps `feedback-attachments/{workerId}/` against
   on erasure — arming the var is what takes that leg from `skipped` to real, so there is no
   window where attachments exist and erasure is dormant.

5. **Recreate the container** (editing the file changes nothing already running), matching what
   the deploy script does:
   ```bash
   cd ~/deployments/badabhai-platform
   docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile api \
     up -d --no-deps --force-recreate api
   ```
   `--no-deps` is not optional: the `api` service `depends_on` the compose-internal `postgres`,
   which is a local throwaway and not the database this box uses. Run it from **that directory
   only** — compose derives the project name from it, and from anywhere else you get a new
   project with a new empty Redis volume, force-logging-out every worker (the deploy script has a
   pre-flight guard for exactly this; a bare `docker compose` has none).

6. **Verify armed:** `/health` → `storage_config.buckets.feedback_attachments: true`. Then the
   real proof: attach an image on a handset → `POST /workers/me/feedback` returns 201 → the
   thumbnail renders on the admin `/feedback` screen.

**Why the dormant state is worth being explicit about:** the shipped worker client degrades
honestly on the mint's 503 — it drops the image and still submits the text — so a box where this
was never armed looks *exactly* like a working one from the outside. Text feedback arrives,
images silently never do, and nothing is on fire. `/health`'s `feedback_attachments` flag exists
because it is the only external signal that tells the two apart.

**Rollback:** unset `WORKER_FEEDBACK_ATTACHMENTS_BUCKET` and recreate the container (the mint
503s again, the client drops images and still sends text; already-stored objects stay put and
stay private), and/or re-run `storage-buckets.sql` to re-assert `public = false`. Reverting the
migration is a separate, ordered act — revert the api first, since **both** surfaces name the
column; see `0092`'s own header.

**Known gap, same as the voice bucket:** `supabase/config.toml` declares only `worker-resumes` /
`interview-kits`, so `worker-feedback-attachments` exists in the **remote** apply and not in the
local `supabase start` stack.

## Drift / re-assert

`storage-buckets.sql` is idempotent and its `on conflict … do update set public = false`
clause **re-asserts privacy** — re-run it any time to converge a bucket that was
accidentally flipped public in the dashboard.
