# Web Apps — Tasks Left for Alpha (payer-web Company + Agency, + ops web)

**Date:** 2026-07-01 · **Verified against `origin/main` `07ebe36`** (A/B batch #173–#181 all merged; no open PRs; B5.1–B5.5 exist as **branches, NOT merged**).
**Contract SoT:** [../api/payer-agency-api-reference.md](../api/payer-agency-api-reference.md). **Scope:** the Next.js **payer-web** (Company `employer` + Agency `agent`) and the internal **ops web** (`apps/web`). *(The Flutter worker app is the separate mobile B1 gate — not "web".)*

## Headline
**Backend for the web apps is COMPLETE on `main`** — every endpoint payer-web needs is merged and LC-1 is closed. The alpha gap is **frontend wiring**: payer-web's data seam (`lib/payer-api.ts`) still calls **5 MOCK shims whose "no payer-authed route yet" comments are now STALE** (the routes merged in #177–#180 today), plus **1 net-new** (plan/boost has an endpoint but no UI). Then staging click-through proves it.

---

## 0. Preconditions (do first)
- **P0 — pull `main`.** Local HEAD is behind #173–#181. `git checkout main && git pull` before touching payer-web, or the endpoints/contracts aren't present locally.
- **Commit the tracker** (`docs/tracker/*`, `docs/api/*`) — still untracked; survives the pull.
- **Local DB fresh-migrate** (Task C) so payer-web + API run together locally for click-through.

---

## A. BACKEND (web-serving) — status: DONE for alpha
Everything payer-web calls is live on `main`. **No backend build task is required for the web alpha.** Verify-only + one Phase-2 program:

| Item | Status | Action |
| ---- | ------ | ------ |
| Auth (signup/login/verify/refresh/logout, `/payer/me`, `PATCH /payer/me`) | LIVE | none |
| Job postings CRUD + close + **pause/resume** (#178) + **quota** (#180) | LIVE | none — FE must wire (B-section) |
| **Payer-authed plan/boost** (#179, LC-1 closed) | LIVE | none — FE net-new (FE-3) |
| **Credit ledger** `GET /payer/credits/ledger` (#177) | LIVE | none — FE must wire (FE-5) |
| Masked-resume `POST /payer/resume-disclosures` | LIVE (payer-authed) | none — FE must wire (FE-1) |
| Unlock/reveal, credits, capacity, applicant feed | LIVE | none |
| Agency jobs/invites/referrals | LIVE | none |
| **Org-tenancy + Team API (B5.1–B5.5)** | **BRANCHES, not merged** | Phase-2 — see A1 |

### A1 — (Phase-2, only if Team is pulled into alpha) merge the B5 org-tenancy stack
- B5.1 (orgs+members schema+backfill), B5.2 (org-lifecycle in signup/login), B5.3 (member API + `PayerOrgRoleGuard`), B5.4 (invite accept + email, **security PASS**), B5.5 (payer-web team wiring) are all **shipped branches, stacked, not merged**.
- **Merge task:** land B5.1→B5.5 in order, each with its security review closed; **renumber migrations** onto current `main` (B5.1 authored `0033`, now taken by #178 → next free) + `_journal.json` fix + sequence-check green.
- **Known gap (by design):** payer resources stay `payer_id`-scoped until the **`org_id` chokepoint flip** (B5.2's deferred half) — so a Team member gets member-management, **not** shared posting/credit access, until that flip. **For a solo-user alpha this is fine — Team is optional.** Decide: Team in alpha (merge B5) or defer (ship payer-web Team as "coming soon").

---

## B. FRONTEND (payer-web) — the real alpha work (owner: FE / Divyanshu)
Each: switch the seam fn from mock → live through the typed `payerFetch` + Zod contract, **update the now-stale "no route yet" comment**, **remove the `mock-store` fallback** so a backend error surfaces (neutral state, not fake success), keep loading/empty/error states, no raw PII. Per-task gate: `pnpm --filter @badabhai/payer-web test` green + a click-through against the local API.

### FE-1 · Masked résumé reveal — `revealMaskedResume` (`lib/payer-api.ts:704`)
- **Now:** mock; comment claims disclosure route is InternalServiceGuard-only. **STALE** — `POST /payer/resume-disclosures` is payer-authed + live.
- **Wire:** `POST /payer/resume-disclosures` `{worker_id, job_posting_id}` → `{ok, disclosure_id, status:'disclosed', resume_url, expires_at}` | `{status:'unavailable'}`.
- **Accept:** real signed `resume_url` opens (masked initials only, no real name); free (no credit debit); `unavailable` on deny; URL never logged. Delete `mockMaskedInitials`.

### FE-2 · Posting pause/resume — `pausePosting`/`resumePosting` (`lib/payer-api.ts:729,742`)
- **Now:** mock-store; comment "no payer-authed pause/resume route." **STALE** — merged #178.
- **Wire:** `POST /payer/job-postings/:id/pause` + `/resume` → posting row (with `paused` state).
- **Accept:** pause moves open→paused and stops the reach feed serving it; resume restores; neutral 404 on foreign id; mock-store branch removed; Manage-Postings UI reflects the `paused` badge/action.

### FE-3 · Buy plan / boost — **NET-NEW seam + UI** (no `buyPlan/buyBoost` in the seam today)
- **Now:** no seam fn exists; endpoint merged #179 (LC-1 closed, payer-authed).
- **Build:** add `buyPlan`/`buyBoost` seam fns → `POST /payer/job-postings/:id/plan` + `/boost` `{tier, coupon?}` (tier code only, **no** payer_id/amount) → quote/receipt; add the Company posting-detail UI action (mirror the capacity "buy" UX).
- **Accept:** session-derived payer (XB-A); MOCK money (`real_call:false`); cross-payer purchase impossible; events emit; UI shows the plan/boost state.

### FE-4 · Posting quota top-up — `topUpPostingQuota` (`lib/payer-api.ts:757`)
- **Now:** mock-store; comment "no quota route." **STALE** — merged #180 (adds `quota_topup_count`).
- **Wire:** `POST /payer/job-postings/:id/quota` → updated plan/posting; surface real quota in the projection (drop the `applicantQuota:=0` placeholder).
- **Accept:** top-up increments the real accumulator; UI shows remaining/added quota; mock-store removed.

### FE-5 · Credit history — `getCreditTopUps` (`lib/payer-api.ts:273`)
- **Now:** reads the caller's OWN mock ledger; comment "no ledger endpoint." **STALE** — merged #177.
- **Wire:** `GET /payer/credits/ledger` (payer-authed, PII-free top-ups + spends) → authoritative history; remove the client-side mock-ledger merge; keep the 12-month expiry view driven by the real ledger.
- **Accept:** Wallet history + expiry come from the live ledger; balance-after-spend reconciles.

### FE-6 · Team / org-members — `lib/org-members.ts` (currently `return []` STUB)
- **Now:** STUB (no directory). Live API is on the **B5.3 branch**; payer-web wiring is **B5.5 branch** (both unmerged).
- **Action:** **only if Team is in alpha (A1 decision)** — merge B5.3+B5.5, then the team seam is live (invite/list/remove + accept-link). Owner-gating rides a `getOrgRole` stub until the session org-role claim lands. **Else** ship the Team page as an honest "coming soon" and skip.

### FE-7 · Wiring integrity sweep (do alongside FE-1..FE-5)
- Update every stale "LIVE-SWAP BLOCKED / no route yet (ask Divyanshu)" comment — those routes now exist.
- Confirm `lib/contracts.ts` Zod shapes match the merged DTOs (API reference is SoT); fix the contract, not the client.
- Ensure the `mock-store` import (`lib/payer-api.ts:44`) is only referenced by things that are still legitimately mock (none should remain after FE-1..FE-5) — then drop dead mock-store code.

---

## C. OPS WEB (`apps/web`) — internal console
- Built (workers / events / ai-jobs read-only). **No build task for alpha.**
- **Verify-only (folds into the B1-sprint Thu admin-ops smoke):** on staging, confirm the console renders live workers/events/ai-jobs and the ADMIN-3a/3b/3c surfaces, with **no secret leak** and PII-free rows.

---

## D. WEB ALPHA GATE — prove it on staging (Phase 1 / roadmap Phase 3)
Wiring done ≠ alpha done. After FE-1..FE-5, run the two web click-throughs on staging (needs the P0 staging box up):
- **Payer company gate:** signup → dashboard → post job → pause/resume → applicants → unlock → reveal → masked-resume → wallet/ledger → capacity → buy plan/boost.
- **Agency gate:** agent login → agency dashboard → create/manage vacancy → invite → faceless referrals → **company blocked from agency routes** (role guard).
- **Evidence:** screenshots + staging `events` export (PII-free) + a `/health` 200, indexed in [QA_EVIDENCE.md](QA_EVIDENCE.md). Scripts in [TEST_MATRIX.md](TEST_MATRIX.md).

---

## Sequencing & owners
1. **P0/precondition** — pull main + local DB migrate (Prakash/whoever runs local).
2. **FE-1 → FE-2 → FE-4 → FE-5** (mock→live swaps; independent, small; can parallelize) — **owner: FE/Divyanshu**.
3. **FE-3** (plan/boost net-new UI) — slightly larger.
4. **FE-7** integrity sweep (rolls through 1–3).
5. **A1 + FE-6** Team — only if pulled into alpha (owner decision); else "coming soon".
6. **D** staging click-throughs — after staging box is up (Prakash) — **owner: QA/Prakash**.

**Not in web alpha (scope guard):** real payments/WhatsApp (mock stays), real member-invite email (`MEMBER_INVITES_ENABLE_REAL` off, §7), org_id chokepoint flip (Phase-2), learned ranking, KYC/payouts.

**Decision needed from you:** is **Team/multi-user (B5) in the web alpha**, or deferred (ship "coming soon")? That's the only open scope question for the web apps.
