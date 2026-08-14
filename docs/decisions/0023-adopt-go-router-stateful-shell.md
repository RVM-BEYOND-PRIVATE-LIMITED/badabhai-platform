# ADR-0023: Adopt go_router + StatefulShellRoute for the worker-app 4-tab shell

- Status: Accepted
- Date: 2026-06-26
- Scope: `apps/worker-app` (Flutter) only. No backend, schema, event, or AI-path impact.
- Supersedes: the `Map<String, WidgetBuilder> appRoutes` Navigator-1.0 router in
  [apps/worker-app/lib/router.dart](../../apps/worker-app/lib/router.dart).

## Context

Phase-1 shipped the worker app as a single linear flow (Splash → … → ResumePreview)
on Navigator 1.0 with a flat `Map<String, WidgetBuilder>` route table. The Desi
Vernacular Pop build kit (`docs/design/BadaBhai Design System/android-build-kit`)
adds a **persistent 4-tab bottom nav** (Jobs · Resume · Profile · Alerts) where each
tab owns an independent back stack, plus full-screen detail routes that must cover
the bar (JobDetail, ResumeEdit, KitDetail, Settings, Building) and branch sub-routes
that keep it (Applied, Kit).

Navigator 1.0 cannot express per-tab back stacks or an indexed-stack shell without a
large amount of bespoke plumbing. The two realistic options:

1. **Hand-rolled `IndexedStack` + nested `Navigator`s** — no dependency, but we would
   re-implement branch state retention, deep-link parsing, and typed params ourselves.
2. **`go_router` + `StatefulShellRoute.indexedStack`** — the Flutter-team-maintained
   router whose canonical use case is exactly a stateful bottom-nav shell.

## Decision

Adopt **`go_router`** and model the app as two zones:

- **Onboarding** (linear, no bottom nav): `splash → phone → otp → consent → chat →
  profiling-preview → building → resume`, as top-level `GoRoute`s on the root navigator.
- **Shell** (persistent bottom nav): a single `StatefulShellRoute.indexedStack` with
  four branches (Jobs, Resume, Profile, Alerts), each its own `Navigator`.

Nav-presence rule (from the spec): a screen that draws the bar is a **branch route**;
a screen that hides the bar is a `GoRoute` with `parentNavigatorKey: rootNavigatorKey`
so it renders on the root navigator above the shell.

The `Routes` string constants are kept and extended, so existing `pushNamed` call-sites
migrate mechanically to `context.go/push(Routes.x)`. `app.dart` moves to
`MaterialApp.router`. The MOCK banner builder is preserved.

Entering the shell from onboarding uses `context.go(Routes.resume)`, which clears the
onboarding stack and lands on the Resume tab root (the same `resume` route is both the
onboarding endpoint and the Resume branch root).

The Interview-kit lives under the **Resume** branch (`tab='resume'` per the spec), so
Profile's "Interview kit" shortcut switches branch and pushes `kit`.

## Consequences

- New dependency `go_router` (^14, within SDK `>=3.4.0 <4.0.0`). Stack is otherwise
  unchanged; this is a worker-app-local routing concern, not a platform decision.
- One-time migration of every `Navigator.pushNamed/pushReplacementNamed` call-site to
  the go_router equivalents; route arguments move from `ModalRoute…settings.arguments`
  to typed `extra`.
- `StatefulShellRoute.indexedStack` keeps each tab's state alive across switches
  (matches the design intent: a half-scrolled feed survives a hop to Alerts).
- Deep-linking and typed path params (`:jobId`, `:tradeKey`) come for free if needed
  later; not used by Phase-1 mock flows.
- No invariant in CLAUDE.md §2 is touched: routing carries opaque ids only; PII stays
  in `SessionRepository`/route `extra` display strings, never logged.

## Alternatives rejected

- **Hand-rolled shell** — more code to own for the exact behaviour go_router already
  ships; rejected on maintenance cost.
- **auto_route / beamer** — heavier (codegen) or less aligned with the first-party
  shell-route primitive; rejected for a single 4-tab shell.
