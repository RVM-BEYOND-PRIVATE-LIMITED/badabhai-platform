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

// ---- Profile source (Task 1 flow separation) ----
// Which road produced the profile: the trade-form road (`form`, one of the
// form-enabled trades, entered via chat handover or résumé-route=form) or the
// LLM-chat road (`chat`, everything else). Written by deterministic code at
// extraction time from the channel record (session form_kind / import route) —
// never by the model — and read by navigation, profile screens and the resume
// renderer so the two roads stop sharing one flow.
export const PROFILE_SOURCES = ["form", "chat"] as const;
export type ProfileSource = (typeof PROFILE_SOURCES)[number];

// ---- Resume history (ADR-0043) ----
// Which flow a GENERATED RÉSUMÉ was made from, as the worker's history list labels it. A
// SEPARATE vocabulary from `ProfileSource`, not a widening of it: `resume_upload` is a fact
// about the session that produced the profile (the worker accepted facts from a CV he
// uploaded), not a third road — an imported CV still finishes through the form or the chat,
// and every reader of `worker_profiles.source` keeps its two values. Owner ruling R1
// (2026-09-24): an accepted import wins over the road.
export const RESUME_SOURCES = ["form", "chat", "resume_upload"] as const;
export type ResumeSource = (typeof RESUME_SOURCES)[number];

// What STARTED a résumé generation. Every AI generation is a history entry (ruling R2), and
// this is what tells the entries apart for the worker and for the funnel:
//   profile_confirmed     the system auto-generate on a confirmed profile
//   manual                the worker asked (POST /resume/generate)
//   chat_update_accepted  the worker said "Haan" to "Resume update kar doon?" in chat
//   ops_regenerate        an operator re-ran generation (internal route)
export const RESUME_GENERATION_TRIGGERS = [
  "profile_confirmed",
  "manual",
  "chat_update_accepted",
  "ops_regenerate",
] as const;
export type ResumeGenerationTrigger = (typeof RESUME_GENERATION_TRIGGERS)[number];

// ---- Post-completion chat companion (ADR-0044) ----
// The closed vocabularies the Bada Bhai tab's companion speaks in once a worker's profile is
// confirmed. They are shared by the API (which decides) and the event spine (which records), so
// the event payload can never carry a value the service does not know. IDS, NEVER TEXT: none of
// these names a job, a title, a trade label or anything the worker typed.
//
// WHAT STARTED a companion turn: the tab opening (`GET /chat/companion`) or a message.
export const COMPANION_TRIGGERS = ["open", "message"] as const;
export type CompanionTrigger = (typeof COMPANION_TRIGGERS)[number];
// WHAT A TURN ANSWERED. `digest` is the "ab tak kya hua" recap (the opening, a greeting);
// `resume_menu` is the existing post-completion résumé menu served verbatim; `guarantee` is the
// persona's fixed honest line; `fallback` is "neeche se chunein".
export const COMPANION_INTENTS = [
  "digest",
  "resume_menu",
  "jobs",
  "applied",
  "guarantee",
  "fallback",
] as const;
export type CompanionIntent = (typeof COMPANION_INTENTS)[number];
// THE ONE NUDGE LINE a recap may carry — picked by an ordered deterministic rule, never a model.
// No value means "no nudge line was served", which is why the event field is nullable instead
// of carrying a `none` member (one encoding, not two).
export const COMPANION_NUDGES = [
  "resume_pending",
  "apply_first",
  "apply_new",
  "complete_profile",
] as const;
export type CompanionNudge = (typeof COMPANION_NUDGES)[number];
// WHETHER "new jobs for your profile" could be said at all: `profile` the worker's wanted skills
// were matched; `no_skills` the worker has none, so no claim is made; `unavailable` the read
// failed and the line was left out.
export const COMPANION_JOBS_SCOPES = ["profile", "no_skills", "unavailable"] as const;
export type CompanionJobsScope = (typeof COMPANION_JOBS_SCOPES)[number];

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
  // E0 — the IN-APP RELAY (ADR/owner ruling docs/decisions/E0_RELAY_DECISION_2026-09.md §A,
  // signed 2026-09-07). `employer_sharing` authorises DISCLOSING a worker's routed contact
  // to a paying party; it does NOT authorise MESSAGING him over the resulting channel. Those
  // are two things a person would expect to be asked about separately, so they are asked
  // separately.
  //
  // WHY IT IS MINTED NOW, BEFORE THE NOTICE COPY OR ANY CLIENT WANTS IT — this is the part a
  // later session will want to re-litigate. The enum's commonest rule for splitting a purpose
  // is EGRESS TO A THIRD PARTY (`whatsapp_messaging` because the phone reaches Meta,
  // `voice_processing` because the clip reaches a processor). The in-app relay has NO egress,
  // so on that rule alone it would not have earned a split — but `agent_activity_visibility`
  // already splits on a non-egress rationale, and the DEADLINE is what decided it: no worker
  // holds `employer_sharing` today and E4 already owes a full re-consent, so this purpose
  // costs one sentence in copy that does not yet exist if it lands now, and a SECOND
  // re-consent over an already-opted-in base if it lands later. That is the `model_training`
  // decision taken deliberately a second time.
  //
  // Dormant on arrival, and that is the house pattern rather than an exception: a purpose no
  // client requests fails closed for every worker, so the relay routes stay shut until E4's
  // notice copy ships and workers opt in. `employer_sharing`, `whatsapp_messaging`,
  // `agent_activity_visibility` and `voice_processing` all held exactly this posture.
  // Requesting it from a client is E4's work and must not happen before the copy.
  "employer_messaging",
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
export const CURRENT_CONSENT_VERSION = "2026-08-28" as const;

