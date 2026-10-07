# Navigation

The navigation inventory of the BadaBhai web portals: every sidebar item, the route it opens,
what the page is for and the capability that gates it, plus the header rules every page follows.
Each portal keeps its own section. Update the section in the same change as the navigation it
describes.

The nav is an **affordance**. Every route keeps its own server gate; an item is shown only when
its page would render for that session.

## Admin

`apps/admin-web` — the internal operations console. Owner rulings 2026-10-01: the job entity is
**Posting**; the personas are **Company** and **Agency** and **Customers** is the umbrella for
both; labels change, routes, API paths and capability keys do not.

### Sidebar

Source: `apps/admin-web/src/components/nav-model.ts`. The layout filters items by capability on
the server; an item is hidden when the session cannot open its page. Every page enforces its own
gate (`requireCapability` / `requireSession`) whatever the sidebar shows.

| Group          | Nav item               | Icon                      | Route               | Page                                 | Purpose                                                     | Capability                                            |
| -------------- | ---------------------- | ------------------------- | ------------------- | ------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------- |
| Overview       | Dashboard              | `squares-four`            | `/`                 | `(portal)/page.tsx`                  | What needs attention, headline figures, AI spend and volume | session (panels: `read_events`, `read_entities`)      |
| Overview       | Events                 | `clock-counter-clockwise` | `/events`           | `(portal)/events/page.tsx`           | The global audit log, filterable                            | `read_events`                                         |
| Operations     | Workers                | `users-three`             | `/workers`          | `(portal)/workers/page.tsx`          | The worker roster (no search, by design)                    | `read_entities`                                       |
| Operations     | Feedback               | `chat-centered-text`      | `/feedback`         | `(portal)/feedback/page.tsx`         | What workers typed into the app's Feedback button           | `read_entities`                                       |
| Operations     | AI calls               | `robot`                   | `/ai-calls`         | `(portal)/ai-calls/page.tsx`         | AI provider calls made for workers, as measurements         | `read_ai_traces`                                      |
| Operations     | Companies              | `buildings`               | `/companies`        | `(portal)/companies/page.tsx`        | Company accounts (`payers.role = employer`)                 | `read_entities`                                       |
| Operations     | Agencies               | `handshake`               | `/agencies`         | `(portal)/agencies/page.tsx`         | Agency accounts (`payers.role = agent`)                     | `read_entities`                                       |
| Operations     | Postings               | `briefcase`               | `/jobs`             | `(portal)/jobs/page.tsx`             | Every posting, with the poster's own text                   | `read_entities`                                       |
| Matching       | Skill discovery        | `list-magnifying-glass`   | `/skills/discovery` | `(portal)/skills/discovery/page.tsx` | The skill-candidate review queue                            | `read_entities` (deciding: `review_skill_candidates`) |
| Matching       | Engine view            | `path`                    | `/matching/engine`  | `(portal)/matching/engine/page.tsx`  | How Matching V1 decides one demo worker's feed, live        | `read_entities`                                       |
| Finance        | Credits                | `wallet`                  | `/credits`          | `(portal)/credits/page.tsx`          | Credit position and the credit ledger                       | `read_entities`                                       |
| Finance        | Payment orders         | `receipt`                 | `/transactions`     | `(portal)/transactions/page.tsx`     | Credit-pack checkouts (payment orders)                      | `read_entities`                                       |
| Administration | Admin users            | `user-gear`               | `/admins`           | `(portal)/admins/page.tsx`           | Admin directory, invites, role / MFA / suspend actions      | `manage_admins`                                       |
| Administration | Roles and capabilities | `shield-check`            | `/roles`            | `(portal)/roles/page.tsx`            | The live role × capability matrix                           | session                                               |
| Administration | System                 | `gauge`                   | `/system`           | `(portal)/system/page.tsx`           | System health and provider switches                         | session (switch table: `toggle_kill_switch`)          |

### Detail and child pages

Not in the sidebar. Each has a back link to its real parent, named the way the parent names
itself. The topbar crumb shows the page's ancestors only (see the header rules).

| Route                                                 | Page title             | Back link → parent                                                                   | Capability                                   |
| ----------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| `/events/[id]`                                        | the event's name       | Events → `/events`                                                                   | `read_events`                                |
| `/workers/[id]`                                       | name or short id       | Workers → `/workers`                                                                 | `read_entities`                              |
| `/workers/[id]/timeline`                              | Event timeline         | Worker {id} → `/workers/[id]`                                                        | `read_events`                                |
| `/workers/[id]/journey`                               | Journey                | Worker {id} → `/workers/[id]`                                                        | `read_entities`                              |
| `/workers/[id]/journey/[sessionId]`                   | session short id       | Journey → `/workers/[id]/journey`                                                    | `read_entities`                              |
| `/ai-calls/[id]`                                      | the call's task        | AI calls → `/ai-calls` (none on the denied screen: that reader cannot open the list) | `read_entities` page; text: `read_ai_traces` |
| `/companies/[id]`, `/agencies/[id]`                   | organisation or id     | Companies / Agencies → the list                                                      | `read_entities`                              |
| `/companies/[id]/timeline`, `/agencies/[id]/timeline` | Event timeline         | Company {id} / Agency {id} → the customer                                            | `read_events`                                |
| `/jobs/[id]`                                          | the role title         | Postings → `/jobs`                                                                   | `read_entities`                              |
| `/jobs/[id]/timeline`                                 | Event timeline         | Posting {id} → `/jobs/[id]`                                                          | `read_events`                                |
| `/skills/discovery/[id]`                              | the candidate phrase   | Skill discovery → `/skills/discovery`                                                | `read_entities`                              |
| `/login`, `/invite/accept`                            | Sign in, Accept invite | none (outside the portal shell)                                                      | none                                         |

