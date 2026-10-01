# @badabhai/icons

The one icon system for the BadaBhai web portals: payer-web (Company + Agency) and admin-web.

- **Glyphs:** Phosphor, FILL weight only, self-hosted from each app's own origin.
- **API:** a typed `IconName` union, the `<Icon>` element, the product-wide `ACTION_ICON` map, and
  `IconButtonBase` (`@badabhai/icons/button`): the one implementation of the icon-only-control
  contract that both apps' `IconButton`s wrap.
- **No build step.** The package is TypeScript source; each app compiles it through
  `transpilePackages` in `next.config.mjs`.

## Consuming it

Each app declares `"@badabhai/icons": "workspace:*"`, lists it in `transpilePackages`, and imports
the stylesheet once, first, in `src/app/globals.css`:

```css
@import "@badabhai/icons/icons.css";
@import "@badabhai/design-tokens/tokens.css";
```

`icons.css` imports `@phosphor-icons/web/fill` and declares the icon size tokens and the shared
icon-button tooltip (`.bb-icon-tip`). The Phosphor
`@font-face` uses relative URLs, so `next build` emits the font under `/_next/static/media` and
the browser fetches it from the app's origin. Nothing is loaded from a CDN. The face is only
downloaded by a page that paints a glyph, and only the woff2 is requested.

Why first:

- **Cascade.** Phosphor's `.ph-fill` base rule (one class) must come before the app's rules, so
  an app rule that ties with it wins. When the sheet came from a CDN it loaded last and won those
  ties. payer-web's `icon-system.css.test.ts` checks that every single-class rule on a glyph
  element either repeats Phosphor's value or leaves it alone.
- **Requests.** Imported between the token layer and the component layer, the sheet made Next
  split payer-web's CSS into five files. Imported first, it is four.
- The size tokens are `var()` aliases of the token layer, which resolve whatever the import order.

`@phosphor-icons/web` is pinned to an exact version (`package.json`). `names.test.ts` fails if
the installed version differs from the pin. To upgrade:

1. Bump the pin.
2. `pnpm install`.
3. `pnpm --filter @badabhai/icons test` (every `IconName` must still exist in the new sheet).
4. `pnpm audit --audit-level high`.
5. Check a few screens in both apps.

**Known cost, tracked** (issue #1893, follow-up to PR #1886): the whole fill sheet is render-blocking on
every page (+12.3 KB gzipped on the public `/i/<code>` page, which paints no glyph), and the
bundler emits the sheet's three unused font formats (svg 2.77 MB, ttf and woff about 449 KB each)
into each app's image. The planned fix is a generated subset (the `IconName` union only, woff2
only) with a staleness test.

```tsx
import { ACTION_ICON, Icon } from "@badabhai/icons";

<Icon name="plus" />; // <i class="ph-fill ph-plus" aria-hidden="true">
<Icon name={ACTION_ICON.retry} size="sm" />;
<Icon name="check" label="Allowed" />; // a standalone status mark: role="img", named
<Icon name="check" label="" />; // empty or blank label → decorative, never an unnamed image
```

- `<Icon>` is decorative by default (`aria-hidden`), because the text beside it carries the meaning.
- `<Icon>` takes its colour from the current text colour, so a control's hover, active and
  disabled states recolour its icon without an icon-specific rule.
- `<Icon>` is server-safe.
- A misspelt `name` fails typecheck.

## Rules

1. **Icon + text for key actions.** A primary or destructive action, and anything that spends
   money or changes a record, shows its label. The icon reinforces the label; it never replaces it.
