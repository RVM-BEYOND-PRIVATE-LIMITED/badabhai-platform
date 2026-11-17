# ADR-0066: Credit rules: settings, what a contact costs, and the honest "not enough credits" answer

- **Status:** Proposed. Awaiting owner sign-off (Akshit for the brief's rulings; Prakash as the other backend developer). `CREDIT_RULES_ROLLOUT` is not armed in production before this is signed.
- **Date:** 2026-11-17
- **Owner:** Divyanshu (Backend Platform).
- **Issue:** #2750 (BB-D-05; brief 4C.5 to 4C.12, section 7). Built in parts, all behind one switch (§3.5).
- **Amends:** [ADR-0010](0010-contact-unlock-and-reveal.md) Decision 4, which says every refusal of an open is one neutral body. This ADR adds a second distinguishable answer for companies under the credit rules (§3.3).
- **Related:** ADR-0013 (pricing engine) and its amendment ADR-0065 (#2749: packs, paise, GST, validity); ADR-0053 (the wallet is the tenant's); ADR-0064 (contacts open for good).

## 1. Context

Until now every contact open cost one credit. The brief prices a contact by who is opened, gives welcome credits to a verified company after its first approved post, lets the placement team waive the cost for RVM applicants, limits how often one worker can be opened, returns credits when a worker cannot be reached, and caps goodwill grants. Every number in those rules must be changeable without a deploy.

The code had a price-tier hook (`priceTierForTradeRows`) that was only logged, one credit per debit, and one neutral body for every refusal, including "not enough credits" (ADR-0010 F-1 option (a)).

## 2. Decision

### 2.1 The rules are settings (part A1, PR #2877)

- Every number lives in a new, versioned table, `credit_rules_config`: one row per revision, one active. Its shape and defaults (the brief's values) are `CreditRulesSchema` in `@badabhai/pricing`.
- It is **not** in `match_config` (owner ruling 2026-11-17). An invalid `match_config` row falls back whole to code defaults, so a money rule there would move with the ranking row.
- A stored row is validated on read and falls back **whole** to the defaults if invalid. The edit body requires every key, so a missing key is never silently reset.
- `PUT /admin/credit-rules` writes the next revision: an optimistic `expected_revision`, a written reason, and one transaction holding the revision, an `audit_logs` row with old and new values, and a value-free `admin.action_performed`.
- New capability `manage_credit_rules`, **super_admin only**: one edit changes every company's price.

### 2.2 What a contact costs (part A2)

One pure function, `contactCost(rules, facts)` in `@badabhai/pricing`, prices both the quote (the number on the button) and the debit:

| Who is opened                                                               | Credits            |
| --------------------------------------------------------------------------- | ------------------ |
| A contact the company already holds open                                    | 0                  |
| A contact on the company's paid Managed Hiring order (#2751; not built yet) | 0                  |
| An RVM student the placement team waived (part C; not built yet)            | 0                  |
| An RVM student                                                              | `standardCost` (1) |
| A higher-priced rung with `higherCostMinMonths` (36) or more in that trade  | `higherCost` (2)   |
| Anyone else, and anyone whose experience is unknown                         | `standardCost` (1) |

- **Higher-priced rung:** the rung prices Higher on its trade sheet (`priceTierForTradeSkill`), or the trade is 3D CAD designer or CAM programmer and the rung is above trainee.
- **Experience in the trade:** `worker_skill.months_bucketed` for that trade, else total years from the latest profile.
- **Never price up on missing data:** unknown experience is the standard cost.
- **Facts already on the card only:** rungs, experience, the RVM label, and whether this company already holds the contact. The price never reads consent, a limit, deletion state or whether an id exists, so it cannot be used to probe any of them. An unknown id is priced like a worker who stated nothing.
- **The debit:** a priced open spends `n` credits at once through `spendCreditsWithinTx`. It takes from lots in spend order (soonest-expiring first), writes one `unlock_debit` line per lot taken from, and decides before it writes: if fewer than `n` are spendable it writes nothing (no partial spend, no expiry line). The #2749 F-1/F-3 rule holds for `n > 1`.

### 2.3 The honest refusal (amends ADR-0010 Decision 4)

For a company under the credit rules, an open it cannot afford answers:

```json
{ "status": "insufficient_credits", "credits_needed": 2, "credits_available": 1 }
```

- Nothing is debited or opened, and no deny row is written. The internal `payment.failed` is emitted as before.
- **Why this is not an oracle:** the answer is decided at the F-1 precondition, before any worker-state read: before consent, the institute gate, deletion state and the caps. The price comes only from facts on the card, and the balance is the company's own. A company learns nothing it could not compute from the card and its credits page. The no-consent and unknown-worker cases give the same answer (a unit test pins that).
- **Every other refusal is unchanged:** consent, deletion, the caps, a lost debit race and a job reference the company does not own all still answer the one neutral body.
- The second honest answer the brief asks for ("worker not available this week", for the weekly limit) comes with the limits in part D and gets its own section here.

### 2.4 The quote

`POST /payer/unlocks/quotes` takes up to 50 worker ids and returns `{ quotes: [{ worker_id, credits }], credits_available }`.

- It uses the same rule and the same facts as the open. A contact the company holds open quotes 0.
- It reads no consent, writes nothing and emits nothing, so it is not on the disclosure cap.
- It answers 404 unless the company is under the credit rules.

### 2.5 The switch

`CREDIT_RULES_ROLLOUT` (`off` / `pilot` / `on`, key `credit_rules`):

- **Off for a company:** one credit per open, the env caps, and the response bodies exactly as before (no `credits_charged`).
- **Pilot list unreadable** (`unavailable`): the open refuses with the neutral body and writes nothing. Charging one credit or the rules' price on a guess are both wrong.
- **During the pilot both rule sets run side by side.** The weekly limit (part D) counts opens by companies outside the pilot too.

### 2.6 The placement team's waiver (part C)

RVM's placement team can make RVM applicants free to open: for **one company** (every RVM student who applied to any of its jobs) or **one job** (the RVM students who applied to it). Everyone else still pays; a student found only by search is not covered.

- Set or cleared from Campus (`PUT internal/campus/v1/waivers`) or by a super admin (`PUT /admin/waivers`, capability `manage_waivers`). One active waiver per company and per job; clearing keeps the row, with who and why. Staff names are stored encrypted (owner ruling 2026-11-17).
- The cost rule prices a waived RVM applicant at 0 (`basis: waived`). The quote says `waived: true`.
- A waived open debits nothing and needs no balance. In the open's transaction it writes one zero-credit `waived` ledger line naming the unlock (no lot) and a use row naming the waiver. It emits no payment events.
- The waiver is re-read under a share lock inside the open's transaction: one cleared since the price was read refuses the open (neutral, nothing written), and a clear racing the open waits for it.

### 2.7 The opening limits, and the third honest answer (part D; amends ADR-0010 Decision 4 again)

For a company under the credit rules the brief's two limits **replace** the env caps (`UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK`, `UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY`), which every other company keeps:

- **A worker's week** (`workerWeeklyOpenLimit`, 5): a worker opened 5 times in the rolling 7 days, by any company (pilot or not, every new open counts, a free one included), is not opened again this week, **except by a company he applied to** (B7-12). A re-open of a contact the company holds is not a new open. Checked under the worker lock, after the consent, deletion and search-exit gates.
  - The company is told `200 { status: "worker_unavailable_this_week" }` (#2750 question 2's default). It says he is in demand, which the neutral body hid. It is answered only for a worker every earlier gate let through, so it says no more about consent than an applicant card already does. Nothing is debited; the deny row reads `capped` and `unlock.limit_reached` records it.
- **An agency's day** (`agencyDailyOpenLimit`, 40): an `agent` account opens at most 40 new contacts per IST calendar day; an employer account is never stopped by it (B4C-18).
  - The company is told `200 { status: "daily_limit_reached", daily_limit }`. This depends only on the company's own count and is decided **before** anything about the worker is read, then re-checked under a per-company lock inside the transaction (lock order: worker, company, wallet), so two opens at once cannot both pass the line.

### 2.8 The working-number guarantee and the worker desk (part E)

- **The report.** A company under the credit rules reports "couldn't reach" on a contact it opened, up to day `couldntReachWindowDays` (7) after the open, counted in IST calendar days (B7-13: day 7 accepted, day 8 refused). One case per open (`contact_reach_cases`), due `deskWindowHours` (48) later. A second report answers the first case.
- **The desk** (capability `work_reach_desk`: super_admin, ops_admin and support, owner ruling 2026-11-17) calls the worker through the existing reason-gated reveal (`reveal_pii`, the case id as the reason), logs each attempt as a closed result code, and closes the case: reached and interested, reached and declined (no credit back), or not reached.
- **Not reached** gives back every credit the open took: one new `returned` lot and ledger line per spent lot, naming the open, keeping the spent lot's expiry while it is ahead, else `returnedLotValidityDays` (30) from the close. A free (waived) open returns nothing. The company's follow-up answer for the open becomes `not_reached` (#2753).
- **The deadline.** A case still open at its deadline closes as not reached, attempted or not (owner ruling 2026-11-17), by a sweep every 15 minutes. The company never waits on the desk.

## 3. Consequences

- The number on the button equals the credits debited, unless the worker's card changes between the quote and the tap. In that case the open charges the price at the tap; the price is always from the card he shows then.
- Re-opening a contact the company holds is free and says so (`credits_charged: 0`).
- The ledger can now hold two `unlock_debit` lines for one unlock (one per lot). `Σ delta` per wallet and per lot still equals the balance and the lots.
- The app and the web must show the quote on the open button and handle `insufficient_credits` by offering the Starter pack. Until they do, a pilot company on an old client sees an unknown body for a refusal it could not afford; keep pilot companies on updated clients.

- A `waived` line has `delta = 0` and no lot, so `Σ delta` per wallet and per lot is unchanged by it. Payment history leaves it out.

- A pilot company's apps must handle two more answers: `worker_unavailable_this_week` and `daily_limit_reached`. An old client sees an unknown body; keep pilot companies on updated clients.

- A `returned` ledger line has `unlock_id` set and adds a `returned` lot; `Σ delta` per wallet still equals the balance (DB test). A couldn't-reach return and a returned-with-a-pack credit (part F) are told apart by `unlock_id` (private notes item 12).

## 4. Security review (parts A1, A2, C, D and E)

- **Oracle:** the price and the honest refusal depend only on card facts and the company's own balance; both are decided before any worker-state read. Pinned by unit tests: no consent or institute read on the refusal path, and an identical answer for a consented worker and an unknown id.
- **Tenancy:** the price facts read this company's grant by tenant key. The wallet helper is tenant-keyed and on the static tenancy scan's helper list.
- **Money:** an n-credit spend is all-or-nothing under the wallet row lock. Concurrent spends cannot overdraw (DB test). A past-due-only wallet is refused byte-for-byte unchanged (DB test).
- **Waivers:** whether a waiver frees a worker reads only his applications to this company's jobs (already on the company's applicant list) and the company's own waivers: no consent, limit or deletion state, so the 0 on the button is no oracle. Setting one is super_admin only on BadaBhai's side, or the Campus credential; an unknown or barred company and another company's job are the same neutral 404. Staff names are encrypted at rest and appear in no event.
- **Limits:** the weekly answer is the one deliberate new signal (he is in demand), given only after the consent, deletion and search-exit gates passed, so it is never an answer about a worker the company could not open anyway. The agency answer reads only the company's own count, before any worker read. Both counts are taken under locks, so they cannot be raced past.
- **The desk:** a report needs the company's own open (the tenant key) within the window; the desk's routes never return a number (the reveal stays `reveal_pii`, reason-gated and audited). A close returns credits only through the wallet helper, once per spent lot (idempotency key), in one transaction with the close, the audit row and the event; a closed case refuses a second close (409). Attempts and closes carry no free text but the admin's reason, which refuses hard identifiers.
- **Settings:** super_admin only; the reason text refuses hard identifiers; one audited transaction; 409 on a stale or racing edit.

## 5. Arming and rollback

- **Arm:**
  1. Apply the `credit_rules_config` migration, then the `rvm_applicant_waivers` and `contact_reach_cases` ones.
  2. Optionally publish rules different from the defaults.
  3. Set `CREDIT_RULES_ROLLOUT=pilot` and list pilot companies in `feature_pilot_payers` (feature `credit_rules`).
- **Roll back:** set the switch to `off`. Every company is back to one credit per open on the next request. Stored revisions stay.

## 6. Open questions (built with the default)

- Which experience and roles count for the higher cost. Default: §2.2.
- Counting rules for limits, the guarantee, returned credits, refunds and goodwill. Default: brief section 7, recorded with each part.
