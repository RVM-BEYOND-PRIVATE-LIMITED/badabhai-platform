# ADR-0043: Résumé history (show the newest three, labelled by flow) and the chat-accepted update

- **Status:** **Accepted** — owner rulings R1–R4 taken 2026-09-24.
- **Date:** 2026-09-24
- **Owner:** CEO / Prakash
- **Relates:** [ADR-0042](0042-profile-road-separation.md) (profile roads — `worker_profiles.source`
  is read here, never widened) · [ADR-0041](0041-resume-import-and-prefill.md) (résumé import — its
  identity "haan" and batch-confirm are what label a résumé `resume_upload`) · [ADR-0032](0032-worker-profile-photo.md)
  (photo — the fail-closed erasure re-render this ADR fans out)
- **Implemented by:** the backend PR that adds migration `0125_resume_history`; the worker-app half
  is issues #1687 (history UI), #1688 (waiting on an update), #1689 (the chat offer), #1690
  (stale-résumé reuse, pre-existing).

---

## 1. Context

A worker could effectively see only ONE résumé, and could not update it from the chat:

- **Auto-generate never ran for a returning worker.** `ResumeGenerateProcessor` skipped any worker
  who already had a résumé, so a redo chat, a new form walk or a CV import produced no new résumé —
  and the chat's own "Baat poori hote hi naya resume ban jayega" was false for them.
- **A manual regenerate overwrote the old résumé in place** (`createInitial({overwrite:true})`).
- **The two "latest" readers disagreed.** `latestResume` sorted by `version`, the employer-disclosure
  read by `generated_at`; `version` is per profile, so an older profile's v2 hid a newer profile's v1.
- **No row recorded which flow made it**, there was no list endpoint, and nothing in the chat asked
  "shall I update your résumé?".

---

## 2. Decisions

| # | Ruling |
|---|---|
| **R1** | A résumé is labelled **`resume_upload`** when the worker ACCEPTED a CV import in the session that produced its profile — the identity "haan, ye main hoon", a batch-confirm "yes" with at least one value, or an autofill that applied one. Otherwise the profile's road (`form` / `chat`). A profile with no recorded road (pre-0107) carries **no** label. |
| **R2** | **Every AI generation is its own history entry** — the auto-generate, a worker's regenerate (including the trade-form "done" rebuild), an accepted chat update, an ops regenerate. LLM-free forced re-renders (photo, name, languages, qualifications, preferences, work-history source) keep refreshing the CURRENT résumé in place. |
| **R3** | At the **end of any chat interview**, a worker who **already has a résumé** is asked *"Aapki nayi jaankari se resume update kar doon?"* [Haan, update karein / Abhi nahi]. **Haan is the acceptance**: the profile the interview produces is confirmed without the preview and a new résumé is generated in the background. First-time workers are never asked. Free-form updates in the Bada Bhai tab after the interview are **Phase 2** and need their own ADR. |
| **R4** | **Keep all, show three.** No résumé is ever deleted; `GET /resume/history` lists the newest three. The one deviation is privacy-mandated: an erasure (photo removed, WhatsApp cleared) is re-rendered onto **every** rendered résumé the worker owns, not just the current one. |

---

## 3. Design

### 3.1 Data (migration 0125, additive, APPLY BEFORE DEPLOY)

- `generated_resumes.generation_source` (`form` | `chat` | `resume_upload`, NULL) and
  `generation_trigger` (`profile_confirmed` | `manual` | `chat_update_accepted` | `ops_regenerate`,
  NULL), both behind NULL-tolerant CHECKs pinned to `RESUME_SOURCES` / `RESUME_GENERATION_TRIGGERS`.
- `generated_resumes_worker_generated_idx (worker_id, generated_at DESC, id DESC)` — the one
  definition of "the current résumé" and the history read (`NEWEST_RESUME_FIRST`).
- `worker_profiles.seeded_from_import_id` (FK → `worker_resume_import`, ON DELETE SET NULL) and
  `resume_update_accepted_at` — facts, written once by the extraction processor from the session.
- `worker_profiles.source` is **not** widened: `resume_upload` is a fact about the session, not a
  third road, and every reader of `source` keeps its two values.

### 3.2 Which entry a generation becomes (`ResumeService.generate`)

| Path | Row |
|---|---|
| ops regenerate | a new entry, numbered `maxVersion + 1` |
| system (auto-generate, accepted update) | the profile's initial row, insert-if-absent (idempotent) |
| manual, profile has no résumé | the profile's initial row, authoritative (unchanged) |
| manual, profile's newest row still `pending`, or written after this call started | **converge** on it (guarded UPDATE) — the same generation twice is one entry, including the first-time auto-generate racing the app's own POST |
| manual, anything else | **a new entry** |

