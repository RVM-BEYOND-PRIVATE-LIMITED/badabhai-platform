/**
 * Every element that can take a Tab stop — enabled, and not opted out with `tabindex="-1"`. The ONE
 * list the DS Dialog's focus trap and the portal's nav drawer (app/(portal)/drawer-focus.ts) both
 * walk, so the two never disagree about what is reachable. Callers still drop what is not drawn.
 */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