// ---- Chat ----
/**
 * `active` → running. `ended` → the worker finished the interview. `abandoned` → the interview
 * did NOT finish and the system closed it: the idle sweep, after the worker stopped answering, or
 * (#1744) the confirm of a profile the worker made from an early finish — the same close, and the
 * same end-state, the sweep would otherwise write hours later.
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
export const ATTRIBUTE_VALUE_KINDS = ["boolean", "number", "text", "text_list", "json"] as const;
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
export type JobPostingVerificationStatus = (typeof JOB_POSTING_VERIFICATION_STATUSES)[number];

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
 * Ceiling on the SCREEN CONTEXT stored with a feedback row, in characters.
 *
 * ⚠ THIS IS NO LONGER THE OPERATIVE LIMIT, and reading it as one is the mistake this note
 * exists to prevent. The stored value is a member of {@link WORKER_APP_SCREEN_TEMPLATES} —
 * `resolveScreenTemplate` returns a constant from that table or `null`, never a value derived
 * from the caller's bytes — so the longest thing that can reach the column is the longest
 * template (`/profile/settings/devices`, 25 characters). 128 is now a DATABASE-LEVEL BACKSTOP
 * against a writer that bypasses the resolver entirely (a backfill, an ops script), and a cheap
 * pre-split DoS bound at the request edge (`raw.length > MAX * 10`).
 *
 * Pinned at the database too (`worker_feedback_screen_context_len_chk`), because SQL cannot
 * import and nothing else stops the constant and the CHECK drifting apart —
 * `worker-feedback-schema.test.ts` asserts the two are equal, exactly as it does for the other
 * two bounds. See the note on that CHECK in `schema/feedback.ts` for why the constraint stayed a
 * LENGTH bound rather than being tightened to pin membership.
 */
export const WORKER_FEEDBACK_SCREEN_MAX = 128;

