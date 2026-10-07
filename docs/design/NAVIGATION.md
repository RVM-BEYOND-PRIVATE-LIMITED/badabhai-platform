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
  and says what was refused. Where a page's chips list every value a filter can take (the
  ledger's reasons, order statuses, admin roles and statuses), only a value they do not offer
  — or a customer id that is not a uuid — counts as a refusable filter (`isUnknownValue`): a
  valid reason beside an over-long cursor is the cursor's refusal, not the reason's.
  - **a filter is set** → the filters. The API refuses a page cursor only when it is longer
    than any it issues (a malformed one falls back to page one), so with a filter set the
    filter is at fault and its first page would be refused too: the state's action is "Clear
    filters", the screen's one (the credit ledger's is "Clear the reason filter", which keeps
    the window).
  - **no filter, a page cursor** → the cursor: "Back to the first page" (`FirstPageAction`;
    Skill discovery's flat view lays out the bare `FirstPageLink`, keeping `view=flat`).
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
  `next/dynamic` with `loading` — in any layout, page or component
  (`app/no-loading-boundary-anywhere.test.ts`). A query-only navigation (a chip, a filter, a
  page cursor) re-renders the same page, so any boundary in it is already visible, and on a
  production build of next 15.5.25 such a navigation was held in a transition that never
  committed (the URL never moved: 1-2 of 6 clicks landed on /credits, /events and
  /transactions; 400/400 with no boundary). A navigation keeps the current page on screen until
  the next one has rendered. Re-measure before relaxing this after a Next or React upgrade.
- **A navigation shows that it is under way** (review of #2095). The sidebar links (rail and
  drawer) and the crumb's section link carry `components/nav-pending.tsx`: while Next's
  `useLinkStatus` says the link's navigation is pending, a dot after its label, a bar along the
  top of the viewport (the cue a phone sees, since the drawer closes as its link is followed)
  and one polite status line, "Opening Workers…". All three end when the navigation commits.
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

`getOrgRole()` is a stub that returns `recruiter` for every session outside dev/test
(GAP-FE-01, `docs/payer-agent/GAP_REGISTER.md`), so O routes and nav-O items are absent for real
users today. No link to an O route is rendered for a non-owner.

### Rail (desktop ≥1024px; the same list is the drawer below 1024px)

| Persona | Group        | Nav item         | Route               | Page                        | Purpose                                                    | Permission / flag                              |
| ------- | ------------ | ---------------- | ------------------- | --------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| Both    | —            | Dashboard        | `/dashboard`        | `dashboard/page.tsx`        | What needs you, position, quick actions, recent work       | P                                              |
| Company | Hiring       | New posting      | `/postings/new`     | `postings/new/page.tsx`     | Create a company posting (`job_postings`)                  | P; agent → redirected to `/agency/jobs/new`    |
| Company | Hiring       | Postings         | `/postings`         | `postings/page.tsx`         | List + pause / resume / add applicant slots / close        | P; agent → see "Agency on the company surface" |
| Agency  | Demand       | New posting      | `/agency/jobs/new`  | `agency/jobs/new/page.tsx`  | Create an agency posting (`jobs`, the worker feed's table) | A + F; nav-F                                   |
| Agency  | Demand       | Postings         | `/agency/jobs`      | `agency/jobs/page.tsx`      | List + pause / resume / close; links details, applicants, edit | A + F; nav-F                               |
| Agency  | Supply       | Worker activity  | `/agency/workers`   | `agency/workers/page.tsx`   | Faceless funnel of the workers the agency referred         | A + F; nav-F                                   |
| Agency  | Supply       | Referrals        | `/agency/referrals` | `agency/referrals/page.tsx` | Invite link, batch links, funnel, earnings / KYC / payouts | A + F; nav-F                                   |
| Agency  | Supply       | QR invite        | `/agency/qr`        | `agency/qr/page.tsx`        | Printable QR invite sheet                                  | A + F; nav-F                                   |
| Company | Billing      | Plans & capacity | `/plans`            | `plans/page.tsx`            | Usage, Hiring capacity, applicant quota, credits, plans    | P; agent → redirected to `/dashboard`          |
| Both    | Billing      | Credits          | `/credits`          | `credits/page.tsx`          | Credit balance, buy credits, history, expiry               | O; nav-O                                       |
| Both    | Organisation | Team             | `/team`             | `team/page.tsx`             | Members, invite a recruiter                                | O; nav-O                                       |
| Agency  | Coming soon  | Revenue (Soon)   | `/agency/revenue`   | `agency/revenue/page.tsx`   | Parked explainer (no data)                                 | A + F; nav-F                                   |

Not in the rail, on purpose: **Bulk invite upload** (`/agency/bulk-upload`). It is dead — a consent
violation that will never be built (ADR-0022 Amendment 3) — and is never framed as coming. Nothing in
the portal links to it (final sweep F17: the dashboard's "not available" tile was a dead end, and is
gone); the route stays so an old link lands on its explanation, which points at batch invite links.

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
read. Credits stays for both personas (Owner-only). An agency recruiter therefore has no Billing
group at all.

### Header (every portal page)

| Element      | Label                                     | Route / action | Purpose                                                                    | Permission / flag                                         |
| ------------ | ----------------------------------------- | -------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| Brand lockup | "BadaBhai for Companies" / "for Agencies" | `/dashboard`   | Home                                                                       | P                                                         |
| Breadcrumb   | group, then the section                   | the section    | Section context only: never the page itself (its H1 names it), never an id | derived from the rail                                     |
| Credits chip | wallet icon + "{n} credits"               | `/credits`     | The balance — shown once per screen                                        | link for O only; static otherwise; hidden on a read error |
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
its accessible name ("1234 credits — open Credits" for an owner's link), and the shared icon
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
- `/plans`, `/capacity` → redirect to `/dashboard` (a company page — see the rail).
- The backend role gate for this surface is issue #1885.

### Vocabulary (labels only — no route or API path was renamed)

| Concept                        | Label                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| The job entity (both personas) | Posting: New posting · Postings · Posting details · Edit posting · Publish posting |
| Headcount on a posting         | Openings                                                                           |
| Person in a posting's feed     | Applicant                                                                          |
| Person an agency referred      | Worker                                                                             |
| The balance                    | Credits (wallet icon everywhere)                                                   |
| Buying the balance             | Buy credits                                                                        |
| A bought pack (credit history) | Purchase                                                                           |
| Buying a posting more views    | Add applicant slots (stack-plus icon)                                              |
| Billing area / tier / cap      | Plans & capacity · Hiring capacity · Applicant quota                               |
| Agency KYC                     | Payout details (KYC)                                                               |
| Personas                       | Company · Agency (browser title "BadaBhai for Business")                           |
