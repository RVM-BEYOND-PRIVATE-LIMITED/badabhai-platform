import { z } from "zod";

/**
 * Event domains group event names by the part of the system they belong to.
 * The domain is always the prefix of an event name (e.g. `worker.created`).
 */
export const EVENT_DOMAINS = [
  "worker",
  "consent",
  "chat",
  "voice_note",
  "profile",
  "resume",
  // Per-trade interview preparation kit (TD24, Task 4). Deterministic, render-once,
  // PII-FREE (kits are per-trade, never per-worker).
  "interview_kit",
  "action",
  "ai",
  // Reach foundation (ADR-0005, TD8): the worker-side behavioural record the
  // matching/LEARN layer reads. Defined now; emitted when the Phase-2 feed surface
  // ships. PII-free (worker_id + opaque job_id + signals only).
  "feed",
  "application",
  // Phase-2 Job entity lifecycle (the `posting_fee` billable object). Posted by an
  // opaque payer; payloads carry ids/slugs/counts only — never payer identity or
  // the free-text job title.
  "job",
] as const;
export const EventDomain = z.enum(EVENT_DOMAINS);
export type EventDomain = z.infer<typeof EventDomain>;

/**
 * Who/what triggered the event.
 * - worker: a blue/grey-collar candidate using the worker app
 * - payer: an employer/staffing customer (Phase 2+)
 * - agent: a sourcing agent (Phase 2+)
 * - ops: internal BadaBhai operator
 * - system: automated background process
 * - ai_service: the FastAPI AI service
 */
export const ACTOR_TYPES = ["worker", "payer", "agent", "ops", "system", "ai_service"] as const;
export const ActorType = z.enum(ACTOR_TYPES);
export type ActorType = z.infer<typeof ActorType>;

/** The primary entity an event is about. */
export const SUBJECT_TYPES = [
  "worker",
  "consent",
  "chat_session",
  "chat_message",
  "voice_note",
  "profile",
  "resume",
  // A per-trade interview kit. The subject_id is the deterministic kit id
  // (`{tradeKey}:v{contentVersion}`), NOT a worker — kits carry no PII.
  "interview_kit",
  "ai_job",
  // A job/opening the worker is shown / applies to / skips (Reach foundation). The
  // job entity itself is Phase-2; the id is an opaque reference here.
  "job",
] as const;
export const SubjectType = z.enum(SUBJECT_TYPES);
export type SubjectType = z.infer<typeof SubjectType>;

/** Deployment environment, carried in event metadata. */
export const ENVIRONMENTS = ["development", "test", "staging", "production"] as const;
export const Environment = z.enum(ENVIRONMENTS);
export type Environment = z.infer<typeof Environment>;