/**
 * How many images a worker may attach to ONE feedback submission (#1191).
 *
 * THREE, and the number is the SHIPPED CLIENT'S — the Flutter picker stops offering the camera
 * at three, so this is the server restating a limit that already exists rather than inventing
 * one. It lives here because three layers pin it and a private copy in any of them is how they
 * drift: the request DTO's `.max()` (apps/api), the admin projection that mints one signed URL
 * per stored path (apps/api/src/admin), and the worker app's own picker.
 *
 * DELIBERATELY NOT PINNED AT THE DATABASE, unlike every other bound on this table (`message`,
 * `app_build`, `screen_context`). A jsonb CHECK counting array elements would make raising the
 * cap a MIGRATION that has to land before the code accepting a fourth image — and get that
 * order wrong and the INSERT is a 23514 inside the same transaction as the event, costing the
 * worker the paragraph they typed. Migration 0081's header already ruled that a column of this
 * kind must never be able to do that. The control that actually matters on this field is the
 * per-path ownership regex in `FeedbackService`, which is not a bound at all.
 */
export const WORKER_FEEDBACK_ATTACHMENTS_MAX = 3;

/**
 * Ceiling on ONE stored attachment path, in characters.
 *
 * A generous bound on a value the SERVER minted: the real key is
 * `feedback-attachments/<uuid>/<uuid>.jpg` — 78 characters, fixed — so nothing honest comes near
 * this. It exists because the path arrives BACK from the client on the submit call and is
 * untrusted at that moment: bounding it before the ownership regex runs is what keeps a megabyte
 * of caller-chosen bytes from being handed to a `RegExp.test` at all.
 */
export const WORKER_FEEDBACK_ATTACHMENT_PATH_MAX = 512;

/**
 * The object-key PREFIX every feedback attachment lives under in the private attachments bucket:
 * `feedback-attachments/<workerId>/<uuid>.jpg`.
 *
 * ONE CONSTANT BECAUSE TWO PLACES MUST AGREE OR THE FEATURE IS AN IDOR. The mint builds the key
 * from it and the submit route's ownership regex re-derives the same shape from it. Had those
 * two strings been written out twice and drifted, one direction is loud and harmless (every
 * honest submission 400s) and the other is silent and the whole control (the regex stops
 * anchoring on the prefix the mint actually uses). Kept beside the worker-scoped `photos/`
 * precedent it copies (ADR-0032).
 */
export const WORKER_FEEDBACK_ATTACHMENT_PREFIX = "feedback-attachments";

/**
 * The object-key PREFIX every uploaded résumé lives under in the private uploads bucket:
 * `resume-uploads/<workerId>/<uuid>.<pdf|docx|jpg|png>` (ADR-0041).
 *
 * ONE CONSTANT BECAUSE THREE PLACES MUST AGREE, and one of the three is an erasure. The mint
 * builds the key from it, the confirm route's ownership regex re-derives the same shape from
 * it, and `AccountDeletionService` sweeps the prefix built from it.
 *
 * The first two drifting apart is the IDOR the feedback constant above describes. The THIRD is
 * worse, and it is the reason this is a constant rather than three literals: a sweep prefix that
 * no longer matches the mint deletes nothing and reports a successful erasure. Ruling D6 retains
 * these objects permanently, so that sweep is the ONLY erasure path this feature has — a drifted
 * copy would not degrade DSAR coverage, it would end it, silently, while still logging success.
 */
export const WORKER_RESUME_UPLOAD_PREFIX = "resume-uploads";

/**
 * The object-key PREFIX every portfolio media object lives under in the private portfolio bucket:
 * `portfolio/<workerId>/<uuid>.<jpg|png|webp|mp4|mov>` (ADR-0042 D9 / Layer A (e), migration 0113).
 *
 * ONE CONSTANT BECAUSE THREE PLACES MUST AGREE, and one of the three is an erasure. The mint
 * (`WorkerPortfolioService.createUploadUrl`) builds the key from it, the register step's ownership
 * check (`portfolioKeyBelongsTo`) re-derives the same shape from it, and
 * `AccountDeletionService` sweeps the prefix built from it.
 *
 * The first two drifting apart is the IDOR the feedback constant above describes. The THIRD is
 * the reason this is a constant rather than three literals: a sweep prefix that no longer matches
 * the mint deletes nothing and reports a successful erasure. Until #1548 landed this sweep did not
 * exist at all, which is why the bucket was documented as do-not-arm until it did.
 */
export const WORKER_PORTFOLIO_PREFIX = "portfolio";

