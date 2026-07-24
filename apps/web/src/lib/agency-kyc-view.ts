import type { AgencyKycRejectReason } from "./api";

/**
 * PURE view helpers for the ops Agency-KYC screen (ADR-0022 Amendment 2). No I/O,
 * no React, no secrets — just the deterministic display mapping (last-4 masking)
 * and the bounded reject-reason vocabulary the select renders. Unit-tested in
 * `agency-kyc-view.test.ts`.
 *
 * MASKED BY DESIGN: the only identifiers this surface ever shows are the last-4 of
 * PAN/bank the API already returns. There is no full PAN/bank anywhere on this path
 * — nothing here can un-mask one.
 */

/** The bounded reject-reason options, in the order the select renders them. */
export const REJECT_REASONS: ReadonlyArray<{
  code: AgencyKycRejectReason;
  label: string;
}> = [
  { code: "invalid_pan", label: "Invalid PAN" },
  { code: "invalid_bank", label: "Invalid bank details" },
  { code: "name_mismatch", label: "Name mismatch" },
  { code: "duplicate", label: "Duplicate submission" },
  { code: "other", label: "Other" },
];

/** The reason the reject select defaults to (first bounded option). */
export const DEFAULT_REJECT_REASON: AgencyKycRejectReason = "invalid_pan";

/** Human label for a reason code (falls back to the raw code if unknown). */
export function rejectReasonLabel(code: AgencyKycRejectReason): string {
  return REJECT_REASONS.find((r) => r.code === code)?.label ?? code;
}

/** Type guard: is `value` one of the bounded reject-reason codes? */
export function isRejectReason(value: unknown): value is AgencyKycRejectReason {
  return (
    typeof value === "string" &&
    REJECT_REASONS.some((r) => r.code === value)
  );
}

/**
 * Render a last-4 fragment as a masked token (e.g. `1234` → `••••1234`). Returns an
 * em-dash when the API returned no last-4. NEVER receives (and so never renders) a
 * full PAN/bank — the API does not expose one.
 */
export function maskLast4(last4: string | null): string {
  if (!last4) return "—";
  return `••••${last4}`;
}
