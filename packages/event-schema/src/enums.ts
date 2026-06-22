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
  // Per-payer hiring capacity (ADR-0016) — the payer's concurrent-active-vacancy
  // ALLOWANCE purchase. PII-FREE & faceless: opaque payer_id + tier CODE + integer
  // ₹/counts ONLY (`real_call:false` in alpha — mock payments). Distinct from
  // `pricing` (catalog edits) — this is the entitlement-GRANT money movement.
  "capacity",
  // Posting-plan LIFECYCLE transitions (ADR-0016 D3) — a plan moved paused↔active as
  // the payer's capacity is exceeded/restored. DISTINCT from `job_posting.*` (posting
  // content/purchase): this domain is the plan's serving-state machine. PII-FREE:
  // ids + an enum reason ONLY.
  "posting_plan",
  // WhatsApp invite funnel (ADR-0020) — referral deep-link create/click/accept +
  // PII-FREE attribution. ids/enums ONLY (opaque invite_id + worker ids); never a
  // phone, name, or the shared link's downstream PII.
  "invite",
  // Worker re-engagement messaging (ADR-0020) — the consent-gated send lifecycle
  // (requested/sent/suppressed/failed) over the WhatsApp provider. PII-FREE: the
  // phone/template-body NEVER appears; only ids + the template id + enums +
  // real_call. Mock provider in alpha (real_call:false).
  "messaging",
  // PACE supply-widening (ADR-0021) — deterministic supply-widening waves + ops
  // alert (the "release waves" slice of ADR-0011's PACE triad). PII-FREE & faceless:
  // opaque job_id + the widen-stage enum + supply COUNT + elapsed hours ONLY; never
  // a worker, employer, or location. No LLM on this path (invariant 4).
  "pace",
  // Self-serve payer account auth (ADR-0019 Decision B — closes R16/LC-1/TD33). The
  // payer signup/login/session lifecycle behind PayerAuthGuard. PII-FREE & FACELESS:
  // the payer's email/phone/org-name NEVER appears (those are the new B-R2 PII class,
  // stored ONLY in `payers`, encrypted) — only the opaque `payer_id` + role + the
  // login-method enum + booleans. Mirrors `worker.*` auth events for the payer principal.
  "payer",
  // The `jobs` ENTITY lifecycle (ADR-0022 Agency Supply Portal demand slice) — DISTINCT
  // from `job_posting` (ADR-0012, the ops vacancy register, a different entity). The
  // faceless demand row create/update/close, owned by `jobs.payer_id`. PII-FREE: opaque
  // ids + coarse non-PII bands (trade slug / city / pay / experience) ONLY; never an
  // employer name, address, or worker identity.
  "job",
  // AGENCY supply-attribution funnel (ADR-0022) — the payer-axis sibling of `invite.*`
  // (the worker→worker funnel). PII-FREE: opaque agency_invite_id + opaque payer/worker
  // ids + the channel enum + an optional non-PII campaign tag ONLY; never a phone, name,
  // email, or message body. `agency_invite.accepted` is emitted ONLY after consent (#6).
  "agency_invite",
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
  // A paid posting PLAN row (ADR-0016) — the subject of `posting_plan.paused/resumed`.
  // The subject_id is the opaque posting_plans row id; carries no PII (the job_posting
  // and payer ids live in the payload, both opaque/faceless).
  "posting_plan",
  // A referral invite (ADR-0020). The subject_id is the opaque invites row id; carries
  // no PII (inviter/invited worker ids live in the payload, both opaque).
  "invite",
  // A self-serve payer account (ADR-0019 Decision B). The subject_id is the opaque
  // `payers.id` (== the faceless `payer_id`); carries NO PII (the payer's email/phone/
  // org-name live ONLY in `payers`, encrypted — never in an event). The subject of the
  // `payer.*` auth lifecycle events.
  "payer",
  // An agency referral invite (ADR-0022). The subject_id is the opaque `agency_invites`
  // row id; carries NO PII (inviter payer + invited worker ids live in the payload, both
  // opaque). The subject of the `agency_invite.*` funnel events. (The `job` subject above
  // already serves the `job.*` lifecycle events — no new subject is needed for those.)
  "agency_invite",
] as const;
export const SubjectType = z.enum(SUBJECT_TYPES);
export type SubjectType = z.infer<typeof SubjectType>;

/** Deployment environment, carried in event metadata. */
export const ENVIRONMENTS = ["development", "test", "staging", "production"] as const;
export const Environment = z.enum(ENVIRONMENTS);
export type Environment = z.infer<typeof Environment>;