/**
 * EVERY SCREEN THE WORKER APP HAS. The closed set a `screen_context` may be drawn from.
 *
 * ── WHY A TABLE AND NOT A PATTERN ────────────────────────────────────────────────────────
 * `screen_context` arrives from an UNTRUSTED client and lands in three places CLAUDE.md §2
 * forbids personal data from reaching: the `feedback.submitted` event, the API log line, and the
 * admin screen. The previous design SANITIZED — it substituted id-SHAPED runs (uuids, long hex,
 * long digit runs) with `:id` and stored what was left. That is a DENYLIST, and a denylist over
 * attacker-chosen text cannot make a §2 guarantee. It was measured failing twice:
 *
 *     /jobs/id-6f2c04e0-4f89-41d3-9a0c-0305e82c3301/apply   passed verbatim (v1, whole-segment)
 *     /w/9876543210-ravi                                    passed verbatim (v1, whole-segment)
 *     /u/dGVzdEBleGFtcGxlLmNvbQ                             passed verbatim (v2 — base64url of
 *                                                           an email address; neither hex nor
 *                                                           digits, so no id shape sees it)
 *     /x/AKIAIOSFODNN7EXAMPLE                               passed verbatim (v2)
 *
 * An ALLOWLIST inverts the burden. The worker app's route table is FINITE and KNOWN, so the
 * server can match against it and return ITS OWN CONSTANT. What reaches the column, the event
 * and the log is then a literal from this array — no client-supplied byte can land in a §2 sink,
 * whatever the caller sent. That is a proof rather than a heuristic, and it is the whole reason
 * this array exists.
 *
 * ── WHERE IT COMES FROM ──────────────────────────────────────────────────────────────────
 * Re-derived from `apps/worker-app/lib/router.dart` — the `Routes` class constants plus the one
 * inline `GoRoute(path: '/i/:code')`. `screen-template-table.contract.test.ts` in apps/api reads
 * that Dart file and fails when the app declares a route this table does not resolve, so the
 * divergence this design's failure mode depends on (the app adds a screen, the server reports
 * `null` for it forever, nobody notices) reddens CI in the PR that causes it.
 *
 * ⚠ `:id` IS A WILDCARD POSITION, NOT A CLAIM ABOUT THE VALUE. It matches any single non-empty
 * segment, and only three routes have one: the referral code, the job id, and the interview-kit
 * trade key. The trade key is not an identifier and is still collapsed to `:id`, because the
 * point is not "hide the ids" — it is that NOTHING from the caller is echoed back.
 *
 * ⚠ ORDER IS IRRELEVANT AND MUST STAY SO. The three dynamic templates have disjoint literal
 * prefixes (`/i`, `/jobs/detail`, `/profile/kit/detail`), so at most one template can match any
 * input; `screen-context.test.ts` pins that no input resolves ambiguously.
 *
 * Frozen because it is a security boundary: a consumer that pushed onto it would widen the set
 * of values allowed onto the event spine at runtime.
 */