2. **Icon-only controls need a label and a tooltip.** Use the app's `IconButton`:
   - payer-web: `components/ds/icon-button.tsx`
   - admin-web: `components/icon-button.tsx`

   Both are thin skins over `IconButtonBase` (`@badabhai/icons/button`, a client module kept out
   of the server-safe index), which implements `IconOnlyControlProps` once. The skin only chooses
   its class root (`bb-iconbtn` / `iconbtn`) and its typed variants and sizes:
   - `label` is required. It is the control's only accessible name: `aria-label`,
     `aria-labelledby` and `title` are typed `never`, and dropped at runtime too.
   - The label shows as a visible tooltip on hover (hover-capable pointers only) **and** on
     keyboard focus. A hover-opened tooltip is hoverable; a focus-opened one is click-through, so
     it never swallows a click meant for what lies under it.
   - Escape dismisses the tooltip whether it was opened by focus (keydown on the button) or by
     hover (a keydown listener on the document, added on pointer enter and removed on pointer
     leave and on unmount). Escape is never swallowed: a drawer or dialog still gets it.
   - `tooltipPlacement`: `top` (default), `bottom`, `start`, `end`, or an edge-aligned
     `top-start` / `top-end` / `bottom-start` / `bottom-end` for a control near a viewport edge
     (`bottom-end` for a dialog ✕ in the top-right corner).
   - A hidden tooltip is `display: none`: no click target and no scroll overflow.
   - The control is a native `<button>`.
   - The hit area is at least 44×44 px on a phone or any coarse pointer, even at `sm`.
   - A pressed or expanded control (`aria-pressed` / `aria-expanded="true"`) takes the Safety
     Yellow fill.

   A natively `disabled` icon button cannot show its tooltip: browsers neither hover nor focus a
   disabled button. If the reason a control is unavailable must stay discoverable, it needs an
   `aria-disabled` variant, which is not built yet.

3. **No glyph or emoji characters as icons.** Don't use `←`, `→`, `✓`, `✕`, `☰`, `•`, a `/`
   separator, the browser's `<summary>` triangle, or any emoji as an icon. Use the matching
   `ACTION_ICON` entry. Characters inside a sentence ("view more → pay more") are prose, not icons.
4. **One concept, one icon.** Take the glyph from `ACTION_ICON` rather than choosing one per
   screen. A retired glyph (`LEGACY_ICON_NAMES`) cannot be used in `ACTION_ICON`.
5. **Fill weight only.** No outline, thin, bold or duotone weight, and no other icon library.
6. **Colour follows the brand rule.**
   - **Structural navigation** uses Shift Blue: `--text-heading`, which turns light on the ink theme.
   - **Active utilities** use Safety Yellow:
     - On navy surfaces, the glyph is yellow (`--text-on-ink-active`).
     - On light surfaces, the control is filled yellow (`--brand`) and the glyph stays navy
       (`--text-on-brand`). Yellow on Ivory measures 1.63:1, which fails as a glyph colour.
   - **Links stay navy on light surfaces**, and their icons inherit the link colour.
   - **Secondary icons** use `--icon-secondary` (60% alpha).
   - **Disabled icons** use `--text-disabled` (40% alpha).

## Sizes

| Token            | Value (alias)      | Used by                                 |
| ---------------- | ------------------ | --------------------------------------- |
| `--icon-size-sm` | 16 (`--text-base`) | `sm` controls (36px), dense rows        |
| `--icon-size-md` | 20 (`--text-lg`)   | `md` controls (44px), the default       |
| `--icon-size-lg` | 24 (`--text-xl`)   | `lg` controls (52px), state heroes      |
| `--icon-gap`     | 8 (`--space-2`)    | the space between an icon and its label |

Buttons in both apps size their icon from these tokens per control size. `<Icon size>` maps to
`.bb-icon--sm|md|lg`. Never size an icon with an inline pixel value.

## Action → icon

`ACTION_ICON` in `src/actions.ts`. `actions.test.ts` keeps this table equal to it.

