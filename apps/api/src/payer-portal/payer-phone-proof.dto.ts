import { z } from "zod";

/**
 * #2754 item 3 — the wire contract of a company PROVING the phone on its account.
 *
 *   POST /payer/me/phone-proof         (no body)    → {@link PayerPhoneProofCodeResponse}
 *   POST /payer/me/phone-proof/verify  `{ code }`   → {@link PayerPhoneProofVerifiedResponse}
 *
 * The code goes by SMS to the account's CURRENT stored phone; nothing on the wire names the
 * number. Both routes are the signed-in company's own (`PayerAuthGuard`), and 404 while
 * `PAYER_SMS_OTP_ENABLED` is off.
 */
export const PayerPhoneProofVerifySchema = z
  .object({
    /** The one-time code the SMS carried (the same 4–8 digits as a sign-in code). */
    code: z.string().regex(/^\d{4,8}$/, "Code must be 4-8 digits"),
  })
  .strict();
export type PayerPhoneProofVerifyDto = z.infer<typeof PayerPhoneProofVerifySchema>;

/** A code is on its way to the account's phone. */
export interface PayerPhoneProofCodeResponse {
  status: "code_sent";
  resend_in_seconds: number;
}

/** The account's current phone is proven: from now on it signs this company in by SMS code. */
export interface PayerPhoneProofVerifiedResponse {
  status: "proven";
}

/**
 * The machine-readable `reason` on a proof route's 409. A wire contract a client branches on:
 * add a value, never rename one.
 */
export const PHONE_PROOF_CONFLICT_REASONS = {
  /** The account has no phone to prove; add one with `PATCH /payer/me` first. */
  noPhone: "no_phone_on_account",
  /** The stored phone is not an Indian mobile (+91, 10 digits from 6–9): SMS cannot prove it. */
  notProvable: "phone_not_provable",
  /** The phone changed between the code and its verify; request a new code. */
  phoneChanged: "phone_changed",
  /**
   * ANOTHER account already holds the proof of this phone. Said only on VERIFY, after the caller
   * has just proved they hold the phone, so it is no oracle; the placement team moves it by hand.
   */
  heldElsewhere: "phone_linked_to_another_account",
} as const;
export type PhoneProofConflictReason =
  (typeof PHONE_PROOF_CONFLICT_REASONS)[keyof typeof PHONE_PROOF_CONFLICT_REASONS];
