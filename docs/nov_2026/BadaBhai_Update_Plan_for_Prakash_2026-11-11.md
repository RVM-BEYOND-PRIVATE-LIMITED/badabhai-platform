# BadaBhai Update Plan for Prakash
From Akshit's decisions of 8–11 Nov 2026 · prepared 11 Nov 2026 · GST is always extra

Read with: `BadaBhai_Pricing_Charter_LOCKED_2026-11-11.md` (prices, rules and the research behind them) and the live master reference, now v1.4.

---

## 1. The short version
- **Pricing is locked.** Companies buy packs of credits and spend them to open a worker's phone number. Posting stays free. Workers never pay.
- **The ₹40 single unlock is retired.** Entry is a ₹999 pack of 20 credits.
- **Experienced skilled workers cost 2 credits.** Everyone else costs 1.
- **Two services on top:** Managed Hiring (prepaid per job) and pay on joining (per worker who joins and stays 30 days, bigger factories only, delivered through partners).
- **Pay on joining and the partner network run by hand first.** Do not build an app for them yet. Build only the records.
- **Decided later on 11 Nov:** the RVM job portal becomes **BadaBhai Campus**. It is the existing portal renamed, shown inside the RVM student app and connected to BadaBhai. Nothing is rebuilt. **This is first in the build order** (section 7).
- **Deadline that matters:** friends-and-family round runs December to January, VC meetings start end of January. The paid flow has to be live and counting well before 31 January.

## 2. What Akshit decided

### Fundraise and targets
- Friends-and-family round: December 2026 to January 2027. VC conversations: from end of January, through February and March.
- What VCs will be shown: 25,000–30,000 skilled workers active every month (the long target), hires, and companies that pay again. A registered-user count is not the pitch.
- Targets for 31 January 2027: 100 paying companies, 300 companies that posted a job, 5,000 completed worker profiles, 100 confirmed hires, 8 weeks of week-on-week growth. Repeat buying is reported as the share of companies buying again within 30, 60 and 90 days.

### Launch scope
- Trades: CNC operator, CNC/CAM programmer, sheet-metal operator and programmer, 3D CAD designer. Depth before breadth; the other trades follow.
- Cities: NCR, Pune and Ahmedabad together.
- Tamil Nadu from February 2027, through anchor factories and local partners.

### The locked price list

| Item | Price before GST | With GST | What it buys | Valid |
|---|---|---|---|---|
| Posting, searching, seeing who applied | ₹0 | ₹0 | Unlimited | Always |
| Welcome credits | ₹0 | ₹0 | 5 credits, once per verified company, after one real job post | 30 days |
| Starter | ₹999 | ₹1,179 | 20 credits | 30 days |
| Standard | ₹1,599 | ₹1,887 | 40 credits | 60 days |
| Big | ₹2,999 | ₹3,539 | 100 credits | 90 days |
| Annual, on sale from 1 Apr 2027 | ₹9,999 | ₹11,799 | 360 credits | 12 months |
| Managed Hiring, standard | ₹4,000 prepaid | ₹4,720 | One job, up to 5 vacancies, fresher to mid level. At least 5 phone-confirmed interested workers in 7 working days | Per job |
| Managed Hiring, large or experienced | ₹8,000 prepaid | ₹9,440 | 6–10 vacancies, or a job needing 3+ year skilled workers | Per job |
| Pay on joining, operator level | ₹5,000 per worker | ₹5,900 | Billed after the worker has stayed 30 days | Per worker |
| Pay on joining, experienced skilled | Half of first month's salary | plus GST | Billed after the worker has stayed 30 days | Per worker |

**Credits per worker**
- **1 credit:** operators, freshers, anyone with under 3 years' experience. A fresher CAD designer is 1 credit.
- **2 credits:** a setter, programmer or CAD designer with 3 or more years.
- An operator with 10 years is still 1 credit.
- A worker who applied and a worker found by search cost the same.