`version` is a per-worker counter, never a history ordinal, and is not exposed by the history API.
Event selection (`resume.generated` vs `.regenerated`) is unchanged; both gain additive
`resume_source` / `trigger`.

### 3.3 The chat offer

- Deterministic fixed copy and chips (`update_offer_yes` / `update_offer_no`), served by the
  orchestrator at the point the engine decides to `close` — never on `abuse_cap` / `no_pack`, never
  over a form handover — to workers `ResumeUpdateOfferPolicy` finds eligible (flag
  `RESUME_CHAT_UPDATE_OFFER_ENABLED`, default **off**, and a résumé on file).
- The answer turn reads only the answer (it runs before capture and identify) and closes with the
  engine's stored completion reason. **Only an unambiguous yes is a yes**: the chip, its label, or a
  whole utterance from a closed set (`haan`, `haan ji`, `yes`, `हाँ`, …). Any negator, any `?`, any
  other words is a **no** — deliberately NOT the lexicon's `parseAffirmation`, which reads "nahi,
  purana theek hai" and "main khud kar lunga" as yes (security review). **`profile.resume_update_answered`**
  (v1, ids + yes/no) is emitted only after the turn's CAS wins. A session idle at the offer is
  finalized as "Abhi nahi" by the abandonment sweep, never abandoned — and its "no" is recorded
  only if the sweep's flush became the record, so a worker's simultaneous "Haan" is never
  contradicted. `resume_update: "queued"` is sent only by the turn whose flush became the record.
- The answer and the accepted import reach Postgres as loose `conversation_state` keys
  (`resume_update`, `import_applied_id`) beside `form_kind` — outside the frozen `ConversationState`.

### 3.4 The accepted update, end to end

`finalizeInterview` extracts even for a worker who already has a profile → the extraction processor
re-checks consent (the extraction is now off-request), writes `resume_update_accepted_at` and the
ownership-verified `seeded_from_import_id`, and calls `ProfilesService.confirmAcceptedUpdate` — which
refuses a `draft` profile, a profile with no acceptance, and a worker whose consent is no longer
active **or does not name `resume_generation`** (fail-closed; `hasActiveConsent` is the off-request
twin of `ConsentGuard`) → the ordinary confirm enqueues the generate → `ResumeGenerateProcessor`
bypasses its one-per-worker skip **only** for a profile carrying the acceptance (idempotent per
profile under the bypass, consent re-checked again) → a new entry with `trigger:
chat_update_accepted`, metered against the worker's daily cap once per Haan: a queue retry is not
re-charged, and the cap's refusal is terminal (never retried, since a retry is exempt). The terminal chat response carries
`resume_update: "queued"`; `GET /resume/history` reports `pending_update` (`in_progress` / `failed`,
failed after `RESUME_UPDATE_PENDING_TIMEOUT_SECONDS` or a failed/empty extraction).

### 3.5 History entries are not redrawn

A cosmetic forced re-render aimed at a rendered résumé that is no longer current is skipped (the
trade-form refresh is queued 60 s ahead against whatever was current then). Fail-closed erasures are
exempt: the current résumé's job is enqueued first, exactly as before, then every other rendered or
pending résumé. An older résumé's erasure collapses only into a keyed job that has NOT STARTED
(`erasure-rerender:<id>`, then `…:next`) — a waiting job will read the erased state, which bounds a
toggle storm; a RUNNING job may have read the face before the erasure, so it never absorbs one.

---

## 4. Consequences

- **Backward compatible for shipped clients.** No request shape changes; `resume_update` and the
  history route are additive. A shipped app still shows the preview after a Haan; the server
  dedupes what it then calls.
- **APPLY BEFORE DEPLOY.** Drizzle names every schema column in every select on both tables; a build
  against a database without 0125 fails every résumé and profile read. Registered in
  `schema-contract.ts` as `0125-resume-history-*`.
- **Launch gate — pre-existing PDFs.** Erasures made BEFORE this change reached only one row, so
  older rendered résumés of workers who redid an interview can still carry a photo or number they
  have since removed. `GET /resume/history` makes those rows listable; a one-time fail-closed
  re-render of every rendered non-current row must run before the history UI (#1687) ships.
- **Storage grows without bound** by design (R4). Every retained PDF carries the worker's name,
  phone and (if shown) photo, so a DPDP retention decision is owed before public launch. A retention rule, if ever wanted, is a new ADR —
  note `resume_disclosures.resume_ref` is `ON DELETE SET NULL`, so deleting a row an employer was
  shown loses the record of which version they saw.
- **Rollout:** migrate → deploy (flag off: history recorded, nothing asked) → worker-app #1687–#1690
  → flip `RESUME_CHAT_UPDATE_OFFER_ENABLED` on staging, then production.
