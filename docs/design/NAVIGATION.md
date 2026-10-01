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
2. **Title**, then a **one-sentence description**. Mechanics and privacy notes go in an alert
   or notice below the header, not in the description.
3. **Actions.** The page's own action first (Flag, Suspend / Reinstate, Force-close, Invite an
   admin, Record a decision), then related views (View journey, View event timeline). Only
   page-relevant actions, each offered once on the screen.
4. **Filters** directly below the header (`filters` slot), never in the actions slot.
5. **Topbar crumb** (`topbar-crumb.tsx`): the group, then the linked section once the page sits
   below it, then readable intermediate steps ("Journey"). It never repeats the h1, and it never
   shows an opaque id.
6. **Tab title.** `metadata.title` names the page. The root template adds " · BadaBhai Admin",
   so a page never includes it itself.

### Link and label conventions

- **One "Clear filters" per list**, in the results head, shown whenever a filter is set. Empty
  and error states offer only a recovery that nothing else on screen offers.
- **"View events"** opens the global log (`/events`). **"View event timeline"** opens one
  record's timeline. Both are offered only to a session holding `read_events`; this is an
  affordance, and each route keeps its own gate.
- **"Retry"** reloads the same query, including its cursor.
- **Per-row controls** that share a visible name ("Suspend", "View") add the row's subject for
  assistive tech, after the visible label.
- **Icons** come from `@badabhai/icons` only (`<Icon>`, `ACTION_ICON`). Key actions show icon
  and text. Icon-only controls use the admin `IconButton`. No arrow, tick or cross characters
  stand in for icons, and every `<summary>` draws the brand caret.