### Middlemen
- An agency or contractor with his own clients buys the same packs at the same prices. Limit: 40 unlocks a day. He cannot buy Managed Hiring.
- A partner fills pay-on-joining jobs from factories BadaBhai signs. He keeps 70% of the fee, BadaBhai keeps 30%. He is paid when the factory pays. He can also deliver a prepaid Managed Hiring job for half its fee.
- A referrer (supervisor, trainer, anyone who knows workers) earns ₹50 per completed profile and ₹500 when his worker is hired on a pay-on-joining job.
- Workers never pay anyone. A partner who charges a worker is removed.
- Not now: workers on BadaBhai's payroll, loans to partners, payment for signing up other partners.

## 3. What to build

### A. Before the first paid sale

**1. Credits and packs**
- A credit balance per company, with a ledger of every credit added, spent, returned or expired.
- Three packs on sale now: Starter, Standard, Big. Build the Annual pack but keep it hidden until 1 April 2027.
- Razorpay checkout. Every price shown as "₹999 plus GST (₹1,179)". GST invoice for every payment.
- Remove the ₹40 single unlock from the product.

**2. What a company sees before and after paying**
- Before, free: first name, trade, level, experience, machines, area, expected salary, availability, last-active date.
- After spending credits: full name, phone number, résumé. Open forever for that company. Re-opening costs nothing.
- If a field was never filled, show "not given". Do not hide the worker.

**3. Credit cost on the button**
- The button shows "Open for 1 credit" or "Open for 2 credits" before the company taps.
- 2 credits when the worker has 3 or more years' experience and is a setter, a programmer or a CAD designer. Otherwise 1.
- Keep the 3-year line and the 2-credit number as settings, not hard-coded. The yearly price review will move these first.

**4. The posting screen**
- Two buttons of equal size: **"Post free (5 contacts)"** and **"Post free + Starter ₹999 (20 contacts)"**.
- The job goes live the same way whichever is tapped. Record which button each company tapped.

**5. Welcome credits**
- 5 credits, once per verified company, added after its first real job post. Valid 30 days.

**6. Limits**
- A worker's number can be opened at most 5 times in a week, across all companies.
- An agency or contractor account can open at most 40 workers a day and cannot order Managed Hiring. This needs an account type on the company record: company, or agency/contractor.
- Money never changes who is shown or in what order. No boost, no paid ranking, no paid posting.

**7. Launch trades**
- All four launch trades live in the standard format with the level field and years of experience. Sheet-metal and 3D CAD designer are the ones to check first.

**8. Terms and consent**
- The text in section 6 below goes into the company terms, the worker sign-up and the partner flow, after a lawyer has read it.

### B. Within the first month of selling

**9. Working-number guarantee**
- A "couldn't reach" button on every opened contact.
- It creates a task for the worker desk. The desk tries the worker for 48 hours.
- Desk could not reach him: the credit returns automatically. Desk reached him and he said no: the credit stays spent.
- Report: "couldn't reach" claims per company, so misuse is visible.

**10. Unused credits come back**
- When a pack expires, up to 20 unused credits are held. They return when the company buys its next pack, if that is within 6 months.

**11. Refunds**
- Cash refund on a pack with no credits used, within 7 days of purchase.
- Cash refund within 30 days if the job drew fewer than 3 matching workers.
- Admin-triggered, logged with reason and who approved.

**12. Fresh profiles**
- Availability on every profile: "can join now", "15 days", "30 days", "working, open to a better offer".
- Last-active date, updated from real activity. Recently active workers listed first.
- A one-tap "Still looking?" check to every worker once a month.
- A switch for the worker to take himself out of search.
- A "not recently active" mark after 90 days with no activity.

**13. Managed Hiring orders**
- Order form on a job, prepaid through Razorpay, ₹4,000 or ₹8,000 by the rule in the price list.
- A 7-working-day clock from payment.
- A tracker of workers who were phoned and confirmed interested, shared with the company. Target: at least 5.
- If fewer than 5 at day 7, the job stays open with the desk, free, for up to 30 days.
- The page must never promise a hire. Remove any "guaranteed" wording.

**14. Goodwill credits**
- Admin can add at most 5 credits per company per quarter, with a reason and the staff name logged. No other discount, coupon or launch offer exists.

**15. The numbers screen** (section 5 below)

### C. Run by hand now, build later

**16. Pay on joining**
- Pilot: 3 anchor factories and 5 partners in NCR, December to January. Head of Business and Akshit pick them.
- What the system needs now is only a record per hire: factory, job, worker, partner, joining date, the 30-day check and its result, fee, invoice date, date the factory paid, partner's 70%, date the partner was paid.
- A simple admin table is enough. No partner app, no automatic payouts.

