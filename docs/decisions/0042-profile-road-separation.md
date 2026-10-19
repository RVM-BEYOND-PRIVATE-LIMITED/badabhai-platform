# ADR-0042: Profile roads — one source of record, résumé trade association, and the trade-form OFFER

- **Status:** **Accepted** — owner rulings taken and recorded 2026-09-16. Signature block at the foot.
- **Date:** 2026-09-16
- **Owner:** CEO / Prakash
- **Relates:** [ADR-0041](0041-resume-import-and-prefill.md) (résumé import — amended only where it
  touches the upload road; see §6) · [ADR-0036](0036-matching-algorithm-v1.md) (rank tuple — untouched
  by this ADR; nothing here is a rank input)
- **Implemented by:** tasks **B1–B4** of the flow-separation programme (B1 + B2 + the offer landed;
  B3/B4 landing behind it) plus the Layer-A rollout it scopes.

---

## 1. Context

The worker platform grew **three roads to a profile** without ever naming them:

1. **The form road** — a trade form (one of the 21 declared role descriptors, 9 enabled), reached by
   a mid-chat handover or a résumé routed to a form.
2. **The chat road** — the LLM-led interview, every trade without a form.
3. **The upload road** — the two-door entry ("Resume hai" / "Resume nahi hai"), where an uploaded
   document is parsed, associated, and routed onto one of the two roads above.

A code audit (2026-09-16) established the defects this ADR closes:

- **Nothing recorded which road produced a profile.** Navigation, profile screens and the résumé
  renderer inferred it from coincidental proxies ("does a form exist?"), which is what mixed the roads.
- **The chat→form handover was a GATE**, not a choice: the moment the router recognised a
  form-enabled trade, the interview closed and the worker was pushed onto the form.
- **Résumé association was implicit and binary** — a deterministic term match over two model labels,
  with no recorded judgment and no confidence; a miss routed to chat and was only caught mid-chat.
- **The upload→chat road opened with the generic "what work do you do" greeting** instead of
  confirming the parsed document, and the confirm arrived one turn late.
- **Profile screens and résumé types had no source dimension**, so chat profiles and form profiles
  rendered the same shapes.

---

## 2. Decisions (all rulings taken 2026-09-16)

### D1 — `worker_profiles.source` is the source of record; NULL means unknown

Every profile carries `source ∈ {form, chat}`, written **once, deterministically, by the extraction
processor** from the channel record (the session's `form_kind`, else the latest résumé import's
`route`) — **never by the model**, never re-derived on read. NULL is legal for rows written before
migration 0107 and means _unknown_, never a guessed road. Migration 0107 backfilled history with
the same rule (form evidence anywhere ⇒ `form`, else `chat`).

Exposed on `GET /workers/me/profile-summary` (`source`) and, additively, on `profile.confirmed`
and `resume.generated` (`profile_source`). Navigation and rendering move to source-keyed behaviour
(task B4 and the app issues); the old "does a form exist?" probe survives only as an old-server
fallback.

### D2 — The résumé association is a classification among closed options, recorded, never a decision

The parse returns `trade_association.kind`: one id from the caller-supplied closed list
(`TRADE_FORM_KINDS_ALL`, 21), or NULL. This is the ADR-0041 §6 posture applied verbatim — **the
model selects among options; code decides**. `routeToTradeForm` remains the only router; membership
is enforced on both sides; a mangled value degrades to NULL without costing the cited fields.

The judgment is **recorded, not acted on**: `worker_resume_import.association_kind` (migration 0108)
rides the same guarded settle as the route and is exposed on `GET /profiling/resume-import/:id`.
It exists for coverage measurement (RI-7) and for any future recall decision, which would be its
own ruled change.

### D3 — Mid-chat handover is an OFFER, not a gate

Deterministic code decides **eligibility** (`routeToTradeForm`, unchanged); the **worker** decides
whether to take the form. The turn that used to close the interview now serves one non-blocking
question — the standard Haan/Nahi chips, `kind: ask` + `single_select`, **no new wire shape**:

- **Accept** runs the exact handover the gate ran: settlement first, sticky `formKind`, Phase A off,
  the close turn with its CTA.
- **Decline** settles the offer, commits nothing, and the interview continues on the same bubble.
- The offer is **never served twice**; an unreadable reply is a decline, never an accept and never
  a re-ask.
- Phase A's own draft is settled **on the offer** (the worker's words, not a document's claims), so
  a decline cannot walk back into a re-ask of the trade just named.
