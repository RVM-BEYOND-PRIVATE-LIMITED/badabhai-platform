import type { CanonicalIconName } from "./names";

/**
 * The product-wide ACTION → ICON map, shared by payer-web (Company + Agency) and admin-web.
 *
 * One concept, one icon, in both portals: a screen that offers "Edit" draws `ACTION_ICON.edit`
 * rather than choosing a glyph, so the same verb never wears two icons and one icon never means
 * two verbs (the audit found three icons for the credit balance and `plus-circle` meaning both
 * "Post a job" and "Top up quota"). Values are canonical names only — a retired glyph cannot be
 * mapped to an action.
 *
 * The table in this package's README.md mirrors this object; `actions.test.ts` keeps them equal.
 */
export const ACTION_ICON = {
  create: "plus",
  add: "plus",
  edit: "pencil-simple",
  delete: "trash",
  close: "x",
  dismiss: "x",
  approve: "check",
  reject: "x-circle",
  search: "magnifying-glass",
  filter: "funnel",
  clearFilters: "funnel-x",
  settings: "gear",
  view: "eye",
  download: "download-simple",
  upload: "upload-simple",
  back: "arrow-left",
  next: "arrow-right",
  more: "dots-three-vertical",
  calendar: "calendar-blank",
  location: "map-pin",
  users: "users-three",
  candidate: "user",
  applicant: "user",
  posting: "briefcase",
  credits: "wallet",
  unlock: "lock-key-open",
  topUpQuota: "stack-plus",
  send: "paper-plane-tilt",
  retry: "arrow-clockwise",
  copy: "copy",
  whatsapp: "whatsapp-logo",
  call: "phone",
  publish: "rocket-launch",
  timeline: "clock-counter-clockwise",
  external: "arrow-square-out",
  suspend: "prohibit",
  reinstate: "arrow-counter-clockwise",
  disclosure: "caret-down",
} as const satisfies Record<string, CanonicalIconName>;

/** A product action that has an assigned icon. */
export type ProductAction = keyof typeof ACTION_ICON;