### Header rules

One component, `apps/admin-web/src/components/page-header.tsx`, renders every page header. The
three detail-page client headers (worker, company/agency, posting) pass their buttons into it.

1. **Back link.** Detail and child pages only. It points to the real parent and uses the
   parent's name: a list by its nav label, an entity as "{Entity} {short id}". Top-level pages
   have none (a fence in `page-header.render.test.tsx` enforces this). It is the `arrow-left`
   glyph plus text, and 44px tall on touch.
2. **Title**, then a **one-sentence description** — on detail pages too, the record's own
   timestamp folded into that sentence. Mechanics and privacy notes go in an alert or notice —
   on a list, after its rows as a standing footnote, so the first row stays within reach on a
   phone (final sweep AW-08). `components/page-description.test.ts` holds every description, in every
   branch it can render, to one sentence.
3. **Actions.** The page's own action first (Flag, Suspend / Reinstate, Force-close, Invite an
   admin, Record a decision), then related views (View journey, View event timeline). Only
   page-relevant actions, each offered once on the screen. The title block grows into the row
   with an 18rem floor, so the actions sit beside the title whenever both fit and wrap below
   it otherwise.
4. **Filters** directly below the header (`filters` slot), never in the actions slot. A list's
   filter bar sits in `components/filter-panel.tsx`: unchanged above the phone line, a
   "Filters (n)" disclosure on a phone — open whenever a filter is set.
5. **Topbar crumb** (`topbar-crumb.tsx`): an ordered list — the group, then the section once
   the page sits below it, then the named views between the section and the page ("Journey").
   It never repeats the h1, and it never shows a record's id (only the views listed in
   `SEGMENT_LABELS` are named). The section is linked only when the reader's sidebar holds it,
   so a reader is never offered a link that redirects them — and never on a page directly below
   it (`/workers/[id]`), whose back link already links the list: one target, one link, and the
   crumb keeps the section as context. The portal's error and not-found screens keep that back
   link at the same addresses (`components/fallback-header.tsx`).
6. **Current location.** The sidebar marks the exact page `aria-current="page"`; on a page
   below it, the item is the current section (`aria-current="true"`). Chip filters mark the
   active chip `aria-current="true"` and give it the selected tint (`filterChipClass` →
   `.btn--selected`) — never the primary fill, which marks a screen's one action. Every link
   chip renders `components/filter-chip-link.tsx` (a fence in `filter-chip.test.ts`). A chip
   keeps the other filters and drops the page cursor, so the active chip is TEXT only where its
   target is the address on screen — the first page (final re-sweep O-2: as a link it sat
   beside a Retry or another selected chip with the same address). On a later page it stays a
   link, still `aria-current`, to the first page of the same selection: the Pager only goes
   forward (review of #2095). The Engine view's picker shows the selected worker as text, and
   its Worker tab is the way back from a posting.
7. **Tab title.** `metadata.title` names the page. The root template adds " · BadaBhai Admin",
   so a page never includes it itself.

### Link and label conventions

- **One "Clear filters" per list**, in the results head, shown whenever a filter is set — or,
  when the server refused the filters, inside that refusal state instead (it is the way out
  there, and the head does not repeat it). It clears every filter (the bare route). A clear that removes one filter and keeps the rest is
  named for that filter: "Clear the worker filter", "Clear the tag filter", "Clear the reason
  filter" (the credit ledger, which keeps the reporting window). Empty and error states offer
  only a recovery that nothing else on screen offers.
- **"View events"** opens the global log (`/events`). **"View event timeline"** opens one
  record's timeline. A link to a filtered slice of the log is named for that slice ("View
  these breaches" on the dashboard's cap-breach item, "View submission events" on Feedback,
  "View AI cost events" on AI calls, "View all admin actions" on Admin users); a fence in
  `lib/terminology-fence.test.ts` holds every "View events" to the bare `/events`. All are offered only to a session holding `read_events`; this is an affordance, and
  each route keeps its own gate.