**17. Partners and referrers**
- 10 partners per city, run on WhatsApp by the team.
- A referral code or link per partner and referrer, saved on every worker profile he brings.
- Every worker brought by someone else confirms his own profile by OTP on his own phone before the profile counts.
- A payout ledger: ₹50 per completed, OTP-confirmed profile; ₹500 per pay-on-joining hire; PAN on file; 2% tax deducted once a person crosses ₹20,000 in a year (CA to confirm).
- A partner's name never affects ranking.

**18. A confirmed-hire record for every hire**
- Needed for the January target of 100 hires, and it is the billing basis for pay on joining.
- Suggested capture: ask the company 7 days after it opens a contact ("Did you hire him?"), and ask the worker in the monthly check ("Did you get this job?").

### D. Do not build
- A rebuild of the portal's features, or a separate Campus app in the app store. The portal is renamed and connected, not rebuilt (section 7).
- A partner app, lending, payroll or contract-staffing features.
- Discount codes, launch offers, paid posting, ranking boosts.
- The old proposed plans: Founding plan, Starter ₹1,999, Growth ₹4,999, Retained Desk, Enterprise, Bench plan, Urgent Drive, skill tests, pay-per-interview, top-up packs of 50 / 200 / 1,000.

## 4. Questions you will hit while building
Akshit has not ruled on these. The right-hand column is a suggested default so work is not blocked. Confirm each with him.

| Question | Suggested default |
|---|---|
| What makes a company "verified" for welcome credits? | Admin approval as on the RVM portal today, plus a GST number or a phone-verified owner |
| What is "one real job post"? | A job the admin has approved |
| A company has two packs running. Which credits are spent first? | The ones that expire soonest |
| Returned credits (up to 20): how long are they valid? | Same validity as the new pack they come back with |
| "Within 6 months": counted from when? | From the old pack's expiry date |
| A worker costs 2 credits and the company has 1 | Cannot open; show the Starter pack |
| A worker has hit 5 opens this week, and then applies to a job | The company he applied to can still open him. The limit applies to opens from search |
| How long after opening can a company tap "couldn't reach"? | Within 7 days |
| "Fewer than 3 matching workers" for the 30-day refund | Fewer than 3 applicants or recommended profiles in the job's trade and city |
| Are contacts shared inside a Managed Hiring job charged credits? | No. They are part of the fee |
| Managed Hiring for more than 10 vacancies | Not on the list. Route to Akshit or Head of Business for now |
| Which factories are "mid-size and large" for pay on joining? | Chosen by hand during the pilot. No rule in the product yet |
| Second job by a company that already used its welcome credits | First button reads "Post free" with no contact count |
| What counts as a worker "active this month"? | Opened the app, applied, replied to a company, or answered the monthly check in the last 30 days |

## 5. Numbers Akshit needs on one screen
Weekly, with week-on-week change, split by city and by trade:

- Companies that paid (unique), and how many paid a second time within 30, 60 and 90 days
- Companies that posted a job
- Completed worker profiles
- Workers active in the last 30 days
- Confirmed hires
- Contacts opened per hire
- Posting screen: share tapping each button
- Companies that used up welcome credits, and how many of them bought a pack
- "Couldn't reach" claims, and credits returned
- Revenue by pack and by Managed Hiring
- Telecaller list: companies whose credits ran out, newest first

## 6. Text to add (drafts, a lawyer must check them)

**Company terms**
- "BadaBhai may show a job to selected candidates, and may limit who sees a job, to keep the quality of applications high."
- "Credits expire on the date shown at purchase. Up to 20 unused credits return with your next pack if you buy it within 6 months."
- "A credit is returned if neither you nor BadaBhai can reach the worker within 48 hours of your report."
- "A pack with no credits used can be refunded within 7 days of purchase, or within 30 days if your job received fewer than 3 matching workers."
- "Managed Hiring is a sourcing and screening service. BadaBhai does not promise a hire."
- "Pay on joining: the fee is due once the worker has completed 30 days with you. No fee is due if the worker leaves earlier."
- "All prices are exclusive of GST."

