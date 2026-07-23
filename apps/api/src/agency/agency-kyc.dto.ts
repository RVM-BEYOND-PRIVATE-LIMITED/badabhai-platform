import { z } from "zod";

/**
 * Agency KYC submission (ADR-0022 module 1, Amendment 2) — HIGH-SENSITIVITY FINANCIAL PII.
 *
 * These raw values are encrypted at rest immediately (ADR-0004 discipline, `PiiCryptoService`)
 * and NEVER echoed back, evented, or logged — the API only ever returns masked last-4. The
 * schemas format-validate the Indian PAN / bank-account / IFSC shapes so an obviously-bad
 * value is rejected before it is stored (the ops "verify" step is a mock human ack, NOT a
 * real registry check — real verification is the legal/§7 launch gate).
 */

/** Indian PAN: 5 letters + 4 digits + 1 letter (e.g. ABCDE1234F). Uppercased on ingest. */
const panSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "invalid PAN"));

/** Bank account number: 9–18 digits (covers Indian bank account lengths). */
const bankAccountSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{9,18}$/, "invalid bank account number");

/** IFSC: 4 letters + '0' + 6 alphanumerics (e.g. HDFC0001234). Uppercased on ingest. */
const ifscSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "invalid IFSC"));

export const SubmitAgencyKycSchema = z.object({
  pan: panSchema,
  bank_account: bankAccountSchema,
  ifsc: ifscSchema,
  account_holder_name: z.string().trim().min(2).max(120),
});
export type SubmitAgencyKycDto = z.infer<typeof SubmitAgencyKycSchema>;
