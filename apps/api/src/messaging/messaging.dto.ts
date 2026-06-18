import { z } from "zod";

/** Create a referral invite (the inviter is the authenticated worker). */
export const CreateInviteSchema = z.object({
  campaign: z.string().min(1).max(64).optional(),
});
export type CreateInviteDto = z.infer<typeof CreateInviteSchema>;

/** Ops/system trigger for a re-engagement send. PII-free input (opaque worker id). */
export const ReengageSchema = z.object({
  worker_id: z.string().uuid(),
  template: z.string().min(1).max(64),
});
export type ReengageDto = z.infer<typeof ReengageSchema>;