export const WORKER_APP_SCREEN_TEMPLATES = Object.freeze([
  // --- Onboarding and auth (top-level, no bottom nav) ---
  "/", // Routes.splash
  "/login", // Routes.phoneLogin
  "/otp", // Routes.otpVerify
  "/pin", // Routes.pin
  "/pin/set", // Routes.setPin
  "/pin/forgot", // Routes.forgotPin
  "/consent", // Routes.consent
  "/name", // Routes.name
  "/invite", // Routes.invite
  "/chat", // Routes.chatProfiling
  "/voice", // Routes.voiceNote
  "/profiling", // Routes.profilePreview
  "/building", // Routes.building
  // #1296's post-interview finishing form. Added here in R10 rather than with the screen,
  // because that PR touched only `apps/worker-app` and the CI path filter therefore never ran
  // the Node job that owns this contract — a green check on a suite that did not run. The first
  // build to merge main into an api-touching branch caught it.
  "/finishing", // Routes.finishing
  // The CNC-turner trade form (#1341). Added here rather than with the screen for EXACTLY the
  // reason recorded three lines up, which has now happened a second time: that PR touched only
  // `apps/worker-app`, the CI path filter skipped the Node job that owns this contract, and the
  // route landed on main with a green check on a suite that never ran. It was caught by the
  // first api-touching branch to merge main — the same way, one release later.
  // #1687 — the worker's own resume history, pushed from the Profile tab.
  "/profile/resumes", // Routes.resumeHistory
  "/trade-form", // Routes.tradeForm
  // #1698 — the tier chooser ("Kitna time de sakte hain?"), between the form
  // handover and the first form question. Listed here for the same reason the
  // comment above records: a worker-app-only PR does not run the Node job that
  // owns this contract, so a route added without its entry lands green and
  // breaks the first api-touching merge afterwards.
  "/trade-form/tier", // Routes.tierChoice
  "/alerts", // Routes.alerts
  // Relay inbox (E0, FE #1628) — the worker's threads list and one thread.
  "/inbox", // Routes.inbox
  "/inbox/:id", // GoRoute(path: '/inbox/:unlockId')
  "/feedback", // Routes.feedback
  // The referral deep link. Declared inline in the route tree rather than as a `Routes`
  // constant, because nothing in the app navigates to it — the platform delivers it.
  "/i/:id", // GoRoute(path: '/i/:code')
  // --- Shell branches (persistent bottom nav) and their sub-routes ---
  "/jobs", // Routes.jobs
  "/jobs/search", // Routes.jobSearch
  "/jobs/detail/:id", // Routes.jobDetail + '/<jobId>'
  "/resume", // Routes.resume
  "/resume/edit", // Routes.resumeEdit
  // Extracted-profile review + correction surface (worker-app #1595, §8.4).
  "/resume/review", // Routes.extractedReview
  "/resume-upload", // Routes.resumeUpload
  "/bada-bhai", // Routes.badaBhai
  "/profile", // Routes.profile
  "/profile/applied", // Routes.appliedJobs
  // Layer A profile surfaces (ADR-0042 D9, issue #1545) — the Profile-edit
  // screen pushed from the Profile tab.
  "/profile/edit", // Routes.profileEdit
  "/profile/kit", // Routes.kit
  "/profile/kit/detail/:id", // Routes.kitDetail + '/<tradeKey>'
  "/profile/settings", // Routes.settings
  "/profile/settings/devices", // Routes.devices
  // The #1429 state→city demo picker USED TO SIT HERE. It was a preview standing in for a backend
  // dataset that has since shipped (#1437 state-tags the gazetteer and serves a state list), so the
  // real cascade now lives on the trade form's preferred-cities page and the Settings preview —
  // route, screen and this entry — is gone. Removing it here is not optional: the contract asserts
  // this list and `router.dart`'s route count are equal, so the two move together or CI reddens.
  //
  // THE BROKEN GATE THAT ENTRY RECORDED IS STILL BROKEN, and is kept here because it outlives the
  // route that surfaced it three times: this contract is owned by a Node job that is path-filtered
  // OFF the PRs most likely to violate it (worker-app-only changes), so the check is structurally
  // absent exactly when it is needed. Raised for the CI owner: the Node job should not be
  // path-filtered out when `apps/worker-app/lib/router.dart` changes.
] as const);

/** One screen of the worker app. The ONLY non-null shape `screen_context` can hold. */
export type WorkerAppScreenTemplate = (typeof WORKER_APP_SCREEN_TEMPLATES)[number];

/**
 * Membership as a lookup. Built once — the resolver runs on the request path of a worker's
 * feedback, and `Array.includes` over the table on every call would be a linear scan for the
 * common case (a static route, which is 25 of the 28).
 */
const WORKER_APP_SCREEN_TEMPLATE_SET: ReadonlySet<string> = new Set(WORKER_APP_SCREEN_TEMPLATES);

/**
 * Whether a value is one of the app's screens.
 *
 * A TYPE GUARD ON PURPOSE. It is what lets `FeedbackSubmittedPayload` narrow, and what makes
 * "this string came from the table" a fact the compiler carries rather than a comment.
 */
