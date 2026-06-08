import { z } from "zod";
import { ActorType, SubjectType, Environment } from "./enums";

/** Shared primitive schemas used across the envelope. */
export const uuidSchema = z.string().uuid();
export const isoDateTimeSchema = z.string().datetime({ offset: true });

/**
 * Actor — who/what triggered the event.
 *
 * PRIVACY: never put raw PII here. `ip_hash` is a hash, not a raw IP. Names,
 * phone numbers, etc. must NEVER appear in an actor or anywhere in an event.
 */
export const ActorSchema = z.object({
  actor_type: ActorType,
  actor_id: uuidSchema.nullable().default(null),
  account_id: uuidSchema.nullable().default(null),
  ip_hash: z.string().min(1).max(128).nullable().default(null),
  user_agent: z.string().min(1).max(1024).nullable().default(null),
});
export type Actor = z.infer<typeof ActorSchema>;

/** Subject — the primary entity the event is about. */
export const SubjectSchema = z.object({
  subject_type: SubjectType,
  subject_id: uuidSchema.nullable().default(null),
});
export type Subject = z.infer<typeof SubjectSchema>;

/** Metadata — operational context for tracing and routing. */
export const MetadataSchema = z.object({
  environment: Environment,
  service: z.string().min(1).max(64),
  request_id: z.string().min(1).max(128).nullable().default(null),
  schema_version: z.string().min(1).max(32).default("1.0.0"),
});
export type EventMetadata = z.infer<typeof MetadataSchema>;

/**
 * Base envelope. `payload` is intentionally `unknown` here — it is validated in
 * a second pass against the per-event payload schema from the registry
 * (see `validateEvent`). This keeps the envelope reusable for every event name.
 */
export const EnvelopeBaseSchema = z.object({
  event_id: uuidSchema,
  event_name: z.string().min(1).max(128),
  event_version: z.number().int().positive(),
  occurred_at: isoDateTimeSchema,
  actor: ActorSchema,
  subject: SubjectSchema,
  /** The emitting service or source (e.g. "api", "ai-service"). */
  source: z.string().min(1).max(64),
  correlation_id: uuidSchema,
  causation_id: uuidSchema.nullable().default(null),
  payload: z.unknown(),
  metadata: MetadataSchema,
});
export type EnvelopeBase = z.infer<typeof EnvelopeBaseSchema>;