- **"Retry"** repeats exactly the current query, page cursor included — filters kept, whether
  or not a filter is set. **"Back to the first page"** is the same query without the cursor,
  and appears only when there is one; it is also the name of the way back from an empty page
  past the first. Every paged list's failed read renders both through
  `components/retry-actions.tsx` (Workers, Postings, Events, Companies, Agencies, the event
  timelines, Payment orders, the credit ledger, Skill discovery's flat view, AI calls,
  Feedback, a worker's interview sessions); a test fails if one does not pass its cursor.
- **A refused read is not an outage.** Every list tells a 400 apart by one rule,
  `lib/read-refusal.ts` (Workers, Postings, Events, Companies, Agencies, AI calls, Feedback,
  the credit ledger, Payment orders and Admin users; Skill discovery keeps its grouped-view
  exception below). A refusal never offers Retry — the request would only be refused again —
  and says what was refused. Only a filter VALUE the API does not accept counts as a refusable
  filter — an unknown enum value (`isUnknownValue`), an id that is not a uuid
  (`isMalformedUuid`), free text past the API's bound (`isOverLength`) — so a valid filter
  beside an over-long cursor is the cursor's refusal, not the filter's. The accepted values come
  from `@badabhai/types` where it exports them (worker, posting and verification statuses, the
  feedback tags); the rest are copies in `lib/list-filter-values.ts` and `AI_TASK_TYPES`, pinned
  to the API's DTO source by `lib/list-filter-values.test.ts`.
  - **a filter value the API does not accept is set** → the filters: that value is at fault,
    and its first page would be refused too. The state's action is "Clear filters", the
    screen's one (the credit ledger's is "Clear the reason filter", which keeps the window).
  - **no such value, a page cursor** → the cursor (the API refuses one only when it is longer
    than any it issues; a malformed one falls back to page one): "Back to the first page",
    every filter kept (`FirstPageAction`; Skill discovery's flat view lays out the bare
    `FirstPageLink`, keeping `view=flat`).
  - **nothing in the address** → it cannot be the operator's: an outage, with Retry —
    Skill discovery's flat view included (it blamed filters that were not set, NEW-07). The
    one exception is Skill discovery's GROUPED view, whose route refuses a result too large
    to group even with nothing set: it shows the server's own reason and points at the Flat
    view (linked once, by its chip) — there is no filter to clear.

  Anything else is an outage ("Workers are unavailable", "Feedback is unavailable" — a fault
  on our side, not the filters) and offers both recoveries.

- **One recovery of each kind per screen.** Two states on one page that would each offer the
  same link (the credit position and the ledger both failed, or both empty) show it once. A
  state does not repeat a control already on screen: a quiet credit window points at the
  window chips rather than offering a second link to the 90-day one.
  The error boundary's button is "Retry" too.
