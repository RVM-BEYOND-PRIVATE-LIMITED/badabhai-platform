# Navigation

The navigation inventory of the BadaBhai web portals: every sidebar item, the route it opens,
what the page is for and the capability that gates it, plus the header rules every page follows.
Each portal keeps its own section. Update the section in the same change as the navigation it
describes.

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
| Skills         | Skill discovery        | `list-magnifying-glass`   | `/skills/discovery` | `(portal)/skills/discovery/page.tsx` | The skill-candidate review queue                            | `read_entities` (deciding: `review_skill_candidates`) |
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
| `/companies/[id]/timeline`, `/agencies/[id]/timeline` | Event timeline         | Company {id} / Agency {id} → the account                                             | `read_events`                                |
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
   timestamp folded into that sentence. Mechanics and privacy notes go in an alert or notice
   below the header. `components/page-description.test.ts` holds every description, in every
   branch it can render, to one sentence.
3. **Actions.** The page's own action first (Flag, Suspend / Reinstate, Force-close, Invite an
   admin, Record a decision), then related views (View journey, View event timeline). Only
   page-relevant actions, each offered once on the screen. The title block grows into the row
   with an 18rem floor, so the actions sit beside the title whenever both fit and wrap below
   it otherwise.
4. **Filters** directly below the header (`filters` slot), never in the actions slot.
5. **Topbar crumb** (`topbar-crumb.tsx`): an ordered list — the group, then the section once
   the page sits below it, then the named views between the section and the page ("Journey").
   It never repeats the h1, and it never shows a record's id (only the views listed in
   `SEGMENT_LABELS` are named). The section is linked only when the reader's sidebar holds it,
   so a reader is never offered a link that redirects them.
6. **Current location.** The sidebar marks the exact page `aria-current="page"`; on a page
   below it, the item is the current section (`aria-current="true"`). Chip filters mark the
   active chip `aria-current="true"` and give it the primary fill.
7. **Tab title.** `metadata.title` names the page. The root template adds " · BadaBhai Admin",
   so a page never includes it itself.

### Link and label conventions

- **One "Clear filters" per list**, in the results head, shown whenever a filter is set. It
  clears every filter (the bare route). A clear that removes one filter and keeps the rest is
  named for that filter: "Clear the worker filter", "Clear the tag filter", "Clear the reason
  filter" (the credit ledger, which keeps the reporting window). Empty and error states offer
  only a recovery that nothing else on screen offers.
- **"View events"** opens the global log (`/events`). **"View event timeline"** opens one
  record's timeline. Both are offered only to a session holding `read_events`; this is an
  affordance, and each route keeps its own gate.
- **"Retry"** repeats exactly the current query, page cursor included. **"Back to the first
  page"** is the same query without the cursor, and appears only when there is one. Every
  paged list's failed read renders both through `components/retry-actions.tsx` (Workers,
  Postings, Events, Companies, Agencies, the event timelines, Payment orders, the credit
  ledger, Skill discovery's flat view, AI calls, Feedback); a test fails if one does not pass
  its cursor. AI calls and Feedback, which tell a refused request apart, offer only "Back to
  the first page" in that refusal state.
- **One instruction per failure.** Where a Retry button sits under an error, the copy does not
  also say "reload". A failure with no button (a secondary read on a detail page) says
  "Reload this page".
- **Per-row controls** that share a visible name ("Suspend", "View") add the row's subject for
  assistive tech, after the visible label.
- **Touch targets.** On a phone or any coarse pointer, every small text link reaches 44px:
  table links through a row-high hit strip; stacked cell links, record-row links (a posting's
  owner, an AI call's worker, session and correlation id), id chips, the back link and the
  crumb's section link by taking the height themselves. Record rows then align on the text
  baseline, so a 44px link stays beside its label.
- **Names.** "Resume" (one spelling), "MFA" (never "second factor"), "account" / "Customers"
  for Company and Agency together (never "Payer" on screen), "Posting" for the job entity.
  `lib/terminology-fence.test.ts` keeps the retired names out of the console's visible text. Event names are data and keep their words (`payer.suspended`); where one is
  shown humanized, its domain reads as the console says it ("Customer · suspended",
  "Posting · created" — `humanizeEventName`).
- **Icons** come from `@badabhai/icons` only (`<Icon>`, `ACTION_ICON`). Key actions show icon
  and text. Icon-only controls use the admin `IconButton`. No arrow, tick or cross characters
  stand in for icons, and every `<summary>` draws the brand caret.
