import { z } from "zod";

/**
 * Wire contract for the payer-authenticated SELF read (ADR-0019 LC-1, slice 1).
 *
 * This is the backend shape behind `GET /payer/me`. It is the payer's view of
 * their OWN account, returned over their authenticated session — `orgName` is the
 * payer's own org label (their own data, server→client), which is acceptable here
 * BUT must never be eventized or logged (invariant #2 / B-R2: `payer_id` is the
 * only token in events/logs). Login email and phone are deliberately OMITTED — the
 * portal header only needs id/role/org/status.
 *
 * Mirrors the `apps/payer-web` PayerSession seam (payerId + role + a display
 * label), so the portal can swap its mock `currentSession()` onto this endpoint.
 */
export const PayerMeSchema = z.object({
  /** The opaque payer id — the ONLY tenant token used elsewhere (events/logs). */
  id: z.string().uuid(),
  /** `employer` (company) | `agent` (agency) — mirrors db `PayerRole`. */
  role: z.enum(["employer", "agent"]),
  /** Account lifecycle — mirrors db `PayerStatus`. */
  status: z.enum(["pending", "active", "suspended"]),
  /** The payer's own org display label. Their own data; never logged/eventized. */
  orgName: z.string(),
});
export type PayerMeDto = z.infer<typeof PayerMeSchema>;
