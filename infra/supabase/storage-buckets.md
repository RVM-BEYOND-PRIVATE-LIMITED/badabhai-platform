# Supabase Storage buckets — provisioning runbook

Storage buckets are **not** part of the Drizzle migration chain (that chain also runs
on plain Postgres in CI/local, which has no Supabase `storage` schema). They are
provisioned **out-of-band**, directly against the Supabase project, via the idempotent
[`storage-buckets.sql`](./storage-buckets.sql).

## Buckets

| Bucket | Purpose | Privacy | Access |
| ------ | ------- | ------- | ------ |
| `worker-resumes` | Rendered resume PDFs (TD5 / [ADR-0007](../../docs/decisions/0007-resume-render-node-boundary.md)). PDF bytes contain the worker's real name. | **PRIVATE** | Backend mints short-TTL **signed URLs** only (service_role); no anon/public read. Risk **R13**. |
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

## Drift / re-assert

`storage-buckets.sql` is idempotent and its `on conflict … do update set public = false`
clause **re-asserts privacy** — re-run it any time to converge a bucket that was
accidentally flipped public in the dashboard.
