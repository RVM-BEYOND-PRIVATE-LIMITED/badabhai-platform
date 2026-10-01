/**
 * @badabhai/icons — the ONE icon system for the BadaBhai web portals.
 *
 * Styles: import `@badabhai/icons/icons.css` once per app (each app's `globals.css` does), which
 * self-hosts the Phosphor FILL font from the app's own origin and declares the icon size tokens.
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
  dismissTooltipOnEscape,
  restoreTooltip,
  warnIfUnlabelled,
} from "./control";
export type { IconOnlyControlProps, TooltipPlacement } from "./control";
