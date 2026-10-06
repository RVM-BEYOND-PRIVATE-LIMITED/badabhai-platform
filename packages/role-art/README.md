# @badabhai/role-art

The animated **role illustrations** that head every job card — the worker app's swipe/list card
and the payer portal's live card preview draw the same picture for the same `role_kind`.

- **Source:** `art/<role_kind>.svg` — one in-house, original illustration per declared role kind
  (`TRADE_FORM_KINDS_ALL` in `@badabhai/types`) plus `generic.svg`, the fallback for a missing or
  unknown kind. `art/ORDER` lists them in declared order.
- **Generated (never hand-edit):** `node scripts/generate.mjs` (`pnpm --filter @badabhai/role-art art:generate`)
  writes `src/generated/role-art-data.ts` + `role-art.css` (web) and
  `apps/worker-app/lib/core/widgets/role_art/role_art_data.g.dart` (Flutter). `pnpm test` runs
  `--check` first, so a stale artifact fails CI.

## Authoring rules (enforced by the generator — it fails, it never silently drops)

- Canvas `viewBox="0 0 300 100"`, floor at y=84, the monogram figure at x≈70 facing the trade's
  signature tool/machine on the right. `data-loop` = the role's loop, 2–4 s.
- Elements: `<g data-part>` (one level, no nesting) holding `path` / `circle` / `ellipse` / `rect`.
  Path commands `M L H V C Q A Z` (absolute or relative).
- Paint: only `#05194C` Shift Blue, `#FFB32C` Safety Yellow, `#F3F5F4` Ivory; opacity 1/.8/.6/.4;
  strokes ≥ 4 wide, always round-capped and round-joined (thick, soft — never wireframe).
- Motion: 1–2 moving parts per role, `data-motion` ∈ swing · nod · spin · bob · slide · shuttle ·
  convey · pulse · blink, with `data-amp`, `data-origin="x y"`, `data-rate` (whole cycles per loop)
  and `data-phase`. Every motion's first keyframe is the rest pose — what reduce-motion shows.

## Consuming it

- **Web:** `"@badabhai/role-art": "workspace:*"`, add it to `transpilePackages`, `@import
"@badabhai/role-art/role-art.css"` once, render `<RoleArt roleKind={…} />`. Motion is CSS
  keyframes on the named groups; `prefers-reduced-motion: reduce` holds the rest pose.
- **Flutter:** `RoleArtBanner(roleKind: …)` from `lib/core/widgets/role_art/role_art.dart` — a
  `CustomPainter` over the generated path data (no `flutter_svg`), one `AnimationController` per
  banner, still under `MediaQuery.disableAnimations`, `animate: false` or `TickerMode` off.

Both resolve the kind defensively: anything that is not a declared kind draws `generic`.
