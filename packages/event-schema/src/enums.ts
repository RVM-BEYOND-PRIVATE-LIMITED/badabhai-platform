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
  // Ops-created job postings (ADR-0012): vacancy-banded, stored-only. Created/
  // updated/closed by ops; PII-FREE (ids/enums/booleans/key-arrays only — never
  // org/role/location/description free text).
  "job_posting",
  // Contact Unlock + Reveal (ADR-0010, Stream A) — the routed-disclosure monetization
  // spine. PII-FREE by construction: ids + enums + counts ONLY. The revealed contact /
  // proxy number / relay destination NEVER appears in any payload (CLAUDE.md invariant 2,
  // ADR-0010 §6.2 / Phase-0 F-5). `payment` is the MOCK credit ledger in alpha
  // (real_call:false on every event); a real gateway is a later human-gated stream.
  "unlock",
  "contact",
  "payment",
  // Config-driven Pricing Engine (ADR-0013) — catalog/coupon changes + redemptions.
  // PII-FREE: product/tier/coupon CODES + integer ₹ amounts + percentages ONLY; never
  // a payer name, a worker identity, or old/new VALUES (field KEYS only on changes).
  "pricing",
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
  // An ops-created job posting (ADR-0012). The subject_id is the job_postings row
  // id — carries no PII (org/role/location/description never appear in events).
  "job_posting",
  // A routed-contact unlock grant (ADR-0010). The subject_id is the opaque unlock_id;
  // it carries NO PII (the only identity join is worker_id, inside the payload).
  "unlock",
  // A pricing catalog entity (ADR-0013) — a plan/discount/coupon row. The subject_id
  // is the opaque catalog row id; carries no PII (codes + amounts only).
  "pricing_plan",
] as const;
export const SubjectType = z.enum(SUBJECT_TYPES);
export type SubjectType = z.infer<typeof SubjectType>;

/** Deployment environment, carried in event metadata. */
export const ENVIRONMENTS = ["development", "test", "staging", "production"] as const;
export const Environment = z.enum(ENVIRONMENTS);
export type Environment = z.infer<typeof Environment>;
