# Résumé erasure backfill (ADR-0043 launch gate)

**Why this exists.** Before résumé history, removing a photo, hiding it, or clearing a WhatsApp
number re-rendered only the worker's current PDF. Their older PDFs kept the photo or number. The
history list (#1687) now lets a worker download and share those older PDFs. Erasures made after
migration 0125 already reach every PDF. This backfill fixes the ones made before it.

**What it does.** It re-renders, fail-closed, every `rendered` résumé whose `rendered_at` is earlier
than its worker's latest erasure, using the worker's current data. The erasures are read from the
audit spine:

- `worker.photo_removed`;
- `worker.whatsapp_recorded` with `has_whatsapp = false`;
- a `worker.resume_prefs_updated` event that turned the photo from on to off, after a photo was
  uploaded.

The re-render is the same job an erasure queues (`force` + `failClosed`), so it makes no AI call
and does not create a new version. If a render cannot finish, the row is marked failed (downloads
return 409) rather than left serving what the worker erased. Each queued résumé emits
`resume.erasure_backfill_enqueued` (ids only).

**Side effect.** A re-rendered older entry is redrawn with today's name, photo and details, not the
ones it had when it was generated. The erasure fan-out already does the same (ADR-0043, R4).

## Before you run it

- Deploy a build that contains `POST /workers/resume-erasure-backfill`.
- Check `RESUME_RENDER_ENABLED` on the deployed API.
  - **When it is on**, stale PDFs are redrawn without the erased data.
  - **When it is off**, every targeted PDF is taken out of service (409) instead. That is the
    privacy-correct outcome, but those workers lose the download until rendering is turned on and
    they regenerate.
- Have the deployed API's `INTERNAL_SERVICE_TOKEN` ready. Do not paste it into shell history.

```bash
API_BASE_URL=https://<deployed-api>          # the API, not payer-web
read -rs TOKEN                               # paste INTERNAL_SERVICE_TOKEN, then Enter
call() {
  curl -sS -X POST "$API_BASE_URL/workers/resume-erasure-backfill" \
    -H "x-internal-service-token: $TOKEN" -H "content-type: application/json" -d "$1"
  echo
}
```

## Steps

1. **Size it (read-only).**

   ```bash
   call '{"dry_run": true}'
   # {"dry_run":true,"stale":N,"batch":…,"enqueued":0,"failed":0,"next_after":…}
   ```

   `stale` is the number of PDFs that may still carry erased data. If it is `0`, stop: there is
   nothing to do.

2. **Run it, one page at a time** (at most 500 per page; 100 is the default).

   ```bash
   call '{"dry_run": false, "limit": 200}'
   # repeat with the cursor while next_after is not null:
   call '{"dry_run": false, "limit": 200, "after": "<next_after>"}'
   ```

   `failed` counts résumés whose render could not be queued. They stay in the set, so a later run
   picks them up.

3. **Verify it drained.** The renders run on the render queue. Once it is empty (usually minutes),
   run the dry run again:

   ```bash
   call '{"dry_run": true}'
   # expect "stale": 0
   ```

   Any résumé still counted either failed to render or failed to queue. Run step 2 again. A résumé
   whose render fails for good is marked failed and leaves the set on its own, because it is no
   longer served.

## Safe to re-run

A résumé whose render is still waiting is not queued twice, and every render moves `rendered_at`
past the erasure, so the set only shrinks. Running it again later is harmless: with nothing stale,
the run does nothing.

## Rollback

There is nothing to roll back: no schema change, no data written except `rendered_at` and the PDF
itself. To stop part-way, just stop calling the route. Renders already queued will finish.
