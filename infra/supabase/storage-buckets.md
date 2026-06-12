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

## Apply (Supabase project only — never the local/CI plain Postgres)

```bash
# DB connection string: Supabase dashboard → Project Settings → Database.
psql "$SUPABASE_DB_URL" -f infra/supabase/storage-buckets.sql
# or: paste storage-buckets.sql into the dashboard SQL editor and run.
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

## Drift / re-assert

`storage-buckets.sql` is idempotent and its `on conflict … do update set public = false`
clause **re-asserts privacy** — re-run it any time to converge a bucket that was
accidentally flipped public in the dashboard.