| Action         | Icon                      | Use for                                                    |
| -------------- | ------------------------- | ---------------------------------------------------------- |
| `create`       | `plus`                    | Create, Post a job, New vacancy                            |
| `add`          | `plus`                    | Add an item (chip, trade, member)                          |
| `edit`         | `pencil-simple`           | Edit                                                       |
| `delete`       | `trash`                   | Delete or remove a record                                  |
| `close`        | `x`                       | Close a dialog, panel or form                              |
| `dismiss`      | `x`                       | Dismiss a toast, remove a chip                             |
| `approve`      | `check`                   | Approve, confirm, accept                                   |
| `reject`       | `x-circle`                | Reject, pass, end a lifecycle (close posting, force-close) |
| `search`       | `magnifying-glass`        | A free-text search field                                   |
| `filter`       | `funnel`                  | Filter, apply filters                                      |
| `clearFilters` | `funnel-x`                | Clear or reset filters                                     |
| `settings`     | `gear`                    | Settings, account settings                                 |
| `view`         | `eye`                     | View, open detail, read                                    |
| `download`     | `download-simple`         | Download                                                   |
| `upload`       | `upload-simple`           | Upload                                                     |
| `back`         | `arrow-left`              | Back links (replaces the `←` character)                    |
| `next`         | `arrow-right`             | Next, continue, go to, view all (replaces `→`)             |
| `more`         | `dots-three-vertical`     | An overflow menu                                           |
| `calendar`     | `calendar-blank`          | Date windows and date filters                              |
| `location`     | `map-pin`                 | Location                                                   |
| `users`        | `users-three`             | Team, applicants, workers (plural)                         |
| `candidate`    | `user`                    | One candidate or worker                                    |
| `applicant`    | `user`                    | One applicant                                              |
| `posting`      | `briefcase`               | Job, posting, vacancy                                      |
| `credits`      | `wallet`                  | Credits, balance, top up credits                           |
| `unlock`       | `lock-key-open`           | Unlock a contact (the action, never the balance)           |
| `topUpQuota`   | `stack-plus`              | Top up applicant quota                                     |
| `send`         | `paper-plane-tilt`        | Send a code, message or invite                             |
| `retry`        | `arrow-clockwise`         | Retry, reload, resend, try again                           |
| `copy`         | `copy`                    | Copy (show `check` once copied)                            |
| `whatsapp`     | `whatsapp-logo`           | Share or contact on WhatsApp                               |
| `call`         | `phone`                   | Call                                                       |
| `publish`      | `rocket-launch`           | Publish a posting                                          |
| `timeline`     | `clock-counter-clockwise` | Event timeline, history, action log                        |
| `external`     | `arrow-square-out`        | Opens in a new tab (a trailing cue)                        |
| `suspend`      | `prohibit`                | Suspend                                                    |
| `reinstate`    | `arrow-counter-clockwise` | Reinstate                                                  |
| `disclosure`   | `caret-down`              | A `<details>` summary (replaces the browser's triangle)    |

## Adding a glyph

1. Add the name to `ICON_NAMES` in `src/names.ts`. Keep the list sorted.
2. Run `pnpm --filter @badabhai/icons test`. The test proves the glyph exists in the installed
   fill sheet.
3. If the glyph is the icon for an action, add it to `ACTION_ICON` and to the table above in the
   same change.

## Fences

Each app has a test, `src/lib/icon-fence.test.ts`, that fails on any new raw `ph-fill` class
string outside this package. New code renders `<Icon>`.

payer-web's existing `<i className="ph-fill ph-…">` call sites are listed in an allow-list with a
per-file count:

- The test fails if a count goes **up**.
- The test also fails if a count goes **down** without the list being lowered, so the list can
  only shrink.
- Every static name at those call sites must still be an `IconName`.

admin-web's allow-list is empty. Its fence also refuses a hand-drawn SVG **icon** — an inline
`<svg>` inside a button or link, with an icon class, on Phosphor's 256 grid, or glyph-sized on
every axis — while content SVG (charts, sparklines, logos) stays allowed; a genuine exception is
allow-listed with its reason.

payer-web's `icon-system.css.test.ts` also guards the cascade: it reads every glyph element's
classes with the TypeScript parser and fails on any single-class rule that would override
Phosphor's base metrics (including any `font` shorthand), and on any glyph element whose
className it cannot read (a variable, a call, a spread).