export function isWorkerAppScreenTemplate(value: unknown): value is WorkerAppScreenTemplate {
  return typeof value === "string" && WORKER_APP_SCREEN_TEMPLATE_SET.has(value);
}

/**
 * EVERY TRADE FORM THE PLATFORM DECLARES — the closed set behind `form_kind` on the spine.
 *
 * ═══ WHY IT LIVES HERE AND NOT WHERE THE AUTHORITY IS ═══
 *
 * The authority is `ROLE_FORM_DESCRIPTORS` in `apps/api/src/profiling/roles/` — one descriptor per
 * role, from which the router's routes, the offers, the résumé maps and the conflict vocabulary
 * are all derived. `packages/event-schema` cannot import from an app: the dependency runs the
 * other way and must keep doing so, because an event contract has to be readable by a consumer
 * that has never seen the API.
 *
 * So the SET sits in the one package both sides already depend on, exactly as
 * {@link WORKER_APP_SCREEN_TEMPLATES} does for the Flutter route table — `payloads.ts` builds its
 * `z.enum` from this, `role-registry.ts` asserts every declared role kind appears in it, and there
 * is one list rather than two that can disagree.
 *
 * ═══ IT COVERS DECLARED ROLES, NOT ENABLED ONES ═══
 *
 * A role is DECLARED before its form is enabled — it contributes veto vocabulary to the router
 * while its pack is still being authored. Listing only the enabled ones would mean this had to be
 * edited in the same commit that flips `formEnabled`, which is precisely the edit that gets
 * forgotten: the TypeScript type widens, the zod enum does not, `emit` throws,
 * `recordFormHandoff` swallows it, and the handover goes invisible for the trade just launched.
 *
 * ═══ WIDENING IS ADDITIVE. NARROWING IS NOT ═══
 *
 * Adding a value leaves every historical payload valid and every consumer switching on `form_kind`
 * working — it gains a case. REMOVING one is the breaking change, and needs a v2 payload beside
 * the v1 rather than an edit in place.
 *
 * Frozen for the same reason the screen table is: a consumer that pushed onto it would widen the
 * set of values allowed onto the event spine at runtime.
 */
export const TRADE_FORM_KINDS_ALL = Object.freeze([
  "cnc_turner", // qp_cnc_turning — the first form-first trade, enabled
  "vmc_milling", // qp_vmc_milling — declared; pack and résumé map already shipped
  "cnc_grinding", // declared
  "cam_programmer", // qp_cam_programming — enabled in Batch 1; a desk role in the `design` cluster
  "cad_draughtsman", // qp_cad_drafting — enabled in Batch 1; the fresher-first drawing-office role

  // ── BATCH 2 — metal fabrication, assembly & maintenance (declared; forms follow per cluster) ──
  "conventional_machinist", // qp_conventional_machining — `machining`; shares "lathe" with turning
  "tool_die_maker", // qp_tool_die_making — `machining`; the tool room, vetoed against mould making
  "welder", // qp_welding_trade — `fabrication`
  "sheet_metal_worker", // qp_sheet_metal_fab — `fabrication`
  "press_operator", // qp_press_operation — `fabrication`; die setting overlaps the tool room
  "painter_coating", // qp_powder_coating — `fabrication`
  "fitter", // qp_fitter — `maintenance`
  "maintenance_technician", // qp_maintenance_tech — `maintenance`
  "industrial_electrician", // qp_industrial_electrician — `maintenance`
  "assembly_line_worker", // qp_assembly_line — `production`
  "quality_inspector", // qp_quality_inspection — `production`

  // ── BATCH 3 — plastics & rubber (declared for their VOCABULARY, so Batch 2's vetoes are whole) ──
  "injection_moulding_operator", // qp_injection_moulding — `polymer`
  "mould_die_maker", // qp_mould_making — `polymer`; the cross-cluster rival of `tool_die_maker`
  "blow_moulding_operator", // qp_blow_moulding — `polymer`
  "rubber_moulding_operator", // qp_rubber_moulding — `polymer`
  "plastic_process_technician", // qp_plastic_process — `polymer`
] as const);

