/**
 * @badabhai/types — shared domain enums and types.
 *
 * Framework-agnostic and dependency-free on purpose: anything (Nest, Next,
 * Drizzle, tests) can import these without pulling in zod or other runtime deps.
 * Runtime validation lives in @badabhai/validators; event contracts live in
 * @badabhai/event-schema.
 */

// ---- Worker lifecycle ----
export const WORKER_STATUSES = ["pending", "active", "suspended"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

// ---- Profile lifecycle ----
export const PROFILE_STATUSES = ["draft", "extracting", "extracted", "confirmed"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

// ---- Consent ----
export const CONSENT_PURPOSES = [
  "profiling",
  "resume_generation",
  "communication",
  // Lawful basis for the in-house model track. Captured from day one on purpose:
  // adding it later would require re-consenting every existing worker (plan J1).
  "model_training",
  // Phase-2 Contact Unlock + Reveal (ADR-0010 §D3). A SEPARATE, explicit DPDP
  // disclosure purpose: it gates whether a worker's routed contact may be disclosed
  // to a paying party. It is DISTINCT from `profiling` — a worker may have profiling
  // consent but NOT this, and is then undiscoverable for unlock (neutral "unavailable").
  // The fail-closed gate keys on this exact string. Production DPDP notice copy +
  // lawful-basis wording remain a human/legal launch gate (CLAUDE.md §8).
  "employer_sharing",
  // Phase-2 WhatsApp invite funnel + re-engagement (ADR-0020). A SEPARATE, explicit
  // DPDP basis for messaging a worker over WhatsApp — the worker's phone leaves to a
  // third party (Meta), so this is DISTINCT from transactional `communication` (OTP).
  // A worker may have `communication` but NOT this, and is then never messaged
  // (fail-closed `MessagingConsentService`; recorded as `messaging.suppressed`).
  // Production WhatsApp opt-in / DPDP copy remains a human/legal launch gate.
  "whatsapp_messaging",
  // B5 — the referring AGENT/agency may see this worker's ACTIVITY (ADR-0022 portal).
  // A SEPARATE, explicit DPDP basis, and the narrowest one here: it authorises an
  // ENGAGEMENT view only — profile completeness, how many jobs he applied to, how many
  // times he was unlocked, when he was last active. It never authorises a name, a
  // phone, WHICH job, or WHICH employer, and it is DISTINCT from `employer_sharing`
  // (that discloses routed CONTACT to a paying party; this discloses nothing
  // contactable to anyone).
  //
  // WHY IT IS ITS OWN PURPOSE. The agent who referred a worker is not the worker's
  // employer and has no disclosure relationship with him — he was invited, often by
  // someone he knows. "Somebody who sent you a link can watch what you do on the app"
  // is exactly the kind of thing a person would want to be asked about separately, so
  // it is asked separately. The projection FAILS CLOSED on consents that do not carry
  // this string, which is why a version bump accompanies it: workers who consented
  // under 2026-06-01 never saw this sentence and are therefore never included.
  "agent_activity_visibility",
  // V9 — the voice profiling form records the worker's ANSWERS AS AUDIO and sends them to a
  // third-party ASR processor (Sarvam). A SEPARATE, explicit DPDP basis, and the reason it is
  // not folded into `profiling` is the same reason `whatsapp_messaging` is not folded into
  // `communication`: consenting to be profiled is consenting to ANSWER QUESTIONS, not to be
  // RECORDED. A worker's voice is biometric-adjacent, the recording leaves the platform to a
  // processor the worker has no relationship with, and under the 2026-08-07 owner ruling the
  // clip is retained INDEFINITELY (`retain_indefinitely`) rather than deleted after processing.
  // Each of those three is a thing a person would expect to be asked about on its own.
  //
  // FAIL-CLOSED AT THE AUDIO CHOKEPOINT, not at the interview. The voice form's `POST /answer`
  // carries BOTH spoken and typed answers, so gating the interview would deny the typed form to
  // a worker who simply declined recording — the opposite of what declining should mean. The
  // gate therefore sits on `VoiceController`'s three PROCESSING routes (mint upload URL, register
  // upload, enqueue transcription), which is the only way a clip can come into existence.
  //
  // No client requests this purpose yet, so the routes are closed to every worker until the DPDP
  // notice copy ships and workers actually opt in — the same dormant posture `employer_sharing`,
  // `whatsapp_messaging` and `agent_activity_visibility` already hold.
  "voice_processing",
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/**
 * The consent NOTICE version a client presents.
 *
 * DELIBERATELY NOT BUMPED for B5's `agent_activity_visibility` purpose (2026-07-31).
 * A version identifies the NOTICE TEXT a worker was actually shown, and that text has
 * not changed: the worker app still renders the 2026-06-01 screen, and the real DPDP
 * notice copy is outstanding owner/legal work. Bumping the version while the app shows
 * the old words would record, on every consent row, a claim about what the worker read
 * that is simply false — which is worse than the gap it would paper over.
 *
 * What makes B5 safe is the PURPOSE, not the version: the agency projection fails
 * closed on consents that do not carry `agent_activity_visibility`, and no client
 * requests that purpose yet. So the projection is empty until the notice ships and
 * workers actually opt in — the same posture `employer_sharing` and
 * `whatsapp_messaging` already hold.
 *
 * Bump this when the NOTICE COPY changes, together with the client that renders it.
 */
export const CURRENT_CONSENT_VERSION = "2026-06-01" as const;

// ---- Chat ----
/**
 * `active` → running. `ended` → the worker finished the interview. `abandoned` → they
 * stopped answering and the idle sweep closed the session on their behalf.
 *
 * WHY `abandoned` IS ITS OWN VALUE rather than `ended` + a reason in
 * `conversation_state`. "What share of workers finish the interview?" is a funnel
 * question the product asks constantly, and it has to be answerable by a column filter
 * over a plain index — not a JSONB probe. Conflating the two would also make every
 * completion metric silently count drop-offs as successes.
 *
 * ADDITIVE AND MIGRATION-FREE: `chat_sessions.status` is plain `text` with no CHECK, and
 * every existing reader either compares against `"active"` or treats anything else as
 * over (`ChatService.postMessage` → `session_over`). A pre-existing row can never hold
 * this value, so no backfill.
 */
export const CHAT_SESSION_STATUSES = ["active", "ended", "abandoned"] as const;
export type ChatSessionStatus = (typeof CHAT_SESSION_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_TYPES = ["text", "voice", "system"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

// ---- Voice notes ----
export const VOICE_RETENTION_POLICIES = ["retain_indefinitely", "delete_after_processing"] as const;
export type VoiceRetentionPolicy = (typeof VOICE_RETENTION_POLICIES)[number];

// Tiers for the indefinitely-retained voice/transcript corpus (plan J2):
// hot (active), archive (cheap cold object storage), physical (offline/archival).
export const STORAGE_CLASSES = ["hot", "archive", "physical"] as const;
export type StorageClass = (typeof STORAGE_CLASSES)[number];

/** Hard limit for Phase 1 voice notes (seconds). Mirrored in event-schema/validators. */
export const MAX_VOICE_NOTE_SECONDS = 120;

/**
 * Hard limit for ONE ANSWER in the voice profiling form (seconds).
 *
 * Deliberately far below `MAX_VOICE_NOTE_SECONDS`, and the gap is load-bearing rather than
 * conservative: at or under 30s the Sarvam adapter takes its single synchronous call and never
 * enters the chunked path, which removes the multi-minute latency ceiling, the multi-chunk cost
 * reservation, and the chunk-seam redaction gap in one stroke. Raising this past the chunker's
 * threshold silently changes all three.
 *
 * `MAX_VOICE_NOTE_SECONDS` is unchanged and stays the contract limit for chat voice notes.
 */
export const MAX_PROFILING_ANSWER_SECONDS = 30;

// ---- Voice profiling form (the sequential Q&A surface) ----

/**
 * What happened to one recorded answer clip, from the CLIENT's point of view.
 *
 * Separate from `transcript_status` on purpose. "The clip reached storage" and "the clip became
 * text" fail independently and for different reasons, and collapsing them is how a worker's
 * answer disappears while the row still reads `completed`.
 */
export const VOICE_CAPTURE_STATUSES = ["recorded", "uploaded", "failed", "abandoned"] as const;
export type VoiceCaptureStatus = (typeof VOICE_CAPTURE_STATUSES)[number];

/** What happened to one recorded answer clip on the TRANSCRIPTION leg. */
export const VOICE_TRANSCRIPT_STATUSES = [
  "pending",
  "queued",
  "succeeded",
  "failed",
  "skipped",
] as const;
export type VoiceTranscriptStatus = (typeof VOICE_TRANSCRIPT_STATUSES)[number];

/**
 * How a projected profile value was arrived at.
 *
 * ONE DEFINITION, because this set is written by the projector, stored on `worker_attributes`, and
 * read back by anyone auditing what a model contributed. Three copies of a provenance vocabulary is
 * three chances for "the LLM wrote this" to stop meaning the same thing in the three places it is
 * checked. `answer-map-projector.ts` re-exports this rather than restating it.
 */
export const PROFILE_VALUE_SOURCES = ["answer_map", "llm_parse"] as const;
export type ProfileValueSource = (typeof PROFILE_VALUE_SOURCES)[number];

/**
 * The storage shape of a `target_kind: "attribute"` answer.
 *
 * NOT the same axis as `answer_type`. Eight answer types collapse into four storage kinds, because
 * what a column needs to know is how to hold the value and how to compare it — a `single_select`
 * and a `city` are both one string to Postgres, and only `multi_select` genuinely needs a list.
 * Keeping the two vocabularies separate is what stops a new answer type from forcing a migration.
 */
export const ATTRIBUTE_VALUE_KINDS = ["boolean", "number", "text", "text_list"] as const;
export type AttributeValueKind = (typeof ATTRIBUTE_VALUE_KINDS)[number];

// ---- AI jobs ----
export const AI_JOB_TYPES = [
  "pseudonymization",
  "transcription",
  "profile_extraction",
  "resume_generation",
] as const;
export type AiJobType = (typeof AI_JOB_TYPES)[number];

export const AI_JOB_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type AiJobStatus = (typeof AI_JOB_STATUSES)[number];

// ---- Job postings (ADR-0012: ops-created, vacancy-banded, stored-only) ----
// Vacancy is captured as a BAND (text), deliberately not an integer count.
export const VACANCY_BANDS = ["1", "2-5", "6-10", "11-25", "25+"] as const;
export type VacancyBand = (typeof VACANCY_BANDS)[number];

/**
 * `suspended` (ADR-0037) is a SYSTEM state, not a poster state. Nothing a payer or an ops
 * user can send sets it: it is written only by the payer-suspension cascade and cleared
 * only by the reinstatement cascade. Every request DTO that accepts a status pins its own
 * literal set (`z.literal("open")` on PATCH, an explicit `z.enum([...])` on the list
 * filter) rather than deriving from this const, so widening here cannot widen an input.
 *
 * It sits between `paused` and `closed` in meaning — invisible like `closed`, reversible
 * like `paused` — and is deliberately NOT modelled as `closed`, which is terminal and would
 * make a suspension unrecoverable.
 */
export const JOB_POSTING_STATUSES = ["draft", "open", "paused", "suspended", "closed"] as const;
export type JobPostingStatus = (typeof JOB_POSTING_STATUSES)[number];

// Ops-set trust review of a posting (the "Verified job" badge the worker sees).
// `unverified` is the default until ops reviews; `rejected` is a reviewed-and-declined
// posting (kept distinct from `unverified` so re-review is deliberate, not implicit).
export const JOB_POSTING_VERIFICATION_STATUSES = ["unverified", "verified", "rejected"] as const;
export type JobPostingVerificationStatus =
  (typeof JOB_POSTING_VERIFICATION_STATUSES)[number];

// ---- Languages (initial supported set for blue/grey-collar India) ----
export const LANGUAGE_CODES = [
  "en",
  "hi",
  "bn",
  "te",
  "ta",
  "mr",
  "gu",
  "kn",
  "ml",
  "pa",
  "or",
  "as",
] as const;
export type LanguageCode = (typeof LANGUAGE_CODES)[number];

// ---- Worker app feedback (#997) ----

/**
 * The coarse, OPTIONAL tag a worker may put on their in-app feedback.
 *
 * It lives here rather than in any one consumer because THREE layers pin the same closed set
 * and a fourth private copy is exactly how they drift: the `worker_feedback_category_chk`
 * CHECK constraint (packages/db), the `feedback.submitted` payload (packages/event-schema),
 * and the request DTO (apps/api). The wire tokens are already SHIPPED in the worker app
 * (`FeedbackCategory.wire`) — they are frozen, and renaming one here would silently reject a
 * released client.
 */
export const WORKER_FEEDBACK_CATEGORIES = ["suggestion", "problem", "other"] as const;
export type WorkerFeedbackCategory = (typeof WORKER_FEEDBACK_CATEGORIES)[number];

/**
 * Server-side ceiling on one feedback message, in characters.
 *
 * The worker app deliberately imposes NO client cap ("never boxed in"), so this is the ONLY
 * bound that exists on worker-authored text. 4000 is generous for a complaint typed on a
 * phone and small enough that the endpoint cannot be used as free blob storage. Pinned at the
 * database too (`worker_feedback_message_len_chk`), because a DTO is the first line of
 * defence and not the last — a backfill or an ops script never passes through zod.
 */
export const WORKER_FEEDBACK_MESSAGE_MAX = 4000;

/**
 * Ceiling on the `x-app-build` header value (#966).
 *
 * By contract it is a commit SHA or a build number, but it arrives from an UNTRUSTED client,
 * so it is bounded and charset-restricted before it is stored or evented. It is telemetry:
 * a malformed stamp is discarded, never a reason to reject the worker's feedback.
 */
export const WORKER_FEEDBACK_APP_BUILD_MAX = 64;

/**
 * Ceiling on the normalized SCREEN CONTEXT stored with a feedback row, in characters.
 *
 * The stored value is a ROUTE PATTERN (`/jobs/:id/apply`), never the concrete path the worker
 * was on — see `sanitizeScreenContext` for why that distinction is the whole privacy design.
 * 128 is generous for the deepest route the worker app ships and small enough that the column
 * cannot be repurposed as a second free-text channel around the `message` bound.
 *
 * Pinned at the database too (`worker_feedback_screen_context_len_chk`), because SQL cannot
 * import and nothing else stops the request-layer cap and the CHECK drifting apart —
 * `worker-feedback-schema.test.ts` asserts the two are equal, exactly as it does for the other
 * two bounds.
 */
export const WORKER_FEEDBACK_SCREEN_MAX = 128;

/**
 * What a stored/evented `screen_context` may look like: a rooted ROUTE PATTERN with NO segment
 * that is an identifier.
 *
 * ⚠ IT LIVES HERE, WITH THE BOUND, FOR THE SAME REASON `WORKER_FEEDBACK_CATEGORIES` DOES. Two
 * layers pin this shape — `sanitizeScreenContext` in apps/api, which normalizes an untrusted
 * client value, and `FeedbackSubmittedPayload` in packages/event-schema, which is the structural
 * backstop on the audit spine — and a private second copy is exactly how they drift. The drift
 * is silent and one-directional: a payload regex looser than the sanitizer admits, from any
 * FUTURE emitter that forgot to normalize, precisely the value the sanitizer exists to stop.
 *
 * ⚠ AND WHY A CHARSET ALONE IS NOT ENOUGH — the mistake worth recording. `[A-Za-z0-9._:/-]`
 * happily admits `/jobs/6f2c04e0-4f89-41d3-9a0c-0305e82c3301/apply`: a uuid is made of exactly
 * those characters. A charset can say "this is not prose"; it cannot say "this is not an
 * identifier", which is the whole property that makes this field permissible on a spine where
 * §2 forbids personal data. Hence the leading negative lookahead: no path SEGMENT may be
 * all-numeric or uuid-shaped. Every segment on a rooted path is preceded by `/`, so scanning
 * for `/<id>(/|end)` covers the first segment as well as the rest.
 *
 * ⚠ AND NO EMPTY SEGMENT — the `//` arm, which is not tidiness either. `//evil.example/jobs` is
 * a rooted path by every check above and a SCHEME-RELATIVE URL to a host we do not control;
 * rendered as a link on the admin Feedback screen it is an outbound navigation an attacker
 * chose. `/a//b` is meaningless besides. So a doubled slash is refused anywhere in the value.
 *
 * Deliberately no whitespace, no `%`, no `?`, no `#`, no `<`, no non-ASCII. `:` is admitted only
 * because `:id` is the substitution marker itself.
 */
const SCREEN_ID_SEGMENT =
  "\\d+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
export const WORKER_FEEDBACK_SCREEN_PATTERN = new RegExp(
  `^(?!.*\\/\\/)(?!.*\\/(?:${SCREEN_ID_SEGMENT})(?:\\/|$))\\/[A-Za-z0-9._:\\/-]*$`,
);

// ---- Branded id helpers (lightweight; not enforced at runtime) ----
export type Uuid = string;
export type Iso8601 = string;
