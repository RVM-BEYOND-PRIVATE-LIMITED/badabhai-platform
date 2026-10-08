/**
 * BadaBhai Design System — shared primitive library (payer-web).
 *
 * The single import surface for every screen task (DS1.x–DS3.x). Components are typed
 * React wrappers over the `.bb-*` design-system classes (src/styles/ds-components.css)
 * + tokens; presentational only, prop contracts mirror the matching component contracts
 * under docs/design/BadaBhai Design System/components/. Interactive primitives carry
 * their own "use client" boundary at their module; the static ones are shared (RSC).
 */

/* ---- Forms (shared) ---- */
export {
  Button,
  Input,
  Select,
  Textarea,
  Checkbox,
  Radio,
  Switch,
  // The DS feedback-line id contract (`${controlId}-msg`, M3). Exported for the few refusals
  // that belong to a GROUP of controls rather than one DS field — the agency form's match-skill
  // picker (#2104) — so they describe themselves by the same id every DS field uses.
  fieldFeedbackId,
} from "./forms";
export type {
  ButtonProps,
  InputProps,
  SelectProps,
  TextareaProps,
  CheckboxProps,
  RadioProps,
  SwitchProps,
} from "./forms";

/* ---- Display (shared) ---- */
export { Card, Badge, StatTile, Avatar } from "./display";
export type { CardProps, BadgeProps, StatTileProps, AvatarProps } from "./display";

/* ---- Feedback (shared: Tooltip, ProgressBar) ---- */
export { Tooltip, ProgressBar } from "./feedback";
export type { TooltipProps, ProgressBarProps } from "./feedback";

/* ---- Brand (shared) ---- */
export { BadaBhaiLogo } from "./logo";
export type { BadaBhaiLogoProps } from "./logo";

/* ---- IconButton (shared skin over @badabhai/icons/button, which carries the client boundary) ---- */
export { IconButton } from "./icon-button";
export type { IconButtonProps } from "./icon-button";

/* ---- Interactive ("use client") ---- */
export { OtpInput } from "./otp-input";
export type { OtpInputProps } from "./otp-input";
export { SelectMenu } from "./select-menu";
export type { SelectMenuProps, SelectOption } from "./select-menu";
export { Chip } from "./chip";
export type { ChipProps } from "./chip";
export { Dialog } from "./dialog";
export type { DialogProps } from "./dialog";
export { Toast } from "./toast";
export type { ToastProps } from "./toast";
export { Tabs, tabId, tabPanelId } from "./tabs";
export type { TabsProps, TabItem } from "./tabs";
export { MaskedCandidate } from "./masked-candidate";
export type { MaskedCandidateProps } from "./masked-candidate";
export { ThemeToggle } from "./theme-toggle";