export type TradeFormKindName = (typeof TRADE_FORM_KINDS_ALL)[number];

// ---- Tiered profiling (migration 0126) ----
//
// HERE FOR THE SAME REASON AS THE SETS BELOW: `packages/db` writes these into CHECK constraints,
// `packages/event-schema` puts them on the spine, and `apps/api` filters questions and résumé
// rows by them. Declared once so the three cannot drift.

/**
 * How deep a worker chose to profile on the Chat path — lowest first.
 *
 * CUMULATIVE BY DEFINITION: Medium asks everything Easy asks and more, Hard asks everything.
 * Hard IS today's full profiling, which is why it is also the default below.
 */
export const PROFILING_TIERS = Object.freeze(["easy", "medium", "hard"] as const);
export type ProfilingTier = (typeof PROFILING_TIERS)[number];

/**
 * The tier of an UNTAGGED question and of a worker with NO recorded tier.
 *
 * Hard, so both fail safe to the behaviour that shipped before tiers existed: an untagged question
 * is still asked, and an existing profile still renders every row it rendered before.
 */
export const DEFAULT_PROFILING_TIER: ProfilingTier = "hard";

export function isProfilingTier(value: unknown): value is ProfilingTier {
  return typeof value === "string" && (PROFILING_TIERS as readonly string[]).includes(value);
}

/** 0 for Easy, 1 for Medium, 2 for Hard — the only ordering the tiers have. */
export function profilingTierRank(tier: ProfilingTier): number {
  return PROFILING_TIERS.indexOf(tier);
}

/**
 * Does a worker profiling at `workerTier` get a question tagged `itemMinTier`?
 *
 * `null`/`undefined` is an untagged question, which is Hard ({@link DEFAULT_PROFILING_TIER}).
 */
export function tierIncludes(
  workerTier: ProfilingTier,
  itemMinTier: ProfilingTier | null | undefined,
): boolean {
  return profilingTierRank(itemMinTier ?? DEFAULT_PROFILING_TIER) <= profilingTierRank(workerTier);
}

// ---- Résumé import (ADR-0041) ----
//
// THESE LIVE HERE RATHER THAN IN THE SCHEMA because two packages that cannot import each other
// need the same closed sets: `packages/db` writes them into CHECK constraints, and
// `packages/event-schema` puts them on the event spine as `z.enum(...)`. Declared twice, they
// would drift the first time one gained a value — and the symptom would be an event the registry
// refuses for a row the database happily stored.
//
// Frozen for the same reason `TRADE_FORM_KINDS_ALL` is: a consumer that pushed onto one of these
// would widen at runtime the set of values allowed onto the spine.

/**
 * Where an import is in its life.
 *
 * `failed` and `discarded` are kept apart deliberately. `failed` is OURS — we could not read the
 * document, and ruling D9 says we tell the worker so plainly and carry on. `discarded` is HIS — he
 * changed his mind or replaced the file. Collapsing them would make "how often does our parser let
 * a worker down" unanswerable, which is the one number RI-7 exists to move.
 */
export const RESUME_IMPORT_STATUSES = Object.freeze([
  "uploaded",
  "parsing",
  "parsed",
  "failed",
  "discarded",
] as const);
export type ResumeImportStatusName = (typeof RESUME_IMPORT_STATUSES)[number];

/**
 * How the text was recovered. Null until a parse has actually run.
 *
 * `ocr` is local Tesseract inside the ai-service container, never a cloud vision call — the
 * distinction is the whole reason ruling D3 could accept photographs without adding a
 * sub-processor or sending an unmaskable image across the AI boundary.
 */
export const RESUME_EXTRACTION_METHODS = Object.freeze(["pdf_text", "docx", "ocr"] as const);
export type ResumeExtractionMethodName = (typeof RESUME_EXTRACTION_METHODS)[number];

/**
 * Which surface the worker was sent to afterwards — the output of `routeToTradeForm()`.
 *
 * Only 9 of 21 declared roles have a form at all, so "how often did an import actually reach one"
 * is a real question about whether this feature earns its keep, and it is unanswerable unless the
 * decision is recorded at the time it is made.
 */
