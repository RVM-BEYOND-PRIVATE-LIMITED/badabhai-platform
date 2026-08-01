import { z } from "zod";

/** Create a referral invite (the inviter is the authenticated worker). */
export const CreateInviteSchema = z.object({
  campaign: z.string().min(1).max(64).optional(),
});
export type CreateInviteDto = z.infer<typeof CreateInviteSchema>;

/**
 * Route param `:code` for the PUBLIC click endpoint. Both funnels mint the SAME shape
 * (`randomUUID().replace(/-/g,"").slice(0,12)` — 12 lowercase hex), so one bounded schema
 * covers the worker→worker `invites` and the agency `agency_invites` code spaces.
 *
 * NO-ORACLE: this validates the SHAPE only. A well-formed code that exists and a
 * well-formed code that does not both get the identical neutral 200 — the shape check
 * never distinguishes them, it only stops arbitrary strings reaching the DB on an
 * unauthenticated route.
 */
export const InviteCodeParamSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{12}$/, "invalid invite code"),
});
export type InviteCodeParam = z.infer<typeof InviteCodeParamSchema>;

/** Ops/system trigger for a re-engagement send. PII-free input (opaque worker id). */
export const ReengageSchema = z.object({
  worker_id: z.string().uuid(),
  template: z.string().min(1).max(64),
});
export type ReengageDto = z.infer<typeof ReengageSchema>;
