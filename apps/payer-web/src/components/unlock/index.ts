/**
 * Shared unlock→reveal UX (DS1.5) — the ONE implementation of the contact unlock + reveal
 * surfaces, used by the applicant feed and any future payer surface. Re-skinned onto the DS
 * primitives; faceless + no-oracle by construction (ADR-0010 F-4 / XB-C). Import these from
 * this barrel — never the component internals.
 */
export { RoutedContactCard, MaskedResumeCard } from "./routed-contact-card";
export { ConfirmSpendDialog } from "./confirm-spend-dialog";
export type { ConfirmSpendDialogProps } from "./confirm-spend-dialog";
export { UnlockResultToast, UNLOCK_SUCCESS_TITLE } from "./unlock-result-toast";
export type { UnlockResultToastProps, UnlockResultKind } from "./unlock-result-toast";