export const RESUME_IMPORT_ROUTES = Object.freeze(["form", "chat"] as const);
export type ResumeImportRouteName = (typeof RESUME_IMPORT_ROUTES)[number];

/**
 * Why a parse produced nothing usable. A CLOSED list, and it never carries model text.
 *
 * The reason is both shown to the worker (D9) and counted on the event, so an open string here
 * would be an untrusted value on a screen AND a PII leak into analytics at once. Same discipline
 * as `PARSE_NOTES` in the ai-service: a fixed vocabulary, and whatever the model says about its
 * own failure is discarded unread.
 */
export const RESUME_IMPORT_FAILURES = Object.freeze([
  "no_text_layer",
  "ocr_below_floor",
  "unsupported_document",
  "encrypted_document",
  "empty_document",
  "parse_unavailable",
  "parse_deadline_exceeded",
  "parse_output_invalid",
] as const);
export type ResumeImportFailureName = (typeof RESUME_IMPORT_FAILURES)[number];

/**
 * #1656 — why a parse produced nothing WITHOUT the document being at fault.
 *
 * A DEGRADED POSTURE IS NOT A FAILURE, which is exactly why it needs its own vocabulary.
 * `RESUME_IMPORT_FAILURES` above says "we could not read this document"; every value here says
 * "we never really read it, and the document had nothing to do with that". The import still
 * settles `parsed` and the worker still routes (ruling D9) — a spend cap must not cost a man
 * his onboarding — so without a recorded code the two are one number on the event, and "how
 * often does our parser let a worker down" (RI-7's number) counts spend-capped no-ops as
 * successful parses.
 *
 * ORDER IS PRECEDENCE, and it is the only thing that makes ONE nullable value safe. The
 * far side appends these under `if not meta.real_call: ... elif not meta.success: ...`
 * (`apps/ai-service/app/resume_import/resume_parse.py`), which is a single `if/elif` around a
 * single `router.run`, so at most one can arrive today. Should a future far side ever send
 * both, the reader takes the FIRST member of this list that is present rather than the first
 * the wire happened to order — `llm_unavailable` is the INCIDENT an operator must see, and a
 * posture must never hide it.
 *
 * MIRRORS `RESUME_PARSE_NOTES` in the ai-service IN DISCIPLINE, not in content: the far side's
 * vocabulary also carries call-quality notes (`fields_rejected`, `extraction_truncated`, …)
 * which describe a call that DID happen and belong to RI-7's quality story, not to "was
 * anything even attempted". Anything outside this list is dropped rather than recorded.
 */
export const RESUME_DEGRADED_POSTURES = Object.freeze([
  /** An INCIDENT: a provider was reached and failed. Someone should look. */
  "llm_unavailable",
  /** A POSTURE: a spend cap, a cooldown, a cost ceiling or the kill switch sent the router to
   *  the deterministic mock, so no model call happened at all. Nothing is broken. */
  "mock_no_parse",
] as const);
export type ResumeDegradedPostureName = (typeof RESUME_DEGRADED_POSTURES)[number];

/**
 * The document types ruling D3 accepts, as MIME strings.
 *
 * FOUR, because this is what workers actually have. PDF and DOCX cover a cybercafe export; JPEG
 * and PNG cover a photograph of a printed sheet, which for this user base is the common case
 * rather than the fallback. The list is duplicated in `infra/supabase/storage-buckets.sql` as the
 * bucket's `allowed_mime_types` — deliberately, because that copy is the OUTER wall that refuses
 * the PUT before any of our code runs, and this one is the inner check against object-info.
 */
export const RESUME_UPLOAD_MIME_TYPES = Object.freeze([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
] as const);
export type ResumeUploadMimeName = (typeof RESUME_UPLOAD_MIME_TYPES)[number];

// ---- Branded id helpers (lightweight; not enforced at runtime) ----
export type Uuid = string;
export type Iso8601 = string;