**Worker sign-up**
- "Companies can see your first name, trade, experience and area. Your full name, phone number and résumé are shown only to a company that chooses to contact you. You can switch this off at any time. BadaBhai is free for workers. Nobody may charge you for a job through BadaBhai."

**Worker brought in by a partner or referrer (shown before the OTP)**
- "[Name] helped you make this profile. Confirm with the OTP only if the details are yours and you have not paid anyone."

**Partner agreement, key lines**
- Never take money from a worker. Payment only for completed profiles and confirmed hires. No payment for bringing other partners. PAN required. Tax deducted as the law requires. BadaBhai may remove a partner at any time for breaking these rules.

Also still owed from the October audit: a deletion event for every worker who leaves, and the model-training consent and privacy notice.

## 7. BadaBhai Campus: first in the build order (decided 11 Nov)
The RVM job portal becomes BadaBhai Campus. It is the existing portal renamed: same software, same features, nothing rebuilt. Akshit's reason: BadaBhai's first workers and companies come from RVM, so without this connection BadaBhai cannot start. Full answers: `RVM_BB_Final_Decisions_2026-11-11.md`.

**Build, in this order**
1. **Rename.** The portal's pages carry the BadaBhai Campus name. Fix the false claims on the site in the same pass ("28 years", "21,000+ live verified jobs", the invented live feed, "highest-quality hires guaranteed" and the rest). The web address stays jobs.rvmcad.org for now.
2. **Show it in the RVM student app.** A Jobs tab opens Campus inside the app, already logged in, with all its features, behind the fee gate. The student side goes live first. Companies and the placement team stay on the website as today; their app versions come later.
3. **One login** by phone number and OTP across the RVM app, Campus and BadaBhai.
4. **Jobs both ways.** A company posting on Campus can tick "also show this job to BadaBhai's experienced workers". BadaBhai jobs appear in the Jobs tab for RVM students to apply.
5. **RVM student tag in BadaBhai:** hidden from company search, reachable only when they apply. This uses the per-worker "hidden from search" switch in item 12, plus a field for where a worker came from.
6. **Selection signal.** When a company marks a student selected or hired, Campus tells RVM's system, so the student can be asked for proof.
7. **An "attended" tick** on campus drives in Campus.

**Order against section 3:** Campus items 1 to 5 come first. Credits and packs (section 3A) follow straight after.

**Give Akshit one number first:** how many days items 1 to 5 take. RVM's apps and CRM move back by that much.

**Rules for RVM students**
- Never in company search.
- Opening an RVM applicant costs 1 credit once BadaBhai's billing replaces Campus's plans, and RVM's placement team can waive it. Until then Campus's own plans run as today.
- The placement team can open RVM students to one named company's search. Each student is asked in the app at that time.
- Campus may read from RVM: name, phone, course, branch, student or alumnus, test score, and only with the student's consent. Never fee status or attendance.

| Still open with Akshit | What it blocks |
|---|---|
| The date BadaBhai's billing replaces Campus's own plans | Switching off the portal's plans |
| Any payment between RVM and BadaBhai. None is set | Nothing in the build |
| Signed papers: the Campus software belongs to BadaBhai; BadaBhai may call RVM's company list | Callers using RVM's company list |
| Campus for other institutes | A separate Campus app |

## 8. Data to pull from the RVM portal this week
1. Unique paying companies, out of the 178 payments.
2. How many companies paid more than once, and how many days apart.
3. Paid jobs out of jobs posted, month by month. 178 payments against 105 jobs on a paid plan does not add up.
4. What changed on or around 22 October. Payments fell to one in 19 days.
5. Does the portal collect ₹999 all-in, or ₹999 plus GST?
6. The split of the ₹2,91,337 between plan orders, onboarding payments and Managed Hiring fees.
7. For each ₹4,000 Managed Hiring payment: was the job filled, and in how many days?

## 9. Three tests before launch that need you
1. **Will factories pay for non-RVM workers on a new app?** 30 factories outside the portal each get 5 real matching profiles and a ₹1,179 payment link. You: the link and a count of who pays.
2. **How many contacts does a hire need?** Log contacts opened and the result for the first 50 BadaBhai hires.
3. **Is "one in two companies pays" real?** Answered by the data pull above.
