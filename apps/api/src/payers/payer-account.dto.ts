import { z } from "zod";
import { e164PhoneSchema } from "@badabhai/validators";

/**
 * Wire contract for the payer-authenticated SELF read (ADR-0019 LC-1, slice 1; PROF-1).
 *
 * This is the backend shape behind `GET /payer/me`. It is the payer's view of their OWN
 * account, returned ONLY over their own authenticated session. `orgName`, `email`, and the
 * masked `phoneLast4` are the payer's own contact data (server→client to themselves) — which
 * is acceptable here BUT must never be eventized or logged (invariant #2 / B-R2: `payer_id`
 * is the only token in events/logs). The phone is returned MASKED (last 4 only); the raw
 * E.164 number is never sent. Sourced by decrypting the `payers` ciphertext columns inside
 * the self-scoped service — never on a list/admin path.
 *
 * Mirrors the `apps/payer-web` `payerMeWireSchema` (Zod↔Zod parity).
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
  /** The payer's OWN login email — returned only to themselves; never logged/eventized. */
  email: z.string().email(),
  /** Last 4 digits of the payer's OWN contact phone (masked), or null if none is set. */
  phoneLast4: z.string().length(4).nullable(),
  /**
   * #2079 — the caller's org id (ADR-0027 / B5), resolved from their CURRENT active
   * `payer_members` row on every read. `null` when they have no active membership.
   */
  orgId: z.string().uuid().nullable(),
  /**
   * #2079 — the caller's CURRENT org role (`owner` | `recruiter`), read from the DB on every
   * request (never from the token, never client-supplied), so a demotion/removal shows up on
   * the very next read. `null` = no active membership → readers MUST treat it as least
   * privilege. A label for UI affordances; the server enforces owner-only routes itself
   * (`PayerOrgRoleGuard`). ADDITIVE: older clients ignore it.
   */
  orgRole: z.enum(["owner", "recruiter"]).nullable(),
});
export type PayerMeDto = z.infer<typeof PayerMeSchema>;

/**
 * Wire contract for the payer-authenticated SELF EDIT (PROF-3) behind `PATCH /payer/me`.
 *
 * A payer may edit ONLY their OWN org display name and/or contact phone. The login
 * identity (`email`), `role`, and `status` are IMMUTABLE here — they are not fields on
 * this schema, and `.strict()` rejects them (and any other unknown key, e.g. a body
 * `payer_id`) with a 400. The authenticated id is ALWAYS the guard principal, never the
 * body, so there is nothing here an attacker can vary to reach another payer's account.
 *
 * Both fields are optional (partial update), BUT an EMPTY patch (neither field) is a 400
 * via the `.refine` below — "nothing to update" is the documented choice (no silent no-op).
 *
 * PRIVACY: these are the raw B-R2 contact PII (org-name / phone) — accepted here, encrypted
 * at rest in `payers`, and NEVER echoed into an event or a log (invariant #2 / B-R2).
 */
export const PayerUpdateSchema = z
  .object({
    /**
     * Org display label, 2..120 by GRAPHEME/code-point count (`[...trim()].length`, NOT
     * `.length`) so emoji / surrogate pairs are counted as a single unit.
     */
    orgName: z
      .string()
      .transform((v) => v.trim())
      .refine((v) => [...v].length >= 2 && [...v].length <= 120, {
        message: "orgName must be 2 to 120 characters",
      })
      .optional(),
    /** Contact phone — strict E.164 (reuses the shared `@badabhai/validators` schema). */
    phone: e164PhoneSchema.optional(),
  })
  .strict()
  .refine((body) => body.orgName !== undefined || body.phone !== undefined, {
    message: "nothing to update",
  });
export type PayerUpdateDto = z.infer<typeof PayerUpdateSchema>;
