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
| `worker-conversations` | Raw conversation JSON ([ADR-0003](../../docs/decisions/0003-worker-conversation-storage-boundary.md)). | **PRIVATE** | Same model. Risk **R10** — provision when closing R10. |

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

**Known gap (follow-up, not this change):** `supabase/config.toml` declares only
`worker-resumes` / `interview-kits`, so `worker-voice-notes` exists in the **remote** apply but
not in the **local** `supabase start` stack. Add a `[storage.buckets.worker-voice-notes]` block
with `public = false` to keep the two source-of-truth artifacts in sync.

## Drift / re-assert

`storage-buckets.sql` is idempotent and its `on conflict … do update set public = false`
clause **re-asserts privacy** — re-run it any time to converge a bucket that was
accidentally flipped public in the dashboard.
