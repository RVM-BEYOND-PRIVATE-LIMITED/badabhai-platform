import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";

/**
 * Request DTOs carry NO worker_id: the acting worker is taken from the
 * authenticated session (WorkerAuthGuard), never trusted from the body. The
 * service-layer input types (which DO carry worker_id) are separate, because
 * ChatService auto-triggers extraction service-to-service.
 */
export const ExtractProfileSchema = z.object({
  session_id: uuidSchema.optional(),
});
export type ExtractProfileDto = z.infer<typeof ExtractProfileSchema>;

export const ConfirmProfileSchema = z.object({
  profile_id: uuidSchema,
});
export type ConfirmProfileDto = z.infer<typeof ConfirmProfileSchema>;

/** Service-layer inputs (worker_id supplied by the caller, not the client body). */
export interface ExtractProfileInput {
  worker_id: string;
  session_id?: string | null;
}
export interface ConfirmProfileInput {
  worker_id: string;
  profile_id: string;
}
