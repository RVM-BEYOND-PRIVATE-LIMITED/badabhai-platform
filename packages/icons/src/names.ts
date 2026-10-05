/**
 * The Phosphor FILL glyph names the BadaBhai web portals may draw.
 *
 * A closed union, not `string`: a misspelt glyph used to render an EMPTY BOX silently (the
 * webfont has no fallback glyph and nothing type-checked the name). Every entry here is proven
 * to exist in the generated subset sheet (`phosphor-fill.subset.css`, built from the installed
 * `@phosphor-icons/web` fill sheet) by `names.test.ts`, so a name that compiles is a name that
 * renders.
 *
 * ADDING A GLYPH: add it here (keep the list sorted — the test enforces it), run
 * `pnpm --filter @badabhai/icons generate:subset`, and run this package's tests. Prefer an existing entry: one concept, one icon (see `ACTION_ICON`).
 *
 * FILL ONLY. The brand allows solid, rounded silhouettes and nothing thinner, so this package
 * loads the fill sheet alone; there is no weight parameter anywhere in the API.
 */
export const ICON_NAMES = [
  "arrow-clockwise",
  "arrow-counter-clockwise",
  "arrow-left",
  "arrow-line-left",
  "arrow-right",
  "arrow-square-out",
  "bank",
  "bookmark-simple",
  "briefcase",
  "buildings",
  "calendar-blank",
  "caret-double-left",
  "caret-double-right",
  "caret-down",
  "caret-left",
  "caret-right",
  "chart-donut",
  "chat-centered-text",
  "chat-circle-dots",
  "check",
  "check-circle",
  "clock",
  "clock-counter-clockwise",
  "compass",
  "copy",
  "crosshair",
  "currency-inr",
  "cursor-click",
  "dots-three-vertical",
  "download-simple",
  "envelope",
  "eye",
  "file-dashed",
  "flag",
  "floppy-disk",
  "funnel",
  "funnel-x",
  "gauge",
  "gear",
  "gift",
  "git-merge",
  "hand-coins",
  "handshake",
  "hourglass",
  "hourglass-medium",
  "identification-card",
  "info",
  "key",
  "lightning",
  "link",
  "link-break",
  "list",
  "list-bullets",
  "list-magnifying-glass",
  "lock-key",
  "lock-key-open",
  "magnifying-glass",
  "map-pin",
  "mask-happy",
  "medal",
  "minus",
  "monitor",
  "moon",
  "paper-plane-tilt",
  "path",
  "pause",
  "pause-circle",
  "pencil-simple",
  "phone",
  "play",
  "plus",
  "printer",
  "prohibit",
  "qr-code",
  "receipt",
  "robot",
  "rocket-launch",
  "rows",
  "seal-check",
  "share-network",
  "shield-check",
  "shopping-cart-simple",
  "sign-in",
  "sign-out",
  "sort-descending",
  "sparkle",
  "squares-four",
  "stack",
  "stack-plus",
  "sun",
  "tag",
  "trash",
  "tray",
  "trend-down",
  "trend-up",
  "upload-simple",
  "user",
  "user-gear",
  "user-minus",
  "user-plus",
  "user-switch",
  "users-three",
  "wallet",
  "warning",
  "warning-circle",
  "warning-octagon",
  "whatsapp-logo",
  "wrench",
  "x",
  "x-circle",
] as const;

/**
 * Glyphs still drawn by payer-web today that the product-wide mapping RETIRES (one concept,
 * one icon). They stay in the union so existing call sites keep compiling; the page-by-page
 * conversion PRs move each call site to its replacement and then delete the entry here.
 * `ACTION_ICON` may not use any of them (its type only admits {@link CanonicalIconName}).
 *
 *   coins             → `wallet` (credits / balance)
 *   paper-plane-right → `paper-plane-tilt` (send)
 *   plus-circle       → `plus` (create) or `stack-plus` (top up applicant quota)
 *   users             → `users-three` (people, plural)
 */
export const LEGACY_ICON_NAMES = ["coins", "paper-plane-right", "plus-circle", "users"] as const;

export type CanonicalIconName = (typeof ICON_NAMES)[number];
export type LegacyIconName = (typeof LEGACY_ICON_NAMES)[number];
/** Every glyph name the portals may render. A typo is a type error. */
export type IconName = CanonicalIconName | LegacyIconName;

/** Canonical then legacy — every name the union admits, for tests and tooling. */
export const ALL_ICON_NAMES: readonly IconName[] = [...ICON_NAMES, ...LEGACY_ICON_NAMES];
