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
| Three pipeline stages | `selected` and `hired` added | C (built) |
| Nothing leaves BadaBhai | A selected or hired mark on an RVM student is sent to RVM once | D (built) |

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

Writes keep "for good" after a rollback. A grant made while the rule is on stores `expires_at = 2099-12-31T23:59:59Z` (shipped apps still parse a date) and answers `open_until: null`; a re-open (`POST /payer/unlocks`) or a reveal of a lapsed contact while the rule is on moves its stored dates (grant and relay row) there too, under the worker lock, only ever later (`extendOpenUntil`). Re-opening costs nothing: the held grant is returned with no debit, and the re-open is audited (`unlock.reopened`, not a grant). `GET /payer/unlocks` reads the STORED dates: a contact stored for good has `open_until: null` and never reads `expired`; a lapsed one that would re-open free still reads `expired` until it is re-opened (whether it would depends on the worker's notice, §3.8, which a list of rows does not read). Everything in this section applies only to a worker §3.8 admits.

Erasure (which nulls `unlocks.worker_id`), the ADR-0031 freeze, a suspension and a withdrawn consent close a contact at read time: "for good" cannot outlive them.

Caps limit FIRST opens only: the attempt cap applies until the relay is wired (a repeat reveal returns the same handle), the per-worker daily cap no longer stops a company re-reading the résumé of a contact it opened, and the contact read touches neither.

Residuals, accepted for the pilot:

- **A zero-balance company re-opening by `POST`** still meets the credit precondition (F-1) first and gets the neutral body; its contact read and résumé work without it. Kept so the precondition stays worker-state independent.
- **The relay of a lapsed past open** resolves on stored dates, so it works again once the company re-opens or reveals it (both free).

### 3.5 Selected and hired (part C, built, `OUTCOME_STAGES_ROLLOUT`)

`APPLICANT_STAGES` gains `selected` and `hired` (`APPLICANT_OUTCOME_STAGES`). The first three are frozen as `APPLICANT_STAGES_V1`. Migration 0166 widens `payer_applicant_stages_stage_chk` by a drop and re-add. It is applied by hand and verified with `pg_get_constraintdef` before the switch goes on.

- **The write.** `PUT /payer/reach/jobs/:jobId/applicants/:workerId/stage` accepts an outcome stage only while `OUTCOME_STAGES_ROLLOUT` (`outcome_stages`) is on for the company. Off, either value gets the same `400` body it got before: the same validation body, produced by the same pipe over the old schema. It is checked before the posting is looked up, so the refusal says nothing about any posting. Unlike before, the request reaches that check first, so it is charged one unit of the hourly write cap. A re-send of a stage already held is that `400` too, not `changed: false`.
- **Stored state is honoured.** Every read (both feeds, the inbox, `?stage=`) reports a stored outcome stage as itself, whatever the switch says. Moving an applicant out of one, back to Shortlist for example, is allowed with the switch off.
- **The events.** `payer.applicant_stage_changed` v1 is pinned to the first three stages and still reports every move between them, byte for byte. A move to or from `selected` or `hired` is `payer.applicant_stage_changed_v2`, with the same fields over the wide set. A refine stops v2 carrying a move v1 can carry, so no move is reported twice.
- **Switched on before 0166.** The write fails the CHECK (23514) and the transaction rolls back, so nothing is written and no event is emitted. The request answers 500 and the log line names the missing migration.
- **payer-web** keeps its three tabs. A `selected` or `hired` row shows under Shortlist (`boardTabOf`), with its own badge and no move buttons, so nobody undoes a mark without seeing it. The outcome stages get their own UI from Rishi.

A company may mark an applicant it never opened (a student met at a campus drive). RVM's verification, not the mark, decides the reward. RVM's systems learn of a mark on an RVM student two ways:

- Campus's application-status read (#2752, `GET` of a Campus application) already returns the stored stage, `selected` and `hired` included, while `CAMPUS_LINK_ENABLED` is on. A mark, and an undo of it, shows there as soon as it is saved.
- The proof prompt and the placement team's task come only from part D's signal (§3.6), behind its own switch. The event plays no part in either.

### 3.6 The outbound signal to RVM (part D, built, `OUTBOUND_SIGNALS_ROLLOUT`)

A table `outbound_signals` (`destination`, `kind`, unique `dedupe_key`, `payload`, `status`, `attempts`, `next_attempt_at`, `delivered_at`), written in the stage transaction, and a BullMQ processor that posts each mark on an RVM student once to RVM's `POST /internal/campus/selection-events` (Scheduler_Backend#162) with a service token, back-off and a dead-letter state. The body is the student ref, company name, job title, `selected` or `hired` and the date — no phone, no student name, no money field. The payload stores ids and the body is built at send time, so the company name (encrypted at rest) is not kept in clear a second time. Dedupe key: posting id + worker id + stage. An undone mark sends nothing (#2771 proposes a withdrawal signal). The token and URL live in the GitHub `production` environment.

As built (migration 0167, `apps/api/src/outbound-signals`):

- **Queued in the stage transaction** (`OutboundSignalsService.recordMark`). Only a real move into `selected` or `hired` queues anything, and only for a worker whose RVM link is `active` at that moment, by a company with `OUTBOUND_SIGNALS_ROLLOUT` (`outbound_signals`) on. A no-op, a move out, a BadaBhai worker and a company without the switch queue nothing. The switch is read before the transaction; the link is read inside it. A pilot list that cannot be read refuses the mark with a 503 rather than save it with its signal silently lost.
- **Due ten minutes after the mark.** A mis-tap undone in that window never reaches RVM.
- **The payload** is `{posting_kind, posting_id, worker_id, stage, marked_on}`, where `marked_on` is the IST day.
- **The sweep** (`OutboundSignalsSender`, a repeatable BullMQ tick every minute) claims up to 25 due rows with `FOR UPDATE SKIP LOCKED`. Each claim counts as an attempt. The lease outlasts a whole batch timing out, and is never under five minutes. A row a sender keeps crashing on is given up as `abandoned`.
- **Still true when sent.** Before anything leaves, the sweep re-reads three things and cancels the row when one has changed:
  - the stage the board holds now: a `selected` row goes while he is `selected` or `hired`, a `hired` row only while he is `hired` (`mark_undone`);
  - the worker: suspended or scheduled for deletion (`worker_inactive`);
  - his RVM link: ended (`link_inactive`).
- **The body** is built at send time:
  - `event_id` is the row id, which is also the Idempotency-Key;
  - the student ref;
  - the posting title;
  - the company as students see it: a company posting's own `org_label`, the name Campus shows, never the account's; an agency job's owner account name, decrypted only here;
  - the stage and the day.

  It is checked against the contract before it is sent, so an off-contract body is dead at once rather than retried.
- **RVM's answers.**
  - Any 2xx: `delivered`.
  - RVM's `404 NOT_AVAILABLE`: `dead` (`not_available`).
  - 400, 413, 415 or 422: `dead` (`rejected`).
  - Anything else is retried after 1, 2, 4 … minutes, capped at six hours: a timeout, a dropped connection, 401/403, 409, 429, a 5xx, a bare 404. A 409 can be RVM still working on the same event, or a retry whose rebuilt body differs from one RVM already holds. The row is `dead` after 14 attempts, about 32 hours.
- **The kill switch.** The sweep claims nothing while the switch is off everywhere, or while RVM's settings are not set. Queued rows wait and keep their attempts. Taking one company off the pilot list stops new marks being queued for it; rows already queued still go.
- **The dead-letter view** and replay in the admin console are #2770.
- **Logs** carry the signal id, closed failure codes and an HTTP status only, never the body.

### 3.7 Switches

One per part, all through `FeatureRolloutService` (off | pilot | on, keyed by the company's tenant key, fail closed): `applicant_facts` (A), `contact_rules` (B), `outcome_stages` (C) and `outbound_signals` (D). A switch gates what is shown or accepted, never stored state: turning a switch off never re-charges an open contact or deletes a stage already saved.

### 3.8 The worker's own notice decides (per worker, whatever the switch)

The approved employer-sharing notice of 2026-11-04 (`docs/product/employer-sharing-consent-notice.md`) tells the worker the opposite of the brief: "Aapka **naam, phone number aur photo** nahi dikhta" before an unlock; an unlock lasts "14 din tak"; the résumé carries his phone but not his "poora naam". Every consent row on that version records that he agreed to THOSE rules. A company's pilot switch cannot change them for him.

So every #2747 rule that the notice contradicts is gated **per worker**, in addition to the company's switch:

- the facts before paying (§3.2),
- open for good and the free re-open (§3.4),
- the contact read and the full name on the résumé (§3.3),
- the re-read exemption from the per-worker caps.

**Who the rules reach.** A BadaBhai worker qualifies only when his LATEST consent row is unrevoked, carries `employer_sharing`, and was given on a notice listed in `BRIEF_CONTACT_NOTICE_VERSIONS` (`packages/types`). An actively linked RVM student qualifies by the institute rule instead. That is RVM's consent line ("Share my profile with companies I apply to", brief 9), and it is the issue's own default for his card.

**Who keeps the old rules.** A worker on the 2026-11-04 notice keeps initials, the 14-day window and no facts before paying. That holds even for a pilot company.

**The list is empty today.** No notice describing the brief exists yet, so for BadaBhai workers the switches change nothing until one is approved and shipped. The steps when it is:

1. Approve the new copy (Prakash, owner).
2. Ship it in the worker app (Rishi).
3. Append its version to `EMPLOYER_CONTACT_NOTICE_VERSIONS` **and** `BRIEF_CONTACT_NOTICE_VERSIONS`, and bump `CURRENT_CONSENT_VERSION` / `kConsentVersion`, all in one change.

Workers then move onto it as they re-consent (the one-time prompt).

**Draft of the new notice, for approval** (Latin Hinglish, aap-form). The heading, the buttons and the Settings line stay as they are; the body changes:

> Aapko kaam dilaane ke liye, BadaBhai aapki kaam ki profile companies aur placement agencies ko dikhata hai.
>
> Paise dene se pehle woh yeh dekh sakti hain:
>
> - Aapka **pehla naam**
> - Aapka kaam, anubhav, machine aur level
> - Aapki industry, shehar aur **salary ki ummeed**
> - Aap aakhri baar kab active the
>
> Aapka **poora naam, phone number aur photo** nahi dikhta.
>
> Agar koi company paise dekar aapki profile **unlock** karti hai, to woh **hamesha ke liye**:
>
> - Aapka **poora naam aur phone number** dekh sakti hai, aur aapka **resume**.
> - Aapko **BadaBhai ke andar message** kar sakti hai.
>
> Jo companies aapko pehle unlock kar chuki hain, unpar bhi yahi lagu hoga.
>
> **Dhyaan dein:** Aap jab chaahein **Settings** me jaakar yeh band kar sakte hain. Phir koi company aapka naam ya number nahi dekh paayegi, aur aapko dhoondh ya message nahi kar paayegi. Jo resume pehle dekha ja chuka hai, woh wapas nahi hota.

**Earlier unlocks.** The line "Jo companies aapko pehle unlock kar chuki hain…" is what lets "past opens" apply to him. If the owner strikes it, past opens must be limited to grants made after his acceptance. That change goes in the same code change as the version bump.

## 4. Security review (part A)

- **Faceless before paying ends** for companies with the switch on. The first name is personal data shown before any payment. It is shown only on rows a company may already see (its own applicants, or its search pool), never logged, cached or emitted.
- **Harvesting.** A company could page its search to collect first name, city, trade and expected salary across the pool: the search cap (`PAYER_CANDIDATE_SEARCH_MAX_PER_HOUR`, default 120 pages of at most 50 rows) allows about 6,000 named cards an hour **per login**, and a payer account goes live on OTP alone. Under a curated `pilot` list this is bounded. **Before `APPLICANT_FACTS_ROLLOUT` goes to `on`:** a per-company daily cap on distinct workers whose facts are shown, and an alert on search volume (follow-up issue). No phone or surname is in that set.
- **RVM consent between re-checks.** An RVM student's facts follow his ACTIVE link. A withdrawal at RVM reaches BadaBhai when Campus unlinks him, or when a company next tries to open him (`InstituteOpenGate` re-asks RVM); until then his first name, course and branch city stay on the lists he applied to. The open itself is always re-checked. Accepted for the pilot; gating the card on the link's re-check age would hide every RVM student after five minutes (`RVM_CONSENT_RECHECK_SECONDS`).
- **Free text.** Only closed vocabulary reaches the card, except RVM's course name, which is bounded and comes from RVM's own Student API contract.
- **Deploy wiring.** A malformed switch value fails the deploy preflight before anything is pulled, so a typo cannot take the API down at boot.

## 4b. Security review (part B)

- **The phone number crosses the API** (ADR-0010 Decision 2 reversed) only to the tenant that holds the open grant, only while the rule is on for it, behind the per-login hourly cap, with an audit row written before every answer and `no-store` on the response.
- **No new oracle.** Every refusal on the contact read is the one neutral body; the switch-off 404 depends on the caller's own company only.
- **Fail closed.** A pilot-list read error refuses `POST /payer/unlocks` with the neutral body and no charge (reading a pilot company as off would debit it again for a contact it holds), and is off everywhere else; a decrypt failure is the neutral body (phone) or "not given" (name), logged by unlock id only.
- **The worker's notice (review HIGH).** Every #2747 rule is gated per worker on §3.8; on the 2026-11-04 notice nothing changes for him. Re-opens are audited (`unlock.reopened`), and a worker who withdrew is never re-opened.
- **Caps (review MEDIUM).** A repeat reveal of a wired relay is not counted (`reveal_count` feeds the per-worker daily caps: counting it would let one company lock every other company out of a worker for a day); a company's FIRST résumé of a worker is still capped, only a re-read (a `disclosed` row already held) is not.
- **Smaller fixes.** Sample candidates (R74) never answer the contact read; the deletion freeze is re-read on the row that is decrypted.
- **Residual: rollback lag on the résumé.** A PDF rendered with the full name is re-signed for its short TTL (`RESUME_SIGNED_URL_TTL_SECONDS`) after the switch goes off, and an ops request for the same company, worker and posting can re-sign it in that window. Same company, minutes long; accepted.

Parts C and D each get their own review before merge.

## 4c. Security review (part C)

An independent review of the stage change found no HIGH or MEDIUM issue. It confirmed that the switch is read with the tenant key and fails closed. It found no existence oracle, and the off-switch `400` is the old body. Every real move emits exactly one event, and the CHECK widening keeps every 0134 stage. Its LOW findings were fixed or written down:

- **The off-switch `400`** is reached after the hourly cap is charged. A re-send of a held outcome stage is that `400` too (§3.5, API reference).
- **payer-web:** an outcome row showed "Shortlisted" with one-click Pass and Move to New, so a teammate could undo a mark without seeing it. It now shows its own badge and no move buttons.
- **The inbox Shortlist filter** does not include outcome rows, which the API reference now says.
- **Campus's application-status read** already shows a stored outcome stage while `CAMPUS_LINK_ENABLED` is on (§3.5).

## 4d. Security review (part D)

An independent review found nothing HIGH. It confirmed four things:

- no PII is stored or logged, and the token cannot follow a redirect;
- queueing needs a real move, both switches, an active link inside the transaction and feed membership on the company's own posting;
- the CHECKs match the repository's updates;
- erasure is covered by the cascade.

Its findings, all fixed:

- **MEDIUM:** an undone mark, or a worker frozen after the mark, was still sent. The sender now re-reads the board, the worker and the link, and a row waits ten minutes after the mark.
- **MEDIUM:** a 409 was treated as a permanent refusal, which could kill a signal RVM still holds. It is now retried.
- **LOW:**
  - missing RVM settings used up attempts; the sweep now idles until they are set;
  - the company name differed from the one Campus shows; a company posting now sends its own `org_label`;
  - non-RVM errors were retried silently, and an emoji name could fail the 200-character check 14 times; the body is now validated before sending, capped by the contract's own count, and the error class is logged;
  - a pilot-list read failure lost the signal; the mark is now refused with a 503;
  - the lease could be shorter than a slow batch; it now outlasts one;
  - the migration header lacked lock guidance;
  - a crashing row could be re-claimed forever; each claim now counts, and the row is given up as `abandoned`.

## 5. Arming and rollback

Every switch defaults to `off`. For BadaBhai workers the switches do nothing until a notice describing the brief ships (§3.8). Arming is `gh secret set <SWITCH> --env production --body pilot` plus `feature_pilot_payers` rows for the pilot companies, then a redeploy — and only after this ADR is signed. Rollback is the same secret set to `off`. In `pilot`, a pilot list that cannot be read answers "unavailable": everything reads as off, except that `POST /payer/unlocks` refuses (neutral, no charge) a re-grant over a contact the company already holds, so a pilot company is never charged twice on a guess.

## 6. Open questions (for Akshit; built with the default)

- **RVM students and the phone "for good".** RVM's consent line ("Share my profile with companies I apply to", brief 9) says nothing about the phone number or "for good"; the build treats an actively linked student as covered (the issue's defaults for his card). Confirm with RVM, or give students a notice of their own; until then keep `contact_rules` off for companies that hire RVM students.

- Should an RVM student's test score show before paying? Default: no, only after opening.
- The photo before or after paying? Default: withheld (the brief is silent).
- "Area" finer than the city? Default: the city — profiles hold city and state and nothing finer.
