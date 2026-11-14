import type { PayerProfileVerificationStatus, PayerRole } from "@badabhai/db";

/**
 * #2746 PR 6 — WHO MAY ASK FOR A CAMPUS DRIVE: only a VERIFIED employer (the issue's default,
 * brief section 7: "admin approval plus a GST number or a phone-verified owner").
 *
 * WHAT EACH PART MEANS IN THIS CODEBASE, read against the company record (`employer_profiles`,
 * 1:1 with the company's tenant key — owner ruling D4, #2564):
 *
 *   - ADMIN APPROVAL = `employer_profiles.verification_status = 'verified'`. The admin Companies
 *     surface (`PATCH /admin/companies/:id`, `manage_companies`, audited and evented) is its only
 *     writer; no company can set it. No row, or any other status, is not approved.
 *   - GST ON FILE = `employer_profiles.gst_number_enc IS NOT NULL`. Written only by the same admin
 *     surface, after `GstinSchema` validated it.
 *   - PHONE-VERIFIED OWNER has NO meaning in code today, so it is NOT an alternative here (STOPPED,
 *     pending an owner decision; the options are in the PR report). `payers.status = 'active'`
 *     means one OTP was verified on the configured channel (`PAYER_LOGIN_METHOD`, default
 *     `email_otp`), and nothing records which channel or which contact; an admin-created login is
 *     active with no OTP at all; and `PATCH /payer/me` changes the phone with no verification.
 *
 * So, until that decision: VERIFIED = ADMIN APPROVAL AND GST ON FILE. That is the issue's rule
 * with its second alternative missing, which can only REFUSE a company the full rule would admit
 * (fail closed), never admit one it would refuse.
 *
 * The record is read for the TENANT key (ADR-0053: the company is the org, keyed by its anchor).
 * With `PAYER_ORG_TENANCY_MODE=on` a team member is judged by the company's record. In `off` /
 * `shadow` every login is its own tenant, so only a login that IS a company record (its founder)
 * can qualify, the same caveat the pilot list carries.
 */

/** The facts the rule reads, from one query (`CampusDriveRequestsRepository.requesterFacts`). */
export interface DriveRequesterFacts {
  /** `payers.role` of the tenant; `null` when there is no such row. */
  role: PayerRole | null;
  /** `employer_profiles.verification_status`; `null` when the company has no record. */
  verificationStatus: PayerProfileVerificationStatus | null;
  hasGstNumber: boolean;
}

/** The parts of "verified" a company can be missing, in the order the company app lists them. */
export const DRIVE_REQUESTER_REQUIREMENTS = ["admin_approval", "gst_number"] as const;
export type DriveRequesterRequirement = (typeof DRIVE_REQUESTER_REQUIREMENTS)[number];

/** The machine-readable `reason` on the 403 an unverified company gets. */
export const DRIVE_REQUESTER_NOT_VERIFIED = "company_not_verified" as const;

export type DriveRequesterStanding =
  | { eligible: true }
  | { eligible: false; missing: DriveRequesterRequirement[] };

/** Is this company a verified employer? Pure: the facts are read by the repository. */
export function driveRequesterStanding(facts: DriveRequesterFacts): DriveRequesterStanding {
  const missing: DriveRequesterRequirement[] = [];
  if (facts.verificationStatus !== "verified") missing.push("admin_approval");
  if (!facts.hasGstNumber) missing.push("gst_number");
  return missing.length === 0 ? { eligible: true } : { eligible: false, missing };
}
