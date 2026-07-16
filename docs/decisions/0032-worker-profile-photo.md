# ADR-0032: Worker profile photo — capture, private storage, own-resume embed (the faceless invariant is the design constraint)

- **Status:** Accepted — Prakash (TL) + Akshit (CEO) sign-off relayed by Divyanshu Pant,
  2026-07-16. A face photo is a new, high-sensitivity PII class (DPDP: purpose, consent,
  retention, erasure are ruled below, not assumed).
- **Date:** 2026-07-16
- **Scope:** `packages/config` (`WORKER_PHOTOS_BUCKET`, dormant), `packages/db`
  (`workers.photo_storage_key`, migration 0040), `apps/api/src/workers` (4 new `me/photo*`
  routes + `has_photo` on resume-fields), `apps/api/src/storage` (a byte-download + object-info
  method over the existing Mode A seam), `apps/api/src/resume` (render-input photo slot +
  `*.v2.html` templates), `apps/api/src/auth` (account-deletion photo erase leg),
  `packages/event-schema` (`worker.photo_uploaded` / `worker.photo_removed` v1),
  `apps/worker-app` (picker → signed PUT → confirm; edit-screen row; preview render; nudge
  route-through). A **companion code PR implements this**; this ADR is the decision of record.
- **Relates to:** [ADR-0029](0029-voice-audio-at-rest-and-upload-seam.md) (the signed-upload
  seam this mirrors verbatim), [ADR-0003](0003-worker-conversation-storage-boundary.md)
  (private-bucket / service-role-only / opaque-key posture), [ADR-0026](0026-production-worker-auth-pin-and-tiered-sessions.md)
  Phase 5 (DSAR erasure this extends), [ADR-0031](0031-account-deletion-grace-window.md)
  (**pending** — if the 7-day grace window restructures deletion, the photo erase leg moves with
  it; the capture-before-cascade property is what must survive). Invariants engaged:
  CLAUDE.md §2 #1 (event-first), #2 (no raw PII out of boundary), #6 (consent gate),
  #7 (typed contracts), #8 (backward compat); §7 (new PII class ⇒ human sign-off).

## Context

`workers.resume_show_photo` shipped in migration 0036 with a comment that already anticipates
this build ("gates the (deferred) profile-photo") — but today the toggle gates **nothing**:
there is no capture UI, no upload endpoint, no photo column, no bucket config. The profile tab
nudges "Ek photo add karein aur 100% tak pahunchein." and dead-ends
(`profile_tab_screen.dart:231` — plain `Text`, no tap handler).

**The product is a faceless data exchange.** Payers evaluate skills, never faces — masking is
payer-only and money-never-ranks. A worker photo therefore exists for exactly two surfaces:
the worker's **own** app and the worker's **own** resume PDF. It must never reach the payer
portal, the feed, the masked disclosure PDF, events, `ai_jobs`, `audit_logs`, logs, or any LLM
input. That is not a nice-to-have; it is the design constraint everything below is shaped by.

The storage side has a proven template: ADR-0029's voice seam (server-minted signed upload URL
into a private service-role-only bucket, server-chosen opaque key, fail-closed dormancy,
DSAR-armed erasure). This ADR is deliberately that seam, applied to images.

## Decision

### 1. Purpose limitation — own-app + own-resume-PDF only, enforced structurally

The single leak-resistant seam is `buildResumeRenderInput` (`resume-render-input.ts`): it is
shared by the worker's own render **and** the payer-facing masked disclosure, and its contract
is that identity fields are **caller-supplied** (that is how `displayName` vs `maskedName`
already works). The photo follows identically: a `photoDataUri: string | null` field on
`ResumeRenderInput`, passed **only** by the own-resume render processor; the disclosure caller
passes `null` structurally (not by flag). It is therefore impossible for the disclosure to pick
up a photo without a reviewable code change at the call site. A dedicated test asserts the
disclosure render input carries no photo for a worker who HAS one.

The photo never enters: any event payload (both new events carry `worker_id` only), `ai_jobs`,
logs (object keys and signed URLs are never logged — voice discipline), the feed/ranking
(RANK is locked, ADR-0030), or the payer portal (no payer-facing route can reach the bucket).

