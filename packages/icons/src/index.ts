/**
 * @badabhai/icons — the ONE icon system for the BadaBhai web portals.
 *
 * Styles: import `@badabhai/icons/icons.css` once per app (each app's `globals.css` does), which
 * self-hosts the Phosphor FILL font from the app's own origin and declares the icon size tokens
 * and the shared icon-button tooltip.
 * See README.md for the rules (icon + text for key actions; icon-only needs a label + tooltip;
 * no glyph or emoji characters as icons).
 */
export { ICON_NAMES, LEGACY_ICON_NAMES, ALL_ICON_NAMES } from "./names";
export type { IconName, CanonicalIconName, LegacyIconName } from "./names";
export { Icon } from "./icon";
export type { IconProps, IconSize } from "./icon";
export { ACTION_ICON } from "./actions";
export type { ProductAction } from "./actions";
export {
  TOOLTIP_DISMISSED_ATTRIBUTE,
  TOOLTIP_PLACEMENTS,
  dismissTooltipOnEscape,
  focusWithoutTooltip,
  restoreTooltip,
  warnIfUnlabelled,
  watchEscapeWhileHovered,
} from "./control";
export type {
  FocusArrivalTarget,
  HoverEscapeTarget,
  IconOnlyControlProps,
  TooltipPlacement,
} from "./control";
// The icon-only button itself is a CLIENT module, so it has its own entry point and is NOT
// re-exported here (this index stays importable from Server Components) — with the hook it is
// built on, for a control that keeps its own markup around the shared tooltip:
//   import { IconButtonBase, useIconTipHandlers } from "@badabhai/icons/button";