- **The offer does not depend on the model answering** (#2245, 2026-10-14). Eligibility is the
  deterministic router over the draft plus the catalogue pin, so the turn Phase A falls back on
  serves the same offer when the router routes. There's no trade-confirm gate in front of it: the
  fallen-back interview is deterministic, and the gate confirms only what a model turn inferred.
  It is not served on a capped turn, on the skills lane, or for a trade the worker declined
  without confirming another. Decline is today's engine path. `profile.form_offered` keeps its v1
  payload. To tell a fallback offer apart from a led one, join on `profile.llm_interview_fallback`
  for the same session: `llm_led_turns: 0` marks only a first-turn fallback, and an armed general
  road records the lane as `model_unavailable` rather than `form_offered`.

Two additive events: `profile.form_offered` (once per session; counts + closed kind) and
`profile.form_offer_declined` (`reply: declined | unclear` — counted apart so the reader's miss
rate stays visible). `profile.form_mode_entered` still counts accepts; offered − entered − declined
is mid-offer abandonment.

### D4 — The chat road's completion never re-asks a settled fact

`/finishing` on the chat road is **NET-NEW-ONLY**: a fact already settled anywhere (chat, form,
upload, seed) is never asked again. Consistent with the 2026-09-15 owner rulings on #1503–#1506
and with the double-ask defect the trade-form append removal closed. Implemented in task B4 with
the route-by-source change (§3).

### D5 — Area/locality stays ABSENT in v1

No locality, area, pincode or address is collected or stored. The `workers` policy of never holding
finer-than-city location stands unchanged. (Revisit only as its own ruled change, with the privacy
wall re-argued.)

### D6 — Gender and date of birth stay ABSENT

Never collected, never stored, never displayed — and the matching spec already forbids their use as
rank inputs. Nothing in the universal-profile programme will change that; a future business need
would need a new signed ruling first, not a migration.

### D7 — Photo capture is out of scope; the existing pipeline is reused as-is

The photo field, storage seam, pref and render gating (ADR-0032) are complete. The universal-profile
programme reuses them untouched; no capture-flow changes are included.

### D8 — Confirm-first open on the upload road; route-by-source on completion

- A session opened from the upload road whose parse is waiting **opens with the résumé confirm**
  ("Resume se ye mila: … Sahi hai?" + chips), not the generic greeting; accept prefills through the
  existing ruling-D2 path, decline continues normally (task B3).
- `POST /profile/confirm` tells the app where to go next: `trade_form` when the profile is on the
  form road and a form exists, `chat_complete` otherwise — chat-road completions go on to the
  résumé, never the form (task B4). The old client-side form probe is a fallback only.

### D9 — The universal-profile programme is attribute-first and anti-bias by construction

Bar 5 of the flow-separation programme (Layer A) proceeds under the constraints stated here: every
new field is an **attribute/filter**, never a rank key (any new `mskill_*` or rank key remains a
STOP condition requiring a new `engine_version` + ADR — this ADR grants none); new sensitive fields
(WhatsApp, licence numbers/expiry) are **default-hidden on employer views**; the fabrication gate
extends to every new résumé section (closed labels, stated numbers, the worker's own words — no
fourth source); and #1350 remains the only LLM rewrite.

---

## 3. Where the implementation lands

| #       | Change                                                                                    | State                           |
| ------- | ----------------------------------------------------------------------------------------- | ------------------------------- |
| B1      | `source` column + backfill + exposure + `profile_source` on two events                    | **Landed** (`385372bd`)         |
| B2      | Résumé trade classification (closed 21) + `association_kind` (0108) + read-route exposure | **Landed** (PR #1532)           |
| —       | The OFFER recall path (D3) + the two offer events                                         | **Landed** (PR #1532)           |
| B3      | Confirm-first chat open (D8)                                                              | Landing behind PR #1532         |
| B4      | Route-by-source + net-new-only finishing (D4, D8)                                         | Landing behind PR #1532         |
| Layer A | Universal fields under D5–D7, D9                                                          | This programme, one PR per area |

---

## 4. What is explicitly NOT changed

- `routeToTradeForm` — still the only router; no new routing evidence.
- The rank tuple (ADR-0036) — no field, event or judgment added here is a rank input.
- The event spine — two additive events; every existing payload keeps its shape and version.
- ADR-0041's upload privacy posture (D1–D9 there) — untouched; §6 below only amends where the
  upload road meets the chat.

---

## 5. Compatibility and privacy

- **Additive throughout**: nullable column + CHECK (0107), nullable column + CHECK (0108), two new
  events, optional response fields. Old clients and old server builds keep working; the offer reuses
  the shipped `ask` shape so no app release is required to accept or decline it.
- **Privacy**: every new event carries ids, closed enums and counts only — no labels, no values. The
  classification rides the existing gated parse contract; nothing here widens the AI boundary.

---

## 6. Amendment to ADR-0041, narrowly scoped to the upload road

ADR-0041 §5's "suggestion beside the question" mechanics stand. This ADR amends only the upload
road's **chat-open behaviour**: a résumé-routed-to-chat session now opens with the confirm turn
(D8/B3) instead of the generic greeting, and the résumé's association is recorded (D2). The parse
prompt gains the closed association question; the citation gates, the staging rule (D2 there), and
the privacy override (§3 there) are untouched.

---

## 7. Consequences

- The three roads are finally **representable** — routing, screens and résumé types can key off one
  stored fact instead of proxies.
- Workers keep the choice the product said they had; the form funnel gains a measurable decline step.
- The classification gives RI-7 the coverage number it was promised, with zero new AI authority.
- Residual: pre-0107 rows carry NULL until re-extracted (accepted; self-corrects on next extraction).

---

## 8. Open / follow-ups

1. **Finishing net-new-only** (D4/B4) — includes deciding the surface for language/documents on the
   chat road (the two items the chat does not ask).
2. **App consumption** — issues #1522–#1528 are the frontend counterpart; they get the final
   contracts when this programme's backend lands.
3. **Layer A rollout** — one PR per area; each obeys D9's constraints. Any rank-key proposal stops
   the programme for sign-off.

---

```
Recorded on the owner's behalf from the rulings given 2026-09-16.
Signed (CEO / Prakash): Prakash Kantumutchu          Date: 2026-09-16
```

---

## 9. Amendment — fill-gap Phase 1: `languages` and `work_types` join the chat (2026-09-17)

D9's universal-field programme picked its first two CHAT elicitations, resolving follow-up §8.1 in
part. `qp_universal@3` adds `languages` and `work_types` as `attribute` `multi_select`s over the
closed chip vocabularies the finishing form already writes (`LANGUAGES`, `WORK_TYPES`/`JOB_TYPES`),
and `CHAT_FACT_OWNER` flips both facts to `chat`. Four consequences are explicit:

1. **The ask budget is the limit, and it is now spent.** `MAX_ENGINE_ASKS` is 28 and the worst-case
   worker (`qp_cnc_turning`'s 15 + three mandatory re-asks + the tail) now consumes it exactly —
   headroom 0, pinned by `ask-budget.guard.test.ts`. The remaining allow-listed fields (language
   proficiency, `commute_max_km`, `willing_to_travel`, `available_from`, `salary_period`, training,
   secondary occupations) stay **pages-owned**; the Phase 3 settled-vs-missing view is their
   discoverability surface, not the chat.
2. **Proficiency stays out of the chat deliberately** — speak/read/write is a 16-language x 3-tick
   matrix a chip question cannot express honestly; `worker_language` (0110) remains its home.
3. **One projector carve-out, named and test-pinned.** `languages` carries a crosswalk entry with a
   `null` `draftPath` (no résumé column), which until now meant "dropped from every projection".
   `worker_attributes.languages` is the one store the sheet's Languages row reads and the form
   writes, so the projector's attribute leg now admits it by explicit allowlist
   (`ATTRIBUTE_FIELDS_WITHOUT_DRAFT_PATH`); the draft still refuses it, and `work_history`'s drop is
   unchanged.
4. **No rank input, no new authority.** Both fields are attribute/filter values; the capture path is
   deterministic (`matchOptions` over closed chips), no LLM call is added, no migration and no event
   is introduced. v2 is deprecated but retained — pinned sessions keep resolving.

---

## 10. Amendment — Layer A elicitation: eight fields join the chat (2026-09-18)

This supersedes §9's consequence 1 ("the remaining allow-listed fields stay pages-owned"). The
owner policy of 2026-09-18 (`MAX_ENGINE_ASKS` 28 → 48, "budget is not a constraint; app feel is
paramount") removed the constraint that deferred them, and `qp_universal@4` authors the eight as
chat asks. The rest of §9 stands untouched — the `languages` projector carve-out, the proficiency
exclusion and the no-rank-input posture are unchanged.

1. **What joins the chat, and where each answer lands.** `commute_max_km` (number) and
   `willing_to_travel` (boolean) reuse the exact `worker_attributes` keys the preferences page
   writes; `salary_period` is a closed single_select over the same `month|day|year` slugs.
   `notice_period_days` (number) is a part of the `availability` fact and settles it, riding the
   existing field normalizer over `parseAvailability`. `training_name|provider|year` and
   `secondary_occupations` are Layer A **storages**: their chat answers are assembled by the
   extraction processor's table write leg into `worker_training` and `worker_occupation`, the same
   tables their pages own, so exactly one store settles each. The write legs are
   insert-only-when-empty — a page-written row is never edited.
2. **`CHAT_FACT_OWNER` flips three facts to `chat`** (`salary_period`, `commute_max_km`,
   `willing_to_travel`) and adds `notice_period_days` as a settling alias of the already-chat
   `availability` fact. Everything else stays pages-owned exactly as §9 left it:
   `preferred_locations`, `shift`, `salary_expected`, `education`, `certifications`,
   `documents_ready`, `job_type`, `relocation`, `accommodation`.
3. **`available_from` is deliberately NOT a chat ask.** It is a calendar date; a chip/number
   question cannot honestly produce one, and the notice-period answer narrows the same availability
   state. The finishing form remains its capture surface.
4. **The training trio is gated on its name** (`ask_if: answered(training_name)`), so a worker with
   no course answers one question instead of declining three in a row; a decline is terminal,
   exactly as everywhere else. `secondary_occupations` is a closed multi over the 13 taxonomy
   `role_*` ids — the same id space `worker_occupation` and the role bridge use.
5. **No rank input, no new authority.** Every field is an attribute/filter or a résumé table row;
   the capture path is deterministic (`matchOptions` over closed chips, the new `parseCommuteKm` /
   `parseTrainingYear` parsers, `parseAffirmation` for the boolean); no LLM call is added, no
   migration and no event is introduced. `v3` is deprecated in place and pinned sessions keep
   resolving.

---

## 11. Amendment — the training gate: the trio opens on a Haan/Nahi question, gated by occupation (2026-10-17)

Owner rulings 2026-10-17. The §10 trio reached every chat worker; the observed failure was a typed
non-answer stored as a training name ("kuch nahi koya") with a year behind it, and training
questions put to workers the questions do not fit. `qp_universal@5` answers both with DATA — one
new item and two conditions; every v4 item is otherwise byte-identical.

1. **The gate.** `training_done` (boolean, "Kya aapne koi training ya course kiya hai?") is the
   trio's single entry point; `training_name` carries `ask_if: eq(training_done, true)`, and
   `training_provider` / `training_year` keep `answered(training_name)`. A Nahi, a decline, or an
   unanswered gate ends the trio; the rest of the tail runs unchanged.
2. **The occupation condition.** The gate carries `ask_if: any(occupation_is × 70)` — the
   `job_domain_id`s bound to the SIXTEEN form-enabled families in `_families.jsonl`. A worker whose
   pin is outside that closed set, or who has NO pin, is never asked the gate or the trio: the
   `ask_if` fail direction (unevaluatable → false) IS the ruling. `occupation_under` is deliberately
   unused — `isco_unit_code` is nullable for rvm-minted pins while `job_domain_id` is always
   present.
3. **The refusal floor.** The #2328/#2339 none handling ("kuch nahi koya", "nahi kia", "maine
   nahi kiya", the Devanagari forms, "none") stays the deterministic layer beneath the question,
   and the 2026-10-17 follow-up widens it: a BARE refusal ("not interested", "yeh mera kaam nahi")
   declines ANY on-screen question — typed ones keep a parsed value's first claim, so "nahi" on
   the gate is its real `false`, never a decline — and the understanding prompt reads "does not
   apply to me" as `on_screen_none`. The trio exits as ONE group: the year additionally requires
   the provider NOT declined.
4. **No rank input, no new authority, no migration, no event.** One attribute (`training_done`) is
   written; the gate is a boolean the pack's own condition reads. The ask-budget walk moves 36 → 37
   (headroom 12 → 11 against the unchanged cap of 48), pinned by the guard. `v4` is deprecated in
   place; pinned v4 sessions keep resolving and keep the ungated trio.

---

## 12. Amendment — travel first, km only on Haan: the gate moves ahead of the number (2026-10-19)

Owner ruling 2026-10-19. The §10 pair asked the km number BEFORE the Haan/Nahi travel gate, so a
worker answering Nahi, "pata nahi", declining, or skipping still paid for the km question.
`qp_universal@6` answers with DATA — one reorder and one condition; every v5 item is otherwise
byte-identical.

1. **The reorder.** `willing_to_travel` (boolean, "Kya aap ghar se door kaam ke liye ja sakte
   hain?") moves IMMEDIATELY BEFORE `commute_max_km` ("Kaam ke liye aap kitne km tak ja sakte
   hain?").
2. **The gate.** `commute_max_km` carries `ask_if: eq(willing_to_travel, true)` — the same shape
   the trio's name already uses on its gate. Haan (and "haan ji", "bilkul", pinned in the
   affirmation tests) serves the km next; Nahi, "pata nahi", a decline, or an unanswered gate
   ends the pair and `notice_period_days` follows. The rest of the tail runs unchanged.
3. **No rank input, no new authority, no migration, no event.** No wording changes, so the
   served-text golden gains an entry with the v5 sha, the reply closure and its ai-service mirror
   are byte-identical, and the Devanagari twins (keyed by roman text) cover v6 unchanged. The
   ask-budget walk holds 37 (headroom 11 against the unchanged cap of 48) — the reorder adds no
   item. `v5` is deprecated in place; pinned v5 sessions keep resolving and keep the old order.