- **No Suspense or loading boundary anywhere in admin-web, until re-measured** (final re-sweep
  O-1, review of #2095). No route `loading.tsx`, no `<Suspense>`, no `React.lazy`, no
  `next/dynamic` (every call is a React.lazy, and `ssr: false` a Suspense boundary) — in any
  layout, page or component
  (`app/no-loading-boundary-anywhere.test.ts`). A query-only navigation (a chip, a filter, a
  page cursor) re-renders the same page, so any boundary in it is already visible, and on a
  production build of next 15.5.25 such a navigation was held in a transition that never
  committed (the URL never moved: 1-2 of 6 clicks landed on /credits, /events and
  /transactions; 400/400 with no boundary). A navigation keeps the current page on screen until
  the next one has rendered. Re-measure before relaxing this after a Next or React upgrade.
- **The navigation pending cue: sidebar, crumb, filter chips, Pager and filter-bar Apply**
  (review of #2095). These carry `components/nav-pending.tsx` and read their navigation's own
  pending state — Next's `useLinkStatus` for the sidebar links (rail and drawer), the crumb's
  section link, every link filter chip (`FilterChip`) and the Pager's Next page; the transition a
  filter bar's Apply navigates in (`usePendingPush`) — and Skill discovery's Clear these fields,
  in its own transition with its own words.
  While pending: a dot (after a rail or crumb label, on the corner of a chip, the Pager or
  Apply), a bar along the top of the viewport (the cue a phone sees, since the drawer closes as
  its link is followed) and one polite status line — "Opening Workers…", "Loading Credit
  grant…", "Loading the next page…", "Applying the filters…", "Clearing the fields…". Nothing
  shows for the first 180ms (`--nav-pending-delay`, equal to `PENDING_ANNOUNCE_DELAY_MS` — a
  test ties them), so a prefetched navigation never flashes it, and all of it ends
  when the navigation commits. NOT covered: other links — a back link, a table row's link, a
  state's recovery link — which show nothing until the next page renders.
- **One instruction per failure.** Where a Retry button sits under an error, the copy does not
  also say "reload". A failure with no button (a secondary read on a detail page) says
  "Reload this page".
- **Per-row controls** that share a visible name ("Suspend", "View") add the row's subject for
  assistive tech, after the visible label.
- **A customer cell links the customer's own section** (#2032, sweep AW-28). The customer of a
  posting (Postings, a posting's page), a ledger movement (Credits) and a payment order (Payment
  orders) links `/companies/<id>` for a Company and `/agencies/<id>` for an Agency, read from the
  `payer_role` the API serves beside `payer_id`, and names the persona beside the short id. With
  no role — an older API, an orphaned id, or a top balance (the summary serves none) — it links
  `/companies/<id>`, whose route redirects an agency to its own section, and names no persona.
  Every cell renders `components/customer-link.tsx`, which builds the address with
  `customerHref` (`lib/customer.ts`); a fence in `lib/customer.test.ts` fails any shipped file
  that builds `/companies/…` or `/agencies/…` by hand.
- **Touch targets.** On a phone or any coarse pointer, every small text link reaches 44px:
  table links through a row-high hit strip; stacked cell links, record-row links (a posting's
  owner, an AI call's worker, session and correlation id), id chips, the back link and the
  crumb's section link by taking the height themselves. Record rows then align on the text
  baseline, so a 44px link stays beside its label.
- **Names.** "Resume" (one spelling), "MFA" (never "second factor" or "two-factor"),
  "Customers" / "Customer" for Company and Agency together (never "Payer" on screen; never
  "Account", which is the payer's own settings page — so "Customer", not "Owner account", and
  role buckets read Company / Agency, not `employer` / `agent`), "Posting" for the job entity
  and "posting decision" for a worker's apply or skip on one, "View all admin actions" for
  the admin directory's one link into the log. AI task types read through `TASK_TYPE_LABELS`
  (`lib/ai-cost.ts`), the raw id for one this build was not taught.
  `lib/terminology-fence.test.ts` keeps the retired names out of the console's visible text:
  Résumé, second factor, two-factor, Payer, Owner account, job decision(s), Back to the newest,
  Skill Discovery / Skill Candidate, Roles & capabilities, Open the event timeline, Show every
  worker. The word "account" is NOT fenced — it is right for an admin's own account ("this
  admin account has spent its hourly name budget") — so a customer is kept out of it by the
  render tests of the customer screens (Companies, Agencies, a customer's page, its credits
  panel, a posting's page), not by the fence. Event names are data and keep their words (`payer.suspended`); where one is
  shown humanized, its domain reads as the console says it ("Customer · suspended",
  "Posting · created" — `humanizeEventName`).
- **Icons** come from `@badabhai/icons` only (`<Icon>`, `ACTION_ICON`). Key actions show icon
  and text. Icon-only controls use the admin `IconButton`. No arrow, tick or cross characters
  stand in for icons, and every `<summary>` draws the brand caret.

## Payer (Company + Agency)

App: `apps/payer-web`. Personas: **Company** (`session.role === "employer"`) and **Agency**
(`session.role === "agent"`). The rail is one model, `src/app/(portal)/nav-model.ts`; its order and
labels are pinned by `nav-model.test.ts`.

### Gates

| Key   | Gate                                                                 | Fails as             |
| ----- | -------------------------------------------------------------------- | -------------------- |
| P     | `requirePayer()` — every portal route (the portal layout runs it)    | redirect to `/login` |
| A     | `requireAgent()` — agency-only routes                                | neutral 404          |
| O     | `requireOwner()` — Owner-only routes                                 | neutral 404          |
| F     | `agencyFlags().agencyPortalEnabled` (default on) — every agency page | neutral 404          |
| nav-O | item shown only when `getOrgRole(session) === "owner"`               | item hidden          |
| nav-F | item shown only when F is on (the same flag the page checks)         | item hidden          |

`getOrgRole()` reads the member's CURRENT org role from `GET /payer/me` `orgRole` (#2079) — the
API reads `payer_members` on every call, and `requirePayer()` already makes that read on every
request, so a demoted owner loses O on their next request. Anything but an explicit `owner`
(`null`, missing, unknown) is `recruiter`. The payer JWT's `org_role` claim is not read (payer-web
cannot verify it). No link to an O route is rendered for a non-owner.

Since the owner ruling of 2026-10-07 the ONLY O route is Team: buying credits is open to every
member, so Credits is P (with the nav item and the chip link for everyone).

### Rail (desktop ≥1024px; the same list is the drawer below 1024px)

| Persona | Group        | Nav item         | Route               | Page                        | Purpose                                                    | Permission / flag                              |
| ------- | ------------ | ---------------- | ------------------- | --------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| Both    | —            | Dashboard        | `/dashboard`        | `dashboard/page.tsx`        | What needs you, position, quick actions, recent work       | P                                              |
| Company | Hiring       | New posting      | `/postings/new`     | `postings/new/page.tsx`     | Create a company posting (`job_postings`)                  | P; agent → redirected to `/agency/jobs/new`    |
| Company | Hiring       | Postings         | `/postings`         | `postings/page.tsx`         | List + pause / resume / add applicant slots / close        | P; agent → see "Agency on the company surface" |
| Company | Hiring       | Candidates       | `/candidates`       | `candidates/page.tsx`       | Every applicant across your postings, newest first; filter by posting; unlock | P                                  |
| Agency  | Demand       | New posting      | `/agency/jobs/new`  | `agency/jobs/new/page.tsx`  | Create an agency posting (`jobs`, the worker feed's table) | A + F; nav-F                                   |
| Agency  | Demand       | Postings         | `/agency/jobs`      | `agency/jobs/page.tsx`      | List + pause / resume / close; links details, applicants, edit | A + F; nav-F                               |
| Agency  | Demand       | Candidates       | `/candidates`       | `candidates/page.tsx`       | Every applicant across your postings, newest first; filter by posting; unlock | P + F (agent); nav-F               |
| Agency  | Supply       | Worker activity  | `/agency/workers`   | `agency/workers/page.tsx`   | Faceless funnel of the workers the agency referred         | A + F; nav-F                                   |
| Agency  | Supply       | Referrals        | `/agency/referrals` | `agency/referrals/page.tsx` | Invite link, batch links, funnel, earnings / KYC / payouts | A + F; nav-F                                   |
| Agency  | Supply       | QR invite        | `/agency/qr`        | `agency/qr/page.tsx`        | Printable QR invite sheet                                  | A + F; nav-F                                   |
| Company | Billing      | Plans & capacity | `/plans`            | `plans/page.tsx`            | Usage, Hiring capacity, applicant quota, credits, plans    | P; agent → redirected to `/dashboard`          |
| Both    | Billing      | Credits          | `/credits`          | `credits/page.tsx`          | Credit balance, buy credits, history, expiry               | P (every member — ruling 2026-10-07)           |
| Both    | Organisation | Team             | `/team`             | `team/page.tsx`             | Members, invite a recruiter                                | O; nav-O                                       |
| Agency  | Coming soon  | Revenue (Soon)   | `/agency/revenue`   | `agency/revenue/page.tsx`   | Parked explainer (no data)                                 | A + F; nav-F                                   |

Not in the rail, on purpose: **Bulk invite upload** (`/agency/bulk-upload`). It is dead — a consent
violation that will never be built (ADR-0022 Amendment 3) — and is never framed as coming. Nothing in
the portal links to it (final sweep F17: the dashboard's "not available" tile was a dead end, and is
gone); the route stays so an old link lands on its explanation, which points at batch invite links.

**Candidates** (`/candidates`, owner request 2026-10-07) is ONE list of every applicant to every
posting the payer owns, newest application first (`GET /payer/reach/applicants`) — the same faceless
card and unlock as a posting's Applicants page (which keeps its name), with one confirm-on-spend
dialog for the list and the balance as an affordance. Both personas, one route: a company's sits in
Hiring, an agency's in Demand beside Postings, behind F like the rest of Demand (the page checks it
for an agent). Its head is H1 "Candidates" + one sentence, no back link and no primary action; the
toolbar row is the posting filter — a plain GET form (`?postingId=`, "Show") over the payer's OWN
postings (company postings, or an agency's jobs). There is no stage (New / Shortlist) filter:
stages are a posting page's local state and nothing persists them. Paging is keyset — "Next page"
carries the API's cursor and keeps the filter; a later page offers "First page". Each card names its
posting ("Applied to …"): a company posting links `/postings/<id>`, an agency's job
`/agency/jobs/<id>`; the applicant's rank on that posting reads on the same line ("· ranked #2") —
the inbox is newest first, so its cards carry no rank badge. The unlock and the masked-resume
disclosure name that row's posting, and confirm-on-spend is per row: a worker who applied to two
postings is two cards, and the second always confirms for its own posting (a Retry is only ever the
card that confirmed). A filter that matches nothing (unknown, another payer's, not an id) is one
state with the empty posting's ("No applicants for this posting" → All postings); an uppercase id
is the same posting. A read failure is an in-place card with Retry under the kept head; a 429 (the
hourly reach cap it shares with the per-posting feed) is a neutral "Too many requests". A page
cursor the API refuses (a 400 — one it never issued, e.g. hand-edited) is not an outage, by the
admin rule "A refused read is not an outage": a calm "This page link isn't valid" whose one action
is "First page" (filter kept) — never Retry, which could only be refused again (`inboxRefusal` in
`lib/candidate-inbox.ts`). The trail is the group, as text; the page has no children.

**Agency dashboard doors** (final sweep F15/F21 — a glance, not a second rail). The head's primary
is New posting (`/agency/jobs/new`). "Your postings" shows three rows — each card opens that
posting's details, and its "Applicants" link its feed — and "Postings" opens `/agency/jobs`. The
Account tile opens `/account`. The Referral funnel panel's "Invite workers" is the dashboard's one
door to `/agency/referrals`, where the invite form and the batch links live. "Not in this release"
starts closed; Payout details (KYC) and Payouts read "Available on Referrals — payouts are
simulated" and open Referrals only when the SERVER has payouts on (`AGENCY_PAYOUTS_ENABLED`, read
the way Referrals reads it: the earnings route answers) — the public `NEXT_PUBLIC_ENABLE_AGENCY_*`
flags never claim it. Removed (they repeated the rail or led nowhere): the Worker activity, QR
invite, Batch invites and Bulk invite upload tiles, and the inline invite form. Revenue is a rail
destination; the agency sections link it nowhere.

**Referrals** (`/agency/referrals`, final sweep F19) reads: the funnel, then "Invite workers" — its
one primary, "Create invite link", directly under the consent note, with the four optional settings
in an "Options" disclosure (closed while empty, open whenever one is set) — then the batch links in
a closed disclosure with a secondary "Create links", then earnings / payouts. On a phone (≤600px)
the invite panel comes first and the funnel second, so "Create invite link" is on the first screen
(final re-sweep: it sat under 355px of funnel tiles at 375x812); the DOM order, and every wider
screen, keep the funnel first.

**Plans & capacity is a Company page** (2026-10-01, a consequence of ruling 2): everything it sells
is an entitlement on company postings (`job_postings`) — concurrent capacity, per-posting applicant
quota, posting plans — and an agency posts agency jobs only. The agency rail and dashboard do not
offer it, and an agent who opens `/plans` or `/capacity` is redirected to `/dashboard` before any
read. Credits stays for both personas and every member, so every agency rail keeps its Billing
group (Credits); only Organisation (Team) is owner-only.

### Header (every portal page)

| Element      | Label                                     | Route / action | Purpose                                                                    | Permission / flag                                         |
| ------------ | ----------------------------------------- | -------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| Brand lockup | "BadaBhai for Companies" / "for Agencies" | `/dashboard`   | Home                                                                       | P                                                         |
| Breadcrumb   | group, then the section                   | the section    | Section context only: never the page itself (its H1 names it), never an id | derived from the rail                                     |
| Credits chip | wallet icon + "{n} credits"               | `/credits`     | The balance — shown once per screen                                        | link for every member (P); hidden on a read error         |
| Account menu | "Account"                                 | `/account`     | The payer's own settings page                                              | P                                                         |
| Account menu | "Sign out"                                | server action  | Sign out                                                                   | P                                                         |

The breadcrumb is a section path, and **one door per destination** decides whether its section step
is a link: on a page ONE level below a destination, whose back link already opens it
(`NavItem.childrenLinkBack`), the step is plain text; on a deeper page (whose back link goes to a
nearer parent) it stays a link. A trail with no link is plain text, not a `<nav>` landmark. A trail
link is at least 44px wide and tall on a phone or touch screen, and the trail is either that whole
target or not drawn: it takes the header's free space as a size container and draws nothing when
that is narrower than 44px (the H1 and back link carry the context there). From 360px to 374px the
header and the balance chip pad one step tighter, so the trail is drawn at 360px with a 5-digit
balance (measured). `crumb-back.test.tsx` renders the shell around every page, both personas, and
fails if a trail link and a back link ever open the same page.

When an error replaces a page (`(portal)/error.tsx`), the page's back link goes with it, so the error
state offers the way back up: the section the path sits under (the trail's destination, from the
same nav model — `navTrail`) and the Dashboard, beside Try again; neither on the page it would
reopen. The applicants page's "No posting found here" state links to Postings.

| Route                        | Trail                            | Back link                 |
| ---------------------------- | -------------------------------- | ------------------------- |
| `/postings`, `/postings/new` | "Hiring" (text)                  | —                         |
| `/candidates`                | "Hiring" / "Demand" (text)       | —                         |
| `/postings/<id>`             | "Hiring › Postings" (text)       | Postings                  |
| `/postings/ai/new`           | "Hiring › New posting" (text)    | New posting               |
| `/postings/<id>/edit`        | "Hiring › **Postings**" (link)   | the posting, by its title |
| `/postings/<id>/applicants`  | "Hiring › **Postings**" (link)   | the posting, by its title |
| `/agency/jobs/<id>`          | "Demand › Postings" (text)       | Postings                  |
| `/agency/jobs/<id>/edit`     | "Demand › **Postings**" (link)   | the posting, by its title |
| `/agency/jobs/<id>/applicants` | "Demand › **Postings**" (link)   | the posting, by its title |
| `/team/accept` (owner)       | "Organisation › **Team**" (link) | —                         |
| `/dashboard`, `/account`     | none                             | —                         |

The credits chip below 540px shows the number only: the unit word is visually hidden but stays in
its accessible name ("1234 credits — open Credits"), and the shared icon
tooltip shows "1234 credits" on hover and keyboard focus.

### Pages below a nav destination (back link = the real parent)

Every page renders one `PageHeader` (`src/components/page-header.tsx`): back link (these pages
only) · H1 + one-sentence description · status · one primary action · secondaries · optional
toolbar. Top-level pages (rail or account menu) have no back link.

| Persona | Route                       | H1                 | Back link                                               | Header actions                                                     | Permission / flag             |
| ------- | --------------------------- | ------------------ | ------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------- |
| Company | `/postings/ai/new`          | Post with AI       | New posting                                             | —                                                                  | P; agent → `/agency/jobs/new` |
| Company | `/postings/<id>`            | the role title     | Postings                                                | status · View applicants · Edit posting (draft: Edit posting only) | P (owned posting)             |
| Company | `/postings/<id>/edit`       | Edit posting       | the posting, by its title                               | — (Save / Publish posting in the form)                             | P; agent → `/postings/<id>`   |
| Company | `/postings/<id>/applicants` | Applicants         | the posting, by its title ("Posting details" if unread) | toolbar: New / Shortlist tabs                                      | P; agent → `/postings/<id>`   |
| Agency  | `/agency/jobs/<id>`         | the posting title  | Postings                                                | status · Applicants · Edit posting (closed / suspended: Applicants) | A + F                         |
| Agency  | `/agency/jobs/<id>/edit`    | Edit posting       | the posting, by its title                               | — (Save changes / Cancel in the form)                              | A + F; closed / suspended → `/agency/jobs/<id>` |
| Agency  | `/agency/jobs/<id>/applicants` | Applicants         | the posting, by its title                               | —                                                                  | A + F                         |

**An agency posting's applicants** are its own feed (`/agency/jobs/<id>/applicants`, #1956): since
#1955 the applicant endpoint serves an agency's `jobs` rows — only the workers who applied — so the
posting's details (primary "Applicants"), its Postings row and its dashboard card all link it.

**An agency posting is edited on its own page** (`/agency/jobs/<id>/edit`, final sweep F02), headed
like the company edit page, with the head leading the form column so the card preview starts at
the top. It replaced the inline editor in the Postings row. Its details header and its Postings row
offer it for an open or paused posting only (`isEditableJob`); a closed or suspended one's edit URL
lands on its details.

Top-level pages outside the rail (no back link): `/account` (H1 "Account", the account menu's
item; P), `/team/accept` (H1 "Join a team", the invite email's link; P — its trail is
"Organisation › Team" for an owner, none for a recruiter) and `/agency/bulk-upload` (H1 "Bulk invite
upload", reached by URL only; A + F).

Redirects (kept so old links resolve): `/` → `/dashboard` or `/login`; `/profile` → `/account`;
`/agency/dashboard` → `/dashboard`; `/capacity` → `/plans#hiring-capacity` (the Hiring capacity
section of Plans & capacity — ONE place for it; an agent goes to `/dashboard`). Links inside the
app point at `/plans#hiring-capacity` directly (the New posting at-capacity alert).

Fragment targets (`#hiring-capacity`, `#batch-invites`, the legacy `#agency-vacancies`) carry
`.anchor-target`, which keeps them below the sticky header when a link lands on them; a test fails
if an in-app link to another page's fragment targets an element without it.

### No loading boundary above a page

There is no route `loading.tsx` and no `<Suspense>` in the portal
(`src/app/no-suspense-above-a-page.test.ts`). Next keys the `(portal)` boundary by the first
segment under it, so it stayed mounted across every same-section navigation (`/postings` →
`/postings/<id>`, every `/agency/*` page). On a production build of next 15.5.25, clicks made
within a few seconds of the page becoming interactive often never committed (the URL never
moved): Agency postings → a posting 3/10, the rail's Worker activity 6/10, Postings → a posting
7/10, against 30/30 into another section (three links, 10 clicks each). With no boundary:
320/320 — the same eleven links × 10 clicks after hydration and in the sweep's timing, 20 more on
each link that had stalled, and clicks 250ms / 1s after hydration — and 220/220 again (eleven
links × 10, both timings) once the pending cue below landed. The trade-off: a
navigation keeps the current page on screen until the next one has rendered — there is no
skeleton. Same-section navigations never showed it anyway (React holds the visible page during a
transition); a link into another section did (at ~0.1–0.25s on a slow backend) and now holds the
current page instead. The same fence forbids `React.lazy` and `next/dynamic` (each suspends into
a boundary). Re-measure before adding one back after a Next or React upgrade.

**The pending cue** (`src/components/nav-pending.tsx`) answers the click instead: Next's
`useLinkStatus` on the link that started the navigation — no boundary. A dot on the corner of a
rail / drawer row, the brand lockup, the header's balance chip (Credits), the trail's link, a
`PageHeader` action or back link, a posting row's title and Applicants link (Postings, Agency
postings), a dashboard card's Applicants link, and on Candidates every link that changes only the
query (the pager's First page / Next page, a state's First page, "All postings") and each card's
"Applied to" posting link; a thin bar along the top of the viewport (the cue
a phone sees — the drawer closes as its link is followed); and one polite status line, "Opening
Postings…", in the shell outside the region that goes inert behind the open drawer. Nothing shows
for the first 180ms, so a prefetched navigation never flashes; reduced motion drops the pulse and
the growing bar but keeps that delay. The dot TAKES NO SPACE: it is absolutely positioned on its
link's corner (inside the corner on a rail row, which clips), and the link is positioned whether or
not it is pending — so a click never widens a button or pushes a badge (review of #2115: +24px on a
header action, +16px on a title link, before; 0px after, measured on a production build).

**Every in-app link carries it** (follow-up to #2115). Only a cued link announces, and #2115 left
~20 without one — on a slow backend a dashboard quick card answered a click with ~3s of nothing.
So the cue is never placed by hand: every in-app link is a `PortalLink`
(`src/components/portal-link.tsx`) — next/link's `Link` with the cue as its last child — and it
cannot be written without a `pendingLabel`, the destination the status line names. No other
module may render next/link's `Link` or place the cue (`src/app/every-link-shows-the-cue.test.ts`,
read from the syntax tree over all of `src/`, so a route added later is covered the day it lands).
That brought in the dashboard's quick card, attention action and panel links, the DS `Card` /
`StatTile` whole-surface overlay (its dot sits inside the card's top-right corner, in the heading
colour — the overlay itself is transparent; the card's layout and hover lift are untouched), every
row's "Edit posting", the plans and posting-form links, the account menu's Account item, the AI
chat's "manual form" link, the error boundary's and the 404's way out, and on Candidates the empty
state's Postings / New posting beside its pager, state and "Applied to" links. A needs-you item's
action names its destination ("Opening Credits…" for "Buy credits"): it is one typed object
(href, label, pendingLabel, icon), so an item cannot offer a door the cue cannot name. The
account menu's panel now stays mounted while closed (`hidden`): its link must outlive the click
that closes the menu, or the bar and the status line go with it (the dot is hidden with the
panel; the bar is the cue there, as on a phone's drawer). A `PortalLink` takes an absolute path
or a query on the same page ("?cursor=…" — a soft navigation, cued like any other). Not a
`PortalLink`, by design: an external URL, `mailto:` / `tel:`, a hash-only `#id`, a download or a
new tab — plain `<a>`, since none leaves an in-app navigation pending (the fence rejects a
`PortalLink` to any of them). The converse holds too: a plain `<a>` to an in-app path is a full
reload with no cue, and the fence rejects it unless it downloads, opens a new tab, or is named in
its allowlist with a reason (none today). Measured on a production build, 1.5s per read, on eight
of them (quick card, panel "Postings", a card's whole-card link,
the Account item, a plans row title, plans "New posting", both rows' "Edit posting") at 1280 and
375, five clicks each: 80/80 committed; the cue showed at 190–213ms (the Account item: its bar
and status line, at 195–210ms); 0px shift of the clicked link, its ancestors or the page; nothing
left on screen after the commit. The same links before: 0/30 showed anything, for 1.5–4.8s. A
fast backend (commits at 53–129ms) showed no cue at all (0/24) — no flash.

Not yet cued: no link. Outside this rule: a button that navigates with `router.push` (a form's
submit, the agency form's Cancel) — it is not a link, so it has no link status to show.

### Agency on the company surface

Agencies post agency jobs only. The company posting surface is never linked for an agent:

- `/postings/new`, `/postings/ai/new` → redirect to `/agency/jobs/new` (or `/dashboard` when F is off).
- `/postings` → redirect to `/agency/jobs` (or `/dashboard` when F is off), unless the agent owns
  older company postings. **Older postings — read-only, by direct link**: nothing in an agency's
  portal links to them. They are listed under the H1 "Older postings" (no create, edit, lifecycle
  or applicants link — each title opens its details), with one link to the agency's Postings while
  F is on.
- `/postings/<id>` → read-only: no action at all (no View applicants, no Edit posting).
- `/postings/<id>/edit` and `/postings/<id>/applicants` → redirect to `/postings/<id>` before any
  read (the feed unlocks contacts; a read-only posting offers no such action).
- `/candidates` → the API lists applicants to these older postings too; each such card is VIEW-ONLY:
  its posting title is plain text (no link) and it offers no Unlock. The rule is the posting's own
  page's, per row (`lib/candidate-inbox.ts` `candidatePosting`); the server still decides every spend.
- `/plans`, `/capacity` → redirect to `/dashboard` (a company page — see the rail).
- The backend role gate for this surface is issue #1885.

### Vocabulary (labels only — no route or API path was renamed)

| Concept                        | Label                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| The job entity (both personas) | Posting: New posting · Postings · Posting details · Edit posting · Publish posting |
| Headcount on a posting         | Openings                                                                           |
| Person in a posting's feed     | Applicant                                                                          |
| Every applicant, all postings  | Candidates (the tab; a posting's own feed stays "Applicants")                      |
| Person an agency referred      | Worker                                                                             |
| The balance                    | Credits (wallet icon everywhere)                                                   |
| Buying the balance             | Buy credits                                                                        |
| A bought pack (credit history) | Purchase                                                                           |
| Buying a posting more views    | Add applicant slots (stack-plus icon)                                              |
| Billing area / tier / cap      | Plans & capacity · Hiring capacity · Applicant quota                               |
| Agency KYC                     | Payout details (KYC)                                                               |
| Personas                       | Company · Agency (browser title "BadaBhai for Business")                           |