### 2. Ingestion — the ADR-0029 seam, verbatim

- **`POST /workers/me/photo/upload-url`** (`WorkerAuthGuard` + `ConsentGuard`, empty `.strict()`
  body): server mints the opaque key `photos/{workerId}/{uuid}.jpg` in the private
  `WORKER_PHOTOS_BUCKET` and returns `{ storage_path, upload_url, expires_in }` via
  `StorageService.createSignedUploadUrl`. The client chooses nothing about the destination.
  Minting emits no event (issuance is not a state change — voice precedent).
- Client `PUT`s bytes **directly to storage** — image bytes never transit the NestJS API.
- **`POST /workers/me/photo`** (confirm): validates the registered `storage_path` against the
  minted-key regex for THIS worker (voice's anti-forgery check), then validates the **object
  itself** via the storage object-info endpoint: it must exist, be `image/jpeg` or `image/png`,
  and be **≤ 2 MiB** — else 400 and the offending object is best-effort deleted. On success:
  sets `workers.photo_storage_key`, best-effort deletes the previously referenced object if the
  key changed, emits `worker.photo_uploaded` (PII-free: `worker_id` only).
- **`GET /workers/me/photo-url`**: short-TTL signed READ url (`createSignedUrl`, reusing
  `RESUME_SIGNED_URL_TTL_SECONDS`), own-session only, never logged/emitted; 404 when no photo.
- **`DELETE /workers/me/photo`**: clears the column, best-effort deletes the object, emits
  `worker.photo_removed`. **Idempotent** (no-photo → 200). Deletion of the pointer is never
  blocked by dormancy (data minimization must always work); only the object delete is skipped
  if the bucket is unset.
- **`GET /workers/me/resume-fields`** additively gains `has_photo: boolean` (never the key).
  It **defaults false** when absent client-side — the opposite default from `show_photo`
  (a true-default here would make clients try to render a nonexistent photo).

### 3. Fail-closed dormancy

`WORKER_PHOTOS_BUCKET: z.string().default("")` — while unset, upload-url mint / confirm /
photo-url return **503** and the feature is inert (voice pattern). The bucket
**`worker-profile-photos`** is already provisioned **PRIVATE** in Supabase out-of-band
(service-role-only, Mode A; the `storage-buckets.sql` idempotent pattern re-asserts
`public = false`). Setting the env simultaneously arms the account-deletion erase leg — no
ordering gap where photos exist but erasure is dormant.

### 4. Retention + erasure (DPDP)

- **Retention:** the photo lives until the worker replaces it, deletes it, or deletes their
  account. No independent retention clock at alpha (same posture as voice/TD58 — revisit
  before GA).
- **Erasure on account deletion:** the erase leg uses
  `deleteByPrefix("photos/{workerId}/", WORKER_PHOTOS_BUCKET)` rather than the single stored
  key — this also sweeps orphans (uploaded-but-never-confirmed) and superseded objects whose
  best-effort delete failed. It slots into the existing capture-before-cascade order
  (`account-deletion.service.ts` step 2, before `hardDelete`), folds into the **existing**
  `storage_objects_deleted/failed` counters — the `worker.account_deleted` payload is
  `.strict()` v1 and is **not** modified (invariant #8).
- **Consent:** every route rides `ConsentGuard`; no photo can exist for an unconsented worker.

### 5. Own-resume PDF embed

In `resume-render.processor.ts`, after the existing name-decrypt block and **gated on
`worker.resumeShowPhoto && worker.photoStorageKey`**: fetch bytes via a new
`StorageService.downloadObject(objectKey, bucket?)`, embed as a **`data:` URI**
(WeasyPrint receives HTML on stdin with no base URL — a remote signed URL would require
network fetch at render time; a data URI keeps the render hermetic). Degrade-to-no-photo on
any fetch/size failure (never fail the render for the photo; never log the key). The slot
binds as a 0-or-1-item repeat region so photo-less workers collapse cleanly.

**Templates:** shipped `*.v1.html` files are immutable by written contract
(`templates/registry.ts` + README). The photo slot therefore lands as **`classic.v2.html` /
`modern.v2.html` / `minimal.v2.html`** + registry entries; v1 stays the default until the
companion PR flips the default template ids. The masked disclosure keeps rendering the same
templates but its input carries `photoDataUri: null`, and the region collapses — plus the
explicit test of §1.

**Known limitation (ruled, documented):** renders are idempotent — toggling
`show_photo` or replacing/deleting the photo does **not** retro-edit an already-rendered PDF.
The next regenerate picks it up. Acceptable at alpha; a re-render trigger is a follow-up if
product wants it (logged as TD77 in the tech-debt register by the companion PR).

### 6. Client shape (Flutter)

- **`image_picker` only** (camera + gallery). Its native `maxWidth: 1024` + `imageQuality`
  does the resize/re-encode on-device — no separate compression package, and **no
  `permission_handler`** (repo precedent: the voice leg deliberately relies on the plugin's own
  permission handling; Android 13+ gallery picks need no permission at all).
  **EXIF, honestly stated (security review L-1):** `requestFullMetadata: false` skips full
  metadata on iOS; on Android the re-encode strips GPS lat/long but the plugin copies back a
  few coarse EXIF tags (timestamps/orientation). No `ACCESS_MEDIA_LOCATION` in the manifest
  (verified), so scoped storage redacts location at source. Server-side EXIF strip at confirm
  is the hardening follow-up (tracked with TD77).
- Upload mirrors `RealVoiceStorageUploader`: mint → `PUT` bytes with a dedicated `http.Client`
  (`content-type: image/jpeg`, bounded timeout, non-2xx → generic failure that never echoes
  the URL) → confirm. Temp file deleted after upload.
- **Edit screen:** an "Aapki photo" `_FieldRow` between the name row and the "Photo dikhayein"
  toggle — thumbnail (via `GET /workers/me/photo-url`) or add affordance; replace + remove.
- **Resume preview:** renders the photo in a new header slot **only when
  `show_photo && has_photo`** (state via the existing resume-fields endpoint) — this makes the
  toggle finally gate something. Placeholder avatar otherwise; nothing fabricated.
- **Profile tab nudge** routes to the photo flow instead of dead-ending.
- Signed URLs are fetched on view, held in memory only, never persisted/cached to disk, never
  logged. `MockApiClient` overrides every new method (its documented hard rule).

### 7. Events

`worker.photo_uploaded` and `worker.photo_removed`, v1, `.strict()`, payload
`{ worker_id: uuid }` only — no key, no URL, no dimensions. Registered additively
(registry: 102 → 104). Confirm/delete emit with actor+subject `worker/{workerId}` and request
context, mirroring `worker.resume_prefs_updated`.

## Privacy invariants (CLAUDE.md §2 — stated explicitly)

- **The photo is worker PII at rest:** private bucket only, service-role-only access, opaque
  server-chosen key, **never** in events, `ai_jobs`, `audit_logs`, logs, or LLM input. Signed
  URLs (both directions) are short-TTL bearer credentials and are never logged.
- **The faceless surface holds:** payer portal, feed, disclosure PDF, and ranking are
  structurally photo-free (§1). The disclosure test is the regression lock.
- **Consent gates everything** (#6); worker identity from the session, never body/path.
- **Event-first** (#1): both state changes emit validated PII-free events; reads mint no event.
- **Backward compat** (#8): column additive + rollback note; `account_deleted` payload
  untouched; templates versioned v2, v1 immutable; resume-fields extended additively.

## Rollout + gates

| Step | Gate |
|---|---|
| **This ADR signed by Prakash + Akshit** | **BLOCKING — no merge without it (§7, new PII class)** |
| Companion PR (endpoints, migration 0040, events, client) | §6 quality gates + **mandatory `bb-security-review`** (new PII class + new storage egress) |
| Bucket `worker-profile-photos` | Already provisioned PRIVATE (out-of-band); verify anon-denied |
| Arm: `WORKER_PHOTOS_BUCKET=worker-profile-photos` in env | Arms feature + deletion-erase leg together |
| Retention policy before GA | Product + security + DPDP track (joins TD58's review) |

## Consequences

- **Positive:** the dead toggle and dead nudge become real; the seam is a proven pattern
  (ADR-0029) with zero new stack; bytes never transit the API; erasure is prefix-swept (catches
  orphans); the faceless invariant is enforced by call-site structure + test, not convention.
- **Negative / risk:** a signed upload URL is a bearer credential for one object slot
  (bounded: short TTL, server-chosen key, private bucket). Client can upload garbage bytes —
  bounded by confirm-time mime/size validation against object info. An embedded photo inflates
  the PDF (`MAX_PDF_BYTES` 8 MiB output guard) — bounded by the ≤2 MiB input cap + client-side
  1024px resize; render degrades to photo-less on failure, never to no-PDF. Stale rendered
  PDFs after photo changes (ruled limitation, §5).
- **Rollback:** unset `WORKER_PHOTOS_BUCKET` → routes 503, feature inert at runtime, no deploy.
  **Disarm-after-arm caveat (security review L-4):** while disarmed, `DELETE` still clears
  pointers but skips objects, and the deletion sweep is gated off — photos uploaded before
  the disarm persist as orphans. Rolling back by unsetting therefore requires a later
  re-arm-and-sweep (or a manual bucket purge) before the rollback counts as erasure-complete.
  Column rollback: `ALTER TABLE "workers" DROP COLUMN "photo_storage_key";` (safe — pointer
  only, objects remain sweepable by prefix). Events are additive; templates v2 are additive
  (v1 untouched). Revert the companion PR restores today's behavior exactly.

## Alternatives considered

1. **Multipart upload through the NestJS API.** Rejected — same grounds as ADR-0029: bytes
   through the API process create a new §2 exposure surface (buffering, body logging) and
   duplicate what storage does. The API brokers authorization, not bytes.
2. **Photo on the payer/disclosure surface ("richer profiles convert better").** Rejected
   outright — contradicts the faceless product invariant and money-never-ranks posture, and
   would turn a UX feature into a discrimination vector. Not a config flag; not revisitable
   without a product-level ADR.
3. **Photo bytes in Postgres (`bytea`).** Rejected: bloats the identity spine, complicates
   erasure/backups, and the private-bucket posture already exists.
4. **Deriving the photo inside `buildResumeRenderInput`.** Rejected — it is the one shape that
   would leak into the disclosure automatically (shared mapper, shared templates). Caller-
   supplied or nothing.
5. **`permission_handler` + a compression package.** Rejected: `image_picker`'s native
   resize/quality covers it; the repo already ruled against `permission_handler` for voice.

## Open questions (surface, do not silently decide)

1. **Re-render on photo change** — should replacing/removing a photo (or flipping the toggle)
   invalidate/queue a re-render of the latest resume? Ruled a documented limitation for alpha;
   product may want it before launch.
2. **Profile-strength contribution** — the "100% tak pahunchein" nudge implies the photo counts
   toward strength; the server-side strength calculation does not include it yet. Follow-up.
3. **Retention window** — indefinite-until-deleted at alpha; joins the TD58 retention review
   before GA.
4. **ADR-0031 interaction** — if the 7-day grace window lands, the erase leg moves into the
   sweep processor; the prefix-sweep design transfers unchanged.

## Related

- [ADR-0029](0029-voice-audio-at-rest-and-upload-seam.md) — the seam this mirrors
- [ADR-0003](0003-worker-conversation-storage-boundary.md) — bucket posture
- [ADR-0026](0026-production-worker-auth-pin-and-tiered-sessions.md) Phase 5 / [ADR-0031](0031-account-deletion-grace-window.md) — erasure ordering
- `apps/api/src/storage/storage.service.ts` — Mode A seam (`createSignedUploadUrl`,
  `objectExists`, `deletePdf`, `deleteByPrefix`; `downloadObject` + object-info are new here)
- `packages/db/src/schema.ts:78-84` — the prefs columns + the comment this ADR fulfils
- `infra/supabase/storage-buckets.md` — private-bucket provisioning pattern

*This ADR records the worker-profile-photo decision (2026-07-16): ADR-0029's signed-upload
seam applied to a face photo as a new high-sensitivity PII class — own-app + own-resume-PDF
only, structurally payer-invisible, fail-closed dormant behind `WORKER_PHOTOS_BUCKET`,
prefix-swept on erasure, pending Prakash/Akshit sign-off.*
