# Display preferences API — the theme (`…/me/display-prefs`)

Issue #2819 (part of #2818) · switch `THEME_ROLLOUT` (#2820) · migration `0165_display_prefs` ·
code: `apps/api/src/display-prefs/*` · shared contract: `@badabhai/types`
(`DisplayPrefsResponse`, `UpdateDisplayPrefsRequest`, `DISPLAY_THEMES`) and `@badabhai/validators`
(`updateDisplayPrefsSchema`, `displayPrefsResponseSchema`).

Each login's theme (`light`, `dark` or `system`) is saved once on the server, so it follows the person
across devices and between the web portal and the app. Three logins, one route pair each, all with
the same body and the same reply:

| Login                                          | Routes                                    | Auth                                                       |
| ---------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| Worker (worker app)                            | `GET` / `PATCH /workers/me/display-prefs` | `WorkerAuthGuard` only — **no `ConsentGuard`** (see below) |
| Company or agency login (payer-web, payer app) | `GET` / `PATCH /payer/me/display-prefs`   | `PayerAuthGuard` only — `employer` and `agent` alike       |
| Admin (admin-web)                              | `GET` / `PATCH /admin/me/display-prefs`   | `AdminAuthGuard` only — every admin role                   |

## Rules for all six routes

| Rule           | Detail                                                                                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whose row      | ALWAYS the token's login: the id the realm's guard attached. No path, query or body id exists or is read. A company login's row is the PERSON's (its own `payers.id`), never the company's: two teammates keep two themes. |
| Headers out    | `Cache-Control: no-store` (always).                                                                                                                                                                                        |
| Body (`PATCH`) | `{ "theme": "light" \| "dark" \| "system" }`, strict: any other key (a `worker_id`, `payer_id`, `admin_id`, anything) or an empty body is a `400` (`{"message":"Validation failed","issues":[…]}`).                        |
| Reply (both)   | `{ "theme": "light" \| "dark" \| "system", "theme_open": true \| false }` — `PATCH` returns the RESULTING prefs, so no second `GET` is needed.                                                                             |
| No row         | `light`.                                                                                                                                                                                                                   |
| Same value     | A `PATCH` of the theme already in force (including `light` when nothing is stored) is a `200` that writes nothing and emits nothing.                                                                                       |
| Event          | Each real change emits one `display_prefs.changed` v1 `{ subject_kind, subject_id, from, to }` in the same transaction as the row (ids and enums only). No event for a `GET` or a repeat.                                  |

## The switch (`THEME_ROLLOUT`, #2820)

| Switch for this login                                       | `GET`                                                                                  | `PATCH`                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------- |
| `off` (the default), or `pilot` and the login is not listed | `{ "theme": "light", "theme_open": false }`, whatever is stored; the table is not read | plain `404`, nothing written |
| `pilot` and listed, or `on`                                 | the stored theme (or `light`), `theme_open: true`                                      | saves, `200`                 |

- **Pilot lists.** A worker or an admin is listed in `feature_pilot_subjects`; a company in
  `feature_pilot_payers` by its tenant key, so under `PAYER_ORG_TENANCY_MODE=on` a team member
  inherits the company's pilot place (the row stays the member's own). The company's tenancy is
  resolved only while the switch is `pilot`; `off` and `on` read no membership. If tenancy refuses
  the login, the theme is simply closed for it — never a `403` on these routes.
- **A stored choice waits.** Closing the switch hides a choice but never deletes it; the person gets
  it back when piloted again.
- **Before migration 0165** (open switch, table or column missing — 42P01 / 42703): `GET` answers
  `light` / `theme_open: false` and `PATCH` a `404`. Never a `500`.

## Errors

| Status        | When                                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `400`         | `PATCH` body not exactly `{ "theme": <one of the three> }`                                                        |
| `401`         | no / expired session of the route's realm (a worker token on a payer route is a `401`, etc.)                      |
| `404`         | `PATCH` while the switch is closed for the login, or before migration 0165                                        |
| `403` / `410` | only the realm guard's own refusals (a suspended payer, a deleted payer's `410`), as on every route of that realm |

## Why the worker pair has no `ConsentGuard`

The worker app's splash and sign-in screens paint before the worker has consented, and they need
the theme to do it. The reply is a closed-set preference about the app, keyed by an opaque id; no
profile data is read or returned. `common/guard-contract.test.ts` pins `[WorkerAuthGuard]` alone.

## For the apps (Rishi: #2821, #2822, #2824, #2828, #2830, #2832)

- **`theme_open: false` means: show no theme choice, and use light.** Hide the Light / Dark /
  System control entirely; do not grey it out. Treat any non-`200` `GET` (a network error, a `5xx`,
  an old server without the route — `404`) the same way: light, no choice.
- **`theme_open: true`:** show the choice with `theme` selected and apply it; `system` follows the
  phone's or the browser's setting live.
- On a change, `PATCH` and apply the returned `theme`. A `404` from `PATCH` means the switch closed
  meanwhile: fall back to light and hide the choice.
- Read it when a session starts (and on resume), after sign-in; the worker route works before
  consent. Do not cache across logins: the theme belongs to the token's login.
- payer-web keeps its existing `bb_theme` cookie toggle and first-visit behaviour while
  `theme_open` is `false` (#2818 rule); the server answers `light` in that state, which is not an
  instruction to override the cookie.
- Printed and PDF output, emails and exports stay light whatever the theme.
