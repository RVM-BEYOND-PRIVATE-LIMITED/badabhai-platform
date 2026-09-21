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

/**
 * Task 1 B4 (ADR-0042 D8) — where the app goes after confirming, decided by the profile's
 * `source` (the road), never by the client's "does a form exist?" probe.
 *
 *  - `trade_form`    — the form road: open the trade form (its own 404 fallback still applies).
 *  - `chat_complete` — the chat road: go straight to resume building; NEVER the form.
 *  - `null`          — the road is unknown (a profile written before migration 0107): the
 *                      client keeps its own probe, which is exactly today's behaviour.
 */
export type ProfileConfirmNext = "trade_form" | "chat_complete";
