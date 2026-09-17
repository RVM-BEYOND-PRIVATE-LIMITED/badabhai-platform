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
