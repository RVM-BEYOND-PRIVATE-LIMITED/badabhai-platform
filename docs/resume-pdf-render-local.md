# Runbook — resume PDF render + download, locally

The worker-app "PDF download karein" button calls `GET /resume/:id/download`, which
**409s** (`Resume PDF is still being rendered`) whenever the resume's `render_status`
isn't `rendered`. That is the expected state until the **WeasyPrint render pipeline**
is actually running. This runbook turns it on locally.

Why Docker (and not `pnpm --filter @badabhai/api dev`)? The renderer spawns the
`weasyprint` binary, which is **only installed in the API Docker image**
([apps/api/Dockerfile](../apps/api/Dockerfile)) — it is absent on a bare Windows/macOS
host. The `api` compose service runs inside that Linux image, so it renders on any host.

> The `api` compose service is **DEV-ONLY** (it boots with dev-default PII/JWT/admin
> secrets via `NODE_ENV=development`). It is **not** production-safe. Staging/prod get
> real secrets a different way — see [.env.staging.example](../apps/api/.env.staging.example).

---

## What must be true for a PDF to render (all four)

| #   | Requirement                                                                                   | Set by this runbook               |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | `RESUME_RENDER_ENABLED=true`                                                                  | the `api` compose service sets it |
| 2   | `weasyprint` on PATH                                                                          | baked into the API Docker image   |
| 3   | Redis reachable                                                                               | the compose `redis` service       |
| 4   | A **PRIVATE** `worker-resumes` Supabase bucket + `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | **you provision — see below**     |

Requirement 4 is the only piece this repo can't provide: it needs your Supabase
project and a backend-only service-role key.

---

## One-time: provision the private bucket

Follow [infra/supabase/storage-buckets.md](../infra/supabase/storage-buckets.md). In short,
against your linked project:

```bash
supabase link --project-ref <your-ref>
supabase db execute --linked --file infra/supabase/storage-buckets.sql   # creates worker-resumes, public=false
```

Verify it is **private** (`public = f`) per that doc. The bucket **must** exist and be
private _before_ rendering is enabled (it's a launch gate).

Grab, from your Supabase project settings:

- `SUPABASE_URL` — `https://<ref>.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` — the **service_role** key (backend-only "god key"; never ship it to a client)

---

## Run it

```bash
# 1. Infra + schema (host tooling — Redis + Postgres for the container network)
pnpm db:up
pnpm db:migrate                     # applies drizzle migrations to the compose Postgres

# 2. Your Supabase creds (the container reads these; compose fails fast if unset)
export SUPABASE_URL="https://<ref>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<service_role key>"

# 3. Build + run the render-enabled API (first build ~a few min; installs WeasyPrint)
docker compose --profile api up --build api
```

The API listens on `http://localhost:3001`. Point the worker app's `API_BASE_URL` at it
(real mode, not `--dart-define=USE_MOCKS=true`).

---

## Verify the PDF renders + downloads

**In the app:** log in → complete profiling → open the resume → tap **"PDF download
karein"**. Once the async render finishes (a second or two after generate), the signed
PDF opens instead of a 409. While it's still rendering, the app now shows an honest
_"Aapki PDF abhi taiyaar ho rahi hai…"_ (not a generic error) — retry and it opens.

**Via the API** (no app needed; uses a worker bearer from your login):

```bash
# after POST /resume/generate returns { resume_id }:
curl -s localhost:3001/resume/<resume_id> -H "authorization: Bearer <worker_jwt>" | jq .render_status
#   → "pending"  → briefly → "rendered"

curl -s localhost:3001/resume/<resume_id>/download -H "authorization: Bearer <worker_jwt>"
#   → { "url": "https://<ref>.supabase.co/storage/v1/object/sign/worker-resumes/...", "expires_in": 900 }
```

Automated storage-level proof (opt-in, talks to your bucket directly):

```bash
RESUME_STORAGE_E2E=1 SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... RESUMES_BUCKET=worker-resumes \
  pnpm --filter @badabhai/e2e test resume-signed-url
```

> A full app-level `login → generate → render → download` e2e is **not** automated: worker
> login is real-OTP only (no `dev_otp` echo), so the journey can't be driven headless. Drive
> it manually per the steps above, or seed a worker + confirmed profile directly.

---

## Troubleshooting a persistent 409

- **`render_status` stays `pending`** → the render job isn't completing. Check the `api`
  container logs for `weasyprint …; degrading to no-PDF` (binary/timeout) or
  `upload/persist failed` (bucket/creds). Confirm `RESUME_RENDER_ENABLED=true` in the
  container env and that Redis is healthy (the job runs on BullMQ in-process).
- **`Supabase Storage is not configured`** → `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
  didn't reach the container. They must be exported in the shell that runs `docker compose`.
- **`render_status: failed`** → the final render attempt failed (bucket missing/not private,
  or a WeasyPrint error). Fix the cause, then `POST /resume/:id/regenerate`.

## Enabling in staging (not local)

Same four requirements, but ops-driven: deploy the API image (WeasyPrint included), set
`RESUME_RENDER_ENABLED=true` + `RESUMES_BUCKET` + `SUPABASE_*` + `REDIS_URL`, and provision
the private bucket in the staging project. This is a launch gate + real-provider step.

---

## Measuring the one-page contract (`bb_trade` sheets)

The trade sheet's one-page rule is verified by **measurement**, not by rendering three samples and
agreeing they look fine. `scripts/measure-sheet-headroom.py` binary-searches the shortest page each
sheet still fits on and fails below a **5 mm** floor.

WeasyPrint is Docker-only on a Windows/macOS host, same as the render pipeline above, so this runs
in the image rather than on the host:

```bash
# 1. build a WeasyPrint image once (any image with weasyprint + fonts-noto-core will do)
docker build -t bb-weasy:local -f apps/api/Dockerfile .

# 2. write the sheets and their manifest (56 files: 28 as they render today,
#    28 with the queued Zone 4 / Zone 5 content injected)
EMIT_SHEETS=/tmp/sheets pnpm --filter @badabhai/api run test sheet-shape-emit

# 3. measure them
docker run --rm -v "$PWD:/w" -v /tmp/sheets:/sheets -w /w bb-weasy:local     python scripts/measure-sheet-headroom.py /sheets
```

Exit 0 means every sheet cleared the floor; exit 1 names the ones that did not, with their
headroom and the degradation stage that produced them.

**Why a floor and not "does it fit".** The worst sheet once fit at exactly 297.00 mm and spilled at
296.75 — a knife edge that a renderer upgrade or a missing font package breaks silently across
every sheet at once, with a binary assertion still green. The floor is measured: WeasyPrint
63.1/66.0/69.0 agree to 0.00 mm, and a DejaVu font fallback moves the numbers by up to 3.64 mm.

**Not wired into CI**, because the `e2e` job has no WeasyPrint. It is a local gate today; results
are recorded in [resume-engine-r1-journal.md](./resume-engine-r1-journal.md).
