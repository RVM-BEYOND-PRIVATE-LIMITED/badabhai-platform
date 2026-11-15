# ADR-0064: Applicants and contacts — the source label, facts before paying, contacts open for good, selected and hired

- **Status:** Proposed — awaiting owner sign-off (Akshit for the brief's rulings; Prakash as the other backend developer). No switch in this ADR is armed in production before it is signed.
- **Date:** 2026-11-15
- **Owner:** Divyanshu (Backend Platform).
- **Issue:** #2747 (brief 4B.3–4B.8, plan 4.2). Built in parts, each behind its own switch (§3.7).
- **Amends:**
  - [ADR-0010](0010-contact-unlock-and-reveal.md) — Decision 1 (the unlock is a bounded window with bounded attempts), Decision 2 (the phone number never crosses the API) and Decision 4 (the per-worker caps count every reveal).
  - [ADR-0047](0047-lift-pii-restriction.md) §4 — "employer-side disclosure masking: the masked profile until a credit unlock, the name as initials on the employer copy".
  - The owner ruling of 18 Sep 2026 that the phone number is shown only inside the résumé PDF.

## 1. Context

The brief asks for one applicant list that shows RVM students and BadaBhai workers together, each labelled; RVM students out of company search; a card that tells a company enough to decide before it pays; a paid contact that stays open; and a company's "selected" or "hired" mark on an RVM student reaching RVM's system, where the student uploads proof for the reward and the placement team verifies it. The company's mark alone never releases money.

What the code did before #2747: cards were faceless (opaque ids, bands and closed labels); the name was initials even after an unlock; salary was withheld; the unlock lasted 14 days (`UNLOCK_WINDOW_DAYS`) and a later grant debited again; the phone number was only inside the résumé PDF and the app got a relay handle; the pipeline had three stages (`new`, `shortlist`, `passed`); nothing was sent to another system.

## 2. Earlier rulings this ADR replaces

| Today in the code | Brief | Part |
| --- | --- | --- |
| Cards are faceless before an unlock; ADR-0047 §4 keeps the profile masked until then | First name, trade or course, expected salary, machines, area and a last-active date before paying (4B.5) | A (built) |
| Cards show a last-active band, not a date; area and machines are deliberately not shown | Date, area and machines shown | A (built) |
| Expected salary withheld even after an unlock | Expected salary before paying. The brief is silent on the photo: it stays withheld | A (built) |
| Name as initials after an unlock (`maskInitials` in `ResumeDisclosureService.renderAndDisclose`) | Full name on opening (4B.6) | B |
| Phone only inside the résumé PDF (18 Sep 2026); `reveal` returns a relay handle | Phone number shown after opening | B |
| An unlock lasts 14 days; after that a new grant debits again | Open for good; re-opening costs nothing | B |
| `UNLOCK_MAX_ATTEMPTS_PER_UNLOCK` (3) refuses a fourth reveal; the per-worker daily cap (5) counts reveals and résumé disclosures together | These limits are kept for FIRST opens only; they never stop a company reading a contact it already opened | B |
| Three pipeline stages | `selected` and `hired` added | C |
| Nothing leaves BadaBhai | A selected or hired mark on an RVM student is sent to RVM once | D |

## 3. Decision

### 3.1 The source label (always on)

Every company-facing applicant row (the per-job list, the cross-posting inbox) and every search row carries `source`: `rvm_student` when the worker has an ACTIVE `worker_institute_links` row for RVM (#2752), else `badabhai_worker`. It is the same fact that keeps him out of company search and labels him in the admin console; no second column is added. It is a label, not a disclosure, so it has no switch. A row that already carries `instituteCode` from its own list statement is labelled from it, so the two cannot disagree.

Search and opening rules for RVM students were built by #2752 and are reused unchanged: an actively linked student is outside `consentingWorkers` except for a company holding his named-company search grant, and `InstituteOpenGate` lets only a company whose job he applied to open him.

### 3.2 Facts before paying (part A, `APPLICANT_FACTS_ROLLOUT`)

While the switch is on for a company, each of its applicant and search rows carries all six keys; `null` means "not given". While it is off, none is sent.

| Key | Source | Rule |
| --- | --- | --- |
| `firstName` | `workers.full_name`, decrypted per page | The first word; a word with a digit or `@` is not a name and reads as not given; never the surname |
| `tradeLine` | the current profile's role or trade id; an RVM student's course | The closed taxonomy only — the model's free-text `role_label` is not a fallback; the course is RVM's text, bounded to 80 characters |
| `expectedSalary` | admin correction, then `salary_expectation`, then the worker's band | The résumé's own precedence and formatters; a one-sided band prints one figure; the form's top chip prints "₹50,000+" |
| `machines` | the current profile's machine ids | Closed labels, at most 8 |
| `area` | `workers.current_city` (with a live correction); an RVM student's branch | A gazetteer city only; the branch counts when its name is a known city |
| `lastActiveOn` | the latest `worker_devices.last_seen_at` | The IST day; a future timestamp reads as today |

Still withheld before paying: the surname, phone number, photo, employer names, address and anything typed in the worker's own words. The brief's other facts (level, experience, availability) were already on the card (#2736).

**Consent, row by row.** The facts follow the same consent rule as everything else a company can see of a worker: his LATEST consent row must be unrevoked and list `employer_sharing` (the search pool's rule), or, for an actively linked RVM student, the institute rule decides (#2752). Without it — the "stop employer contact" exit, an under-18 declaration — he stays on the list he applied to and every fact reads "not given"; his name is never decrypted.

**Closed values only.** A machine id the taxonomy does not know is dropped (the column can hold model-extracted phrases). A first name or RVM course carrying a control, bidi or stray format character is not shown (the Campus label rule). A leading title or initial is skipped ("Md. Aslam Khan" → "Aslam"); a surname-first name gives its first word.

**Salary before paying, not on the paid sheet.** The employer copy of the résumé still prints no salary (ADR-0047 §4's audience rule). The card now shows it before paying; the two differ on purpose until the owner rules on the résumé.

**Plaintext discipline.** The name is decrypted in `PrePayFactsService`, per page, cut to its first word and dropped with the response. It is never cached, never logged and never put in an event; a decrypt failure is logged with the worker id only. ADR-0047 lets raw personal data into logs and events; this read does not take that allowance, and the RVM student data in it never does.

**Ordering.** The decoration runs before the list's `feed.shown` and before the search's `payer.candidate_search_performed`, so a failed facts read fails the request with nothing emitted.

**RVM student defaults (issue defaults, confirmable):** first name, the course as the trade line and the branch city as the area; the other facts read "not given" unless he filled a BadaBhai profile. His test score and current-or-alumnus status show only after opening.

### 3.3 The contact a credit opens (part B, built, `CONTACT_RULES_ROLLOUT`)

`GET /payer/unlocks/:unlockId/contact` returns `full_name`, `phone` and `opened_at` with `Cache-Control: no-store`; the response body is never logged. Off for the company, the route is a 404. Every refusal is the one neutral body, in this order: not the company's tenant (or unknown); worker erased (`worker_id` null); the row never opened; pending deletion or suspended; consent no longer given (`isOpenableBy`: his own `employer_sharing`, or for an actively linked RVM student the institute rule). Each read counts against the per-login hourly limit (`PAYER_DISCLOSURE_MAX_PER_HOUR`) and writes `contact.viewed` (ids only) BEFORE the answer — if the audit cannot be written, nothing is shown. `contact.revealed` keeps its payload, because showing a number on screen is a different act from a relay reveal.

The phone and the name are decrypted in one named place, `UnlockService.decryptContact`; the BC-5 static guard (ADR-0010 §6) now pins exactly two decrypt sites on the unlock path — the relay wiring and this one.

The résumé stays on `POST /payer/resume-disclosures` and, while the rule is on, prints the full name instead of the initials (payer route only; the ops route never does). Its salary stays withheld (§3.2).

### 3.4 Open for good (part B, built, `CONTACT_RULES_ROLLOUT`)

One definition of "open", `isOpenGrant` (`apps/api/src/unlocks/open-grant.ts`): `granted` or `revealed`, and — while the rule is on for the company — whatever the stored date; off, unexpired as before. The reveal, the contact read and the résumé's SQL (`hasLiveUnlock`) all use it, so a contact opened under the old window is honoured with no backfill.

Writes keep "for good" after a rollback. A grant made while the rule is on stores `expires_at = 2099-12-31T23:59:59Z` (shipped apps still parse a date) and answers `open_until: null`; a re-open (`POST /payer/unlocks`) or a reveal of a lapsed contact while the rule is on moves its stored dates (grant and relay row) there too, under the worker lock, only ever later (`extendOpenUntil`). Re-opening costs nothing: the held grant is returned with no debit. `GET /payer/unlocks` stops reading `expired` for an open contact.

Erasure (which nulls `unlocks.worker_id`), the ADR-0031 freeze, a suspension and a withdrawn consent close a contact at read time: "for good" cannot outlive them.

Caps limit FIRST opens only: the attempt cap applies until the relay is wired (a repeat reveal returns the same handle), the per-worker daily cap no longer stops a company re-reading the résumé of a contact it opened, and the contact read touches neither.

Residuals, accepted for the pilot:

- **A zero-balance company re-opening by `POST`** still meets the credit precondition (F-1) first and gets the neutral body; its contact read and résumé work without it. Kept so the precondition stays worker-state independent.
- **The relay of a lapsed past open** resolves on stored dates, so it works again once the company re-opens or reveals it (both free).

### 3.5 Selected and hired (part C, planned)

`payer_applicant_stages_stage_chk` and `APPLICANT_STAGES` gain `selected` and `hired`. The CHECK is a drop and re-add, applied by hand and verified with `pg_get_constraintdef` before the switch goes on. The old `payer.applicant_stage_changed` payload is pinned to the three old stages first; the wider set is a new versioned event. A company may mark an applicant it never opened (a student met at a campus drive); RVM's verification, not the mark, decides the reward.

### 3.6 The outbound signal to RVM (part D, planned)

A table `outbound_signals` (`destination`, `kind`, unique `dedupe_key`, `payload`, `status`, `attempts`, `next_attempt_at`, `delivered_at`), written in the stage transaction, and a BullMQ processor that posts each mark on an RVM student once to RVM's `POST /internal/campus/selection-events` (Scheduler_Backend#162) with a service token, back-off and a dead-letter state. The body is the student ref, company name, job title, `selected` or `hired` and the date — no phone, no student name, no money field. The payload stores ids and the body is built at send time, so the company name (encrypted at rest) is not kept in clear a second time. Dedupe key: posting id + worker id + stage. An undone mark sends nothing (#2771 proposes a withdrawal signal). The token and URL live in the GitHub `production` environment.

### 3.7 Switches

One per part, all through `FeatureRolloutService` (off | pilot | on, keyed by the company's tenant key, fail closed): `applicant_facts` (A), the contact rules (B), the outcome stages (C) and the outbound sender (D). A switch gates what is shown or accepted, never stored state: turning a switch off never re-charges an open contact or deletes a stage already saved.

## 4. Security review (part A)

- **Faceless before paying ends** for companies with the switch on. The first name is personal data shown before any payment. It is shown only on rows a company may already see (its own applicants, or its search pool), never logged, cached or emitted.
- **Harvesting.** A company could page its search to collect first name, city, trade and expected salary across the pool: the search cap (`PAYER_CANDIDATE_SEARCH_MAX_PER_HOUR`, default 120 pages of at most 50 rows) allows about 6,000 named cards an hour **per login**, and a payer account goes live on OTP alone. Under a curated `pilot` list this is bounded. **Before `APPLICANT_FACTS_ROLLOUT` goes to `on`:** a per-company daily cap on distinct workers whose facts are shown, and an alert on search volume (follow-up issue). No phone or surname is in that set.
- **RVM consent between re-checks.** An RVM student's facts follow his ACTIVE link. A withdrawal at RVM reaches BadaBhai when Campus unlinks him, or when a company next tries to open him (`InstituteOpenGate` re-asks RVM); until then his first name, course and branch city stay on the lists he applied to. The open itself is always re-checked. Accepted for the pilot; gating the card on the link's re-check age would hide every RVM student after five minutes (`RVM_CONSENT_RECHECK_SECONDS`).
- **Free text.** Only closed vocabulary reaches the card, except RVM's course name, which is bounded and comes from RVM's own Student API contract.
- **Deploy wiring.** A malformed switch value fails the deploy preflight before anything is pulled, so a typo cannot take the API down at boot.

## 4b. Security review (part B)

- **The phone number crosses the API** (ADR-0010 Decision 2 reversed) only to the tenant that holds the open grant, only while the rule is on for it, behind the per-login hourly cap, with an audit row written before every answer and `no-store` on the response.
- **No new oracle.** Every refusal on the contact read is the one neutral body; the switch-off 404 depends on the caller's own company only.
- **Fail closed.** A pilot-list read error is off (the old window, initials); a decrypt failure is the neutral body (phone) or "not given" (name), logged by unlock id only.

Parts C and D each get their own review before merge.

## 5. Arming and rollback

Every switch defaults to `off`. Arming is `gh secret set <SWITCH> --env production --body pilot` plus `feature_pilot_payers` rows for the pilot companies, then a redeploy — and only after this ADR is signed. Rollback is the same secret set to `off`.

## 6. Open questions (for Akshit; built with the default)

- Should an RVM student's test score show before paying? Default: no, only after opening.
- The photo before or after paying? Default: withheld (the brief is silent).
- "Area" finer than the city? Default: the city — profiles hold city and state and nothing finer.
