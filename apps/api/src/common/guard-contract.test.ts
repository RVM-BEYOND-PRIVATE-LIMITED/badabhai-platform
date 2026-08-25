import "reflect-metadata";
import { describe, it, expect } from "vitest";

// Every controller in apps/api. Importing them here also proves they compile +
// their metadata is well-formed.
import { ActionsController } from "../actions/actions.controller";
import { WorkerActionsController } from "../actions/worker-actions.controller";
import { ApplicationsController } from "../applications/applications.controller";
import { AuthController } from "../auth/auth.controller";
import { ChatController } from "../chat/chat.controller";
import { ConsentController } from "../consent/consent.controller";
import { EventsController } from "../events/events.controller";
import { WorkerFeedbackController } from "../feedback/worker-feedback.controller";
import { HealthController } from "../health/health.controller";
import { InterviewKitController } from "../interview-kit/interview-kit.controller";
import { JobsController } from "../jobs/jobs.controller";
import { JobPostingsController } from "../job-postings/job-postings.controller";
import { MessagingController } from "../messaging/messaging.controller";
import { CapacityController } from "../posting-plans/capacity.controller";
import { PostingPlansController } from "../posting-plans/posting-plans.controller";
import { PricingController } from "../pricing/pricing.controller";
import { AiJobsController } from "../profiles/ai-jobs.controller";
import { WorkerAiJobsController } from "../profiles/worker-ai-jobs.controller";
import { ProfilesController } from "../profiles/profiles.controller";
import { ReachController } from "../reach/reach.controller";
import { PaceController } from "../pace/pace.controller";
import { ResumeController } from "../resume/resume.controller";
import { UnlocksController } from "../unlocks/unlocks.controller";
import { RazorpayWebhookController } from "../unlocks/razorpay-webhook.controller";
import { VoiceController } from "../voice/voice.controller";
import { WorkersController } from "../workers/workers.controller";
import { PayerAuthController } from "../payer-portal/payer-auth.controller";
import { PayerUnlocksController } from "../payer-portal/payer-unlocks.controller";
import { PayerCapacityController } from "../payer-portal/payer-capacity.controller";
import { PayerPricingController } from "../payer-portal/payer-pricing.controller";
import { PayerReachController } from "../payer-portal/payer-reach.controller";
import { MatchSkillsController } from "../match/match-skills.controller";
import { AgencyJobsController } from "../agency/agency-jobs.controller";
import { AgencyInvitesController } from "../agency/agency-invites.controller";
import { AgencyWorkersController } from "../agency/agency-workers.controller";
import { AgencyPayoutsController } from "../agency/agency-payouts.controller";
import { AgencyKycOpsController } from "../agency/agency-kyc-ops.controller";
import { AdminAuthController } from "../admin/admin-auth.controller";
import { AdminEventsController } from "../admin/admin-events.controller";
import { AdminActionsController } from "../admin/admin-actions.controller";
import { AdminPiiRevealController } from "../admin/admin-pii-reveal.controller";
import { AdminAiTracesController } from "../admin/admin-ai-traces.controller";
import { NotificationsController } from "../notifications/notifications.controller";
import { NotificationPrefsController } from "../notifications/notification-prefs.controller";
import { SkillsController } from "../skills/skills.controller";
import { ReferralAttributionController } from "../referrals/referral-attribution.controller";
import { ReferralBonusController } from "../referrals/referral-bonus.controller";
// BL-3 — 17 controllers independently found missing from this contract (11 platform-wide
// beyond PAY-SEC-06's 6 payer/agency ones, incl. 4 admin controllers). Every guard below was
// read directly from each controller's current @UseGuards, not assumed from the audit.
import { AdminDirectoryController } from "../admin/admin-directory.controller";
import { AdminEntitiesController } from "../admin/admin-entities.controller";
import { AdminFeedbackController } from "../admin/admin-feedback.controller";
import { AdminFinanceController } from "../admin/admin-finance.controller";
import { AdminWorkerJourneyController } from "../admin/admin-worker-journey.controller";
import { AdminKillSwitchController } from "../admin/admin-kill-switch.controller";
import { AdminDashboardController } from "../admin/admin-dashboard.controller";
import { DevicesController } from "../auth/devices.controller";
import { PinController } from "../auth/pin.controller";
import { ProfilingController } from "../profiling/profiling.controller";
import { ResumeDisclosureController } from "../disclosures/resume-disclosure.controller";
import { OccupationController } from "../occupation/occupation.controller";
import { InterviewKitsController } from "../interview-kit/interview-kits.controller";
import { ReferralResolverController } from "../referrals/referral-resolver.controller";
import { JobPostingChatController } from "../payer-portal/job-posting-chat/job-posting-chat.controller";
import { PayerDisclosureController } from "../payer-portal/payer-disclosure.controller";
import { PayerJobPostingsController } from "../payer-portal/payer-job-postings.controller";
import { PayerOrgInvitesController } from "../payer-portal/payer-org-invites.controller";
import { PayerOrgMembersController } from "../payer-portal/payer-org-members.controller";
import { PayerAccountController } from "../payers/payer-account.controller";

/**
 * AUTHZ CONTRACT — the single source of truth for which guards protect every
 * route, asserted against the actual NestJS `@UseGuards` metadata. This is a
 * regression net: removing/forgetting a guard (the exact class of the P0
 * chat/profile/voice finding) fails this test. The "effective" guard set for a
 * route is the UNION of class-level and method-level guards (Nest applies both).
 *
 * `none` means an intentionally open/alpha-posture route — listed explicitly so
 * "open" is a recorded decision, not an oversight. Auth posture changes must edit
 * this map (and a reviewer sees it in the diff).
 */
const GUARDS_METADATA = "__guards__";

function guardNames(target: object | undefined): string[] {
  if (!target) return [];
  const g = Reflect.getMetadata(GUARDS_METADATA, target) as
    | Array<{ name?: string; constructor?: { name: string } }>
    | undefined;
  return (g ?? []).map((x) => x.name ?? x.constructor?.name ?? "anonymous");
}

/** Class-level ∪ method-level guards for one route handler, sorted + de-duped. */
function effectiveGuards(ctor: new (...args: never[]) => object, method: string): string[] {
  const cls = guardNames(ctor);
  const fn = guardNames((ctor.prototype as Record<string, object>)[method]);
  return [...new Set([...cls, ...fn])].sort();
}

type Ctor = new (...args: never[]) => object;
interface ControllerContract {
  name: string;
  ctor: Ctor;
  routes: Record<string, string[]>; // method name -> expected effective guards
}

const W = "WorkerAuthGuard";
const C = "ConsentGuard";
const I = "InternalServiceGuard";
const P = "PayerAuthGuard";
const R = "PayerRoleGuard";
const A = "AdminAuthGuard";
const AR = "AdminRolesGuard";
const CNR = "ConsentNotRevokedGuard";
const SI = "SkillsInternalGuard";
const TL = "TestLoginGuard";
const PTL = "PayerTestLoginGuard";
const PE = "AgencyPayoutsEnabledGuard";
const ATF = "AdminAiTraceFlagGuard";
/**
 * ⚠ NOT AN AUTH GUARD. `OptionalWorkerAuthGuard` attaches `req.worker` when a valid session
 * token happens to ride along and ALWAYS returns true — its `canActivate` has one return
 * statement. It appears in this contract because it appears in the route metadata, NOT because
 * the route it sits on is protected: `GET /interview-kit/:tradeKey/download` is and remains
 * publicly reachable without a token. It exists so `interview_kit.downloaded` can carry an
 * optional `worker_id` for the admin journey funnel.
 *
 * If this alias ever appears on a route that MUST be authenticated, that route is open.
 */
const OW = "OptionalWorkerAuthGuard";
const RZ = "RazorpayWebhookGuard";
const POR = "PayerOrgRoleGuard";

const CONTRACT: ControllerContract[] = [
  { name: "Actions", ctor: ActionsController, routes: { record: [I], recordBatch: [I] } },
  // #694 — the worker's OWN action sink, deliberately a separate controller so it cannot inherit
  // the ops guard above. `[C, W]` is the posture of every other `/workers/me/*` route.
  {
    name: "WorkerActions",
    ctor: WorkerActionsController,
    routes: { record: [C, W], recordBatch: [C, W] },
  },
  // #997 — the worker's OWN feedback sink. Also a separate controller, for the same reason:
  // a class that can never acquire an ops guard can never be swept into `OPS_ROUTES`.
  // `[C, W]` is the posture of every other `/workers/me/*` route.
  {
    name: "WorkerFeedback",
    ctor: WorkerFeedbackController,
    // #1191 adds the attachment MINT to the same class, so it inherits the same class-level
    // pair — which is the point of listing it: a route added here can only ever be [C, W].
    routes: { submit: [C, W], createAttachmentUploadUrl: [C, W] },
  },
  {
    name: "Applications",
    ctor: ApplicationsController,
    routes: {
      feed: [C, W],
      apply: [C, W],
      skip: [C, W],
      myApplications: [C, W],
      applicants: [I],
      workerApplications: [I],
    },
  },
  {
    name: "Auth",
    ctor: AuthController,
    // ADR-0026 Phase 1: tokenRefresh stays guard-LESS (the refresh token in the body is the
    // credential — the access JWT may be expired); logoutAll + session are worker-authed.
    // A5 (ADR-0026 amendment): /auth/refresh adds ConsentNotRevokedGuard (block a REVOKED-consent
    // resume; a never-consented worker is still allowed). tokenRefresh enforces the SAME rule
    // in-controller (the worker is resolved from the token, not an authed request) — stays [].
    // D-3: testLogin rides TestLoginGuard — a NEUTRAL 404 while TEST_LOGIN_ENABLED is
    // off (the default) + an HMAC timing-safe x-test-login-token check when on; arming
    // it in production is a BOOT failure (assertAuthConfig). Never open.
    routes: {
      requestOtp: [],
      verifyOtp: [],
      testLogin: [TL],
      me: [W],
      refresh: [CNR, W],
      logout: [W],
      tokenRefresh: [],
      logoutAll: [W],
      session: [W],
    },
  },
  // P0 fix (PR #91): worker AI routes are worker-authed + consent-gated.
  { name: "Chat", ctor: ChatController, routes: { startSession: [C, W], postMessage: [C, W] } },
  { name: "Consent", ctor: ConsentController, routes: { accept: [W], withdraw: [W] } },
  { name: "Events", ctor: EventsController, routes: { list: [I] } },
  { name: "Health", ctor: HealthController, routes: { check: [] } },
  // The download is PUBLIC and stays public — the kit is per-trade, PII-free content a worker
  // must be able to reach before committing to the app. `OW` is attribution only (see its
  // declaration): it can allow, never deny, so the route's effective posture is unchanged.
  { name: "InterviewKit", ctor: InterviewKitController, routes: { download: [OW] } },
  // Worker-scoped job detail (ADR-0024 final addendum): GET /jobs/:jobId is
  // worker-authed + consent-gated, mirroring the /feed posture. Distinct surface
  // from the ops JobPostings rows below (which stay FORBIDDEN on the worker path).
  { name: "Jobs", ctor: JobsController, routes: { getJob: [C, W] } },
  {
    name: "JobPostings",
    ctor: JobPostingsController,
    // ADR-0036 Policy 27: `widenReach` is the ONE guarded route on this otherwise
    // alpha-open ops controller — widening a reach set changes which workers see a job
    // on a posting whose owner chose a narrower net, so it takes a STRICTER guard than
    // its siblings. #1213: the actor recorded in `job_reach_widen.ops_actor_id` used to
    // be a client-body-supplied uuid; it is now the AUTHENTICATED admin session's own
    // id, so `AdminAuthGuard` is ADDED on top of the existing `InternalServiceGuard`
    // (both required — the fix narrows who can reach this route, it does not widen it).
    routes: {
      create: [I],
      list: [I],
      getOne: [I],
      update: [I],
      close: [I],
      verify: [I],
      reject: [I],
      widenReach: [A, I],
    },
  },
  {
    name: "Messaging",
    ctor: MessagingController,
    routes: { createInvite: [W], recordClick: [], reengage: [I] },
  },
  {
    name: "Notifications",
    // #643 — `markRead` WRITES the worker's read watermark, so it takes the same
    // worker-self + consent posture as the feed it belongs to. It accepts no body and
    // no path param, so the token is the only id that can reach the service.
    ctor: NotificationsController,
    routes: { list: [C, W], markRead: [C, W] },
  },
  {
    // #643 — the worker's push toggle. Both routes are worker-self; the PATCH gates the
    // ADR-0034 fan-out, so an unguarded one would let a caller silence another worker.
    name: "NotificationPrefs",
    ctor: NotificationPrefsController,
    routes: { get: [C, W], update: [C, W] },
  },
  { name: "Capacity", ctor: CapacityController, routes: { buyCapacity: [I] } },
  { name: "PostingPlans", ctor: PostingPlansController, routes: { buyPlan: [I], buyBoost: [I] } },
  {
    name: "Pricing",
    ctor: PricingController,
    routes: { getCatalog: [I], updateCatalog: [I], quote: [I] },
  },
  { name: "AiJobs", ctor: AiJobsController, routes: { list: [I], get: [I] } },
  // The WORKER poll for the same rows — a separate controller precisely so it does NOT
  // inherit AiJobsController's class-level InternalServiceGuard (that union would drag it
  // into OPS_ROUTES via canary-coverage.test.ts and then fail prod-canary stage 4, which
  // sends the ops token and requires a non-401). Ownership is enforced in the query.
  { name: "WorkerAiJobs", ctor: WorkerAiJobsController, routes: { get: [C, W] } },
  // P0 fix (PR #91).
  { name: "Profiles", ctor: ProfilesController, routes: { extract: [C, W], confirm: [C, W] } },
  { name: "Reach", ctor: ReachController, routes: { applicants: [I], feed: [I] } },
  // PACE (ADR-0021) — ops-internal, guarded 2026-08-01. These were the LAST two
  // unauthenticated non-auth routes in the API: `alerts` served live supply intelligence
  // (it is not covered by `PACE_ENABLED` — `listOpsAlerts` never checks the flag), and
  // `start` is a reach-widening WRITE that would have armed on the flag flip.
  { name: "Pace", ctor: PaceController, routes: { start: [I], alerts: [I] } },
  // Self-serve PAYER surface (ADR-0019). signup/login are PUBLIC (external boundary);
  // refresh/logout + every unlock/reach route bind to the payer session (PayerAuthGuard).
  // The ops `/reach/*` + `/unlocks*` rows above stay their own principal (one per route).
  {
    name: "PayerAuth",
    ctor: PayerAuthController,
    // `testLogin` carries PayerTestLoginGuard and NOT PayerAuthGuard — it MINTS the session, so
    // requiring one would be circular. Its protection is the env gate + server secret + the
    // reserved-domain restriction, plus a boot guard that refuses to arm it outside dev/test/staging.
    routes: {
      signup: [],
      requestLogin: [],
      verifyLogin: [],
      testLogin: [PTL],
      refresh: [P],
      logout: [P],
    },
  },
  {
    // `createOrder` + `verifyPayment` are the REAL-payments routes (Razorpay). Same
    // PayerAuthGuard posture and same XB-A rule as their mock sibling `buyPack`: the
    // payer_id is the SESSION payer, the body carries only a pack code / the provider's
    // own ids, and never an amount. They additionally 404 NEUTRALLY while
    // PAYMENTS_ENABLE_REAL is off (the default) — a launch gate, not an auth gate.
    name: "PayerUnlocks",
    ctor: PayerUnlocksController,
    routes: {
      requestUnlock: [P],
      reveal: [P],
      listOwn: [P],
      ownCredits: [P],
      creditsLedger: [P],
      buyPack: [P],
      createOrder: [P],
      verifyPayment: [P],
    },
  },
  // PUBLIC Razorpay capture webhook. It CANNOT carry a session guard — Razorpay's servers
  // call it — so its one credential is the HMAC signature over the raw request bytes,
  // enforced by RazorpayWebhookGuard. Listing it here makes "this route is public except
  // for an HMAC" a recorded decision a reviewer sees in the diff, not an oversight.
  {
    name: "RazorpayWebhook",
    ctor: RazorpayWebhookController,
    routes: { webhook: [RZ] },
  },
  // Payer-self capacity view/buy (ADR-0019 + ADR-0016): session-bound, NO :payerId param.
  {
    name: "PayerCapacity",
    ctor: PayerCapacityController,
    routes: { ownCapacity: [P], buyCapacity: [P] },
  },
  { name: "PayerReach", ctor: PayerReachController, routes: { applicants: [P] } },
  // ADR-0036 — the Matching V1 posting-form surface. Both are PayerAuthGuard: neither
  // takes a payer_id anywhere (the reach counter is a property of worker supply, the
  // same for every payer), so there is no tenancy surface — the guard is there because
  // the vocabulary + live supply counts are commercial information, not public data.
  {
    name: "MatchSkills",
    ctor: MatchSkillsController,
    routes: { listSkills: [P], reachPreview: [P] },
  },
  // Payer-facing LIVE catalog read (D-6): read-only products projection, session-authed
  // like every other payer-web data fetch (the ops GET /pricing/catalog stays its own
  // principal above — it is slated for an admin guard and serves the FULL catalog).
  { name: "PayerPricing", ctor: PayerPricingController, routes: { getCatalog: [P] } },
  // Agency Supply Portal (ADR-0022): EVERY route is agent-only — the VERTICAL-authz
  // [PayerAuthGuard, PayerRoleGuard] chain (@PayerRoles('agent')). Tenant isolation
  // (jobs.payer_id / agency_invites.inviter_payer_id) is enforced separately in the
  // service via the payer-scope chokepoint (horizontal authz, not a guard).
  {
    name: "AgencyJobs",
    ctor: AgencyJobsController,
    routes: {
      create: [P, R],
      list: [P, R],
      getOne: [P, R],
      update: [P, R],
      close: [P, R],
      pause: [P, R],
      resume: [P, R],
    },
  },
  {
    name: "AgencyInvites",
    ctor: AgencyInvitesController,
    // `createInviteBatch` (ADR-0022 Amendment 3) is a NEW POST on this class — the classic
    // place a guard is forgotten. It writes N rows, so any tenancy slip is amplified N×;
    // it must resolve the SAME agent-only pair as the singular mint.
    routes: {
      createInvite: [P, R],
      createInviteBatch: [P, R],
      recordClick: [P, R],
      referralsSummary: [P, R],
    },
  },
  // B5 — the referred-worker ENGAGEMENT view. Agent-only, like every sibling. The
  // DPDP consent gate is NOT a guard: it lives in the repository's SQL, because a
  // worker who did not consent must be ABSENT from the result set rather than
  // produce a 403 (a 403 would be a consent oracle).
  {
    name: "AgencyWorkers",
    ctor: AgencyWorkersController,
    routes: { listReferred: [P, R] },
  },
  // Agency supply-money surface (ADR-0022 Amendment 2): agent-only [PayerAuthGuard,
  // PayerRoleGuard] PLUS the AgencyPayoutsEnabledGuard launch gate (neutral 404 while
  // AGENCY_PAYOUTS_ENABLED is OFF, the default). Tenant isolation is the session payer_id.
  {
    name: "AgencyPayouts",
    ctor: AgencyPayoutsController,
    routes: {
      submitKyc: [P, R, PE],
      getKyc: [P, R, PE],
      getEarnings: [P, R, PE],
      requestPayout: [P, R, PE],
      listPayouts: [P, R, PE],
    },
  },
  // OPS agency-KYC verify queue (ADR-0022 Amendment 2) — the apps/web ops console surface,
  // gated by the shared-secret InternalServiceGuard exactly like /pricing, /unlocks. NOT a
  // payer-facing guard; one principal per route. The list is masked (last-4 only).
  {
    name: "AgencyKycOps",
    ctor: AgencyKycOpsController,
    routes: { listPending: [I], verify: [I], reject: [I] },
  },
  // TD70 item 5 (2026-07-16): `generate` moved from OPEN to WorkerAuthGuard — the
  // acting worker_id is session-derived (XB-A); a legacy body worker_id must match
  // the session or the route 404s (no existence oracle, matching `download`).
  {
    // B-3: `generate` is CONSENT-GATED (§2 invariant 6) — it sends the worker's profile to
    // an LLM, so it is AI processing and carries [C, W] like every sibling worker-AI route
    // (chat / voice / profiles). It shipped [W]-only; the live hole was a worker who
    // WITHDREW consent still generating. See resume-consent.authz.test.ts.
    // `download` stays [W]: it mints a signed URL for an ALREADY-rendered PDF — serving a
    // worker their own artifact is not AI processing, and gating it on consent would
    // decide a DPDP data-access question that is the owner's, not this fix's.
    name: "Resume",
    ctor: ResumeController,
    routes: { generate: [C, W], get: [I], regenerate: [I], download: [W], share: [I] },
  },
  {
    name: "Unlocks",
    ctor: UnlocksController,
    routes: {
      requestUnlock: [I],
      reveal: [I],
      listUnlocks: [I],
      getUnlock: [I],
      getCredits: [I],
      purchaseCredits: [I],
    },
  },
  // P0 fix (PR #91).
  {
    name: "Voice",
    ctor: VoiceController,
    routes: { createUploadUrl: [C, W], upload: [C, W], transcribe: [C, W], get: [C, W] },
  },
  // setName (PUT :id/name) is the ops-style open route; setMyName (PATCH me/name)
  // is the worker-self capture — consent-gated (invariant #6), worker from the token.
  // getMyProfileSummary (GET me/profile-summary, TD54) is the worker-self summary
  // read — same [WorkerAuthGuard, ConsentGuard] posture, worker from the token.
  {
    name: "Workers",
    ctor: WorkersController,
    routes: {
      list: [I],
      getProfile: [I],
      setName: [I],
      setMyName: [C, W],
      getMyProfileSummary: [C, W],
    },
  },
  // Admin Ops Portal auth (ADR-0025 ADMIN-1, the 4th principal). The ONLY public routes are
  // the login request/verify + MFA verify (external untrusted boundary, IP-rate-limited);
  // every session route binds to the admin session (AdminAuthGuard). One principal per route.
  {
    name: "AdminAuth",
    ctor: AdminAuthController,
    routes: {
      requestLogin: [],
      verifyLogin: [],
      verifyMfa: [],
      refresh: [A],
      logout: [A],
      me: [A],
    },
  },
  // Admin Ops Portal READ-ONLY event-spine API (ADR-0025 ADMIN-2). EVERY route is behind the
  // admin session (AdminAuthGuard) + vertical RBAC (AdminRolesGuard, one @RequireAdminRole each):
  // the five reads need `read_events` (all roles); `export` needs the `export` capability
  // (super_admin/ops_admin only) — the per-role authz is asserted in admin-events authz tests.
  {
    name: "AdminEvents",
    ctor: AdminEventsController,
    routes: {
      list: [A, AR],
      metrics: [A, AR],
      export: [A, AR],
      trace: [A, AR],
      getOne: [A, AR],
      timeline: [A, AR],
    },
  },
  // Admin Ops Portal GOVERNED ENTITY ACTIONS (ADR-0025 ADMIN-3a). EVERY write route is behind
  // the admin session (AdminAuthGuard) + vertical RBAC (AdminRolesGuard, exactly one
  // @RequireAdminRole each): suspend_payer / grant_credits / force_close_posting / flag_worker
  // (super_admin+ops_admin) and manage_admins (super_admin ONLY). The per-capability authz is
  // asserted in admin-actions.authz.test.ts; the one-role-per-route + spine-immutability in the
  // static-guards test. One principal per route; the actor is the session admin, never a body.
  {
    name: "AdminActions",
    ctor: AdminActionsController,
    routes: {
      suspendPayer: [A, AR],
      reinstatePayer: [A, AR],
      grantCredits: [A, AR],
      forceClosePosting: [A, AR],
      flagWorker: [A, AR],
      unflagWorker: [A, AR],
      inviteAdmin: [A, AR],
      changeAdminRole: [A, AR],
      suspendAdmin: [A, AR],
    },
  },
  // Admin Ops Portal reason-gated worker-PII REVEAL (ADR-0025 ADMIN-3b). The single most sensitive
  // route — admin session (AdminAuthGuard) + vertical RBAC (AdminRolesGuard, @RequireAdminRole
  // "reveal_pii" = super_admin/support only). One principal + one role; actor = session admin,
  // target = validated path uuid. Behind the default-OFF ADMIN_PII_REVEAL_ENABLED flag (neutral 404).
  {
    name: "AdminPiiReveal",
    ctor: AdminPiiRevealController,
    routes: { revealContact: [A, AR] },
  },
  // 0083 — the AI-call-trace read. THREE guards, and the ORDER of the middle one is the
  // control rather than its presence: `AdminAiTraceFlagGuard` is declared BEFORE
  // `AdminRolesGuard`, so with ADMIN_AI_TRACE_READ_ENABLED off every authenticated role gets
  // the same neutral 404. When the flag check lived in the handler body instead, Nest ran the
  // roles guard first and ops_admin/support/analyst each got a 403 — an oracle confirming the
  // surface exists. Both routes are `read_ai_traces` (super_admin only) per the owner ruling.
  {
    name: "AdminAiTraces",
    ctor: AdminAiTracesController,
    routes: { list: [A, ATF, AR], readOne: [A, ATF, AR] },
  },
  // FORK-B-1 seam A (ADR-0030): the ai-service's ONLY api credential. SCOPED
  // SkillsInternalGuard (SKILLS_INTERNAL_TOKEN) by design — NOT InternalServiceGuard,
  // so this credential can never open the resume-PII/money routes (#222 review).
  {
    name: "Skills",
    ctor: SkillsController,
    routes: { nearestAliases: [SI], recordUnresolved: [SI] },
  },
  // Referral attribution (ADR-0020/0022): the invited_worker_id is the SESSION worker, so
  // a caller can only ever attribute THEMSELVES to a code (XB-A). B4 added an OPTIONAL
  // `source` to the body — the guard, the IP cap and the neutral response are unchanged.
  {
    name: "ReferralAttribution",
    ctor: ReferralAttributionController,
    routes: { attribute: [W] },
  },
  // MOCK ₹20 activation-bonus ledger (§X.6). OPS-INTERNAL only (InternalServiceGuard, the
  // shared-secret principal — fail-closed when unconfigured), deliberately NOT worker-facing:
  // this release accrues and disburses NOTHING, and showing a worker "₹20 earned" would be a
  // payment promise the platform cannot keep.
  {
    name: "ReferralBonus",
    ctor: ReferralBonusController,
    routes: { evaluate: [I], summary: [I] },
  },
  // BL-3 — the 17 controllers this contract omitted, closing the F1 finding
  // (docs/audit/15_SECURITY_AUDIT.md). Every one of the 17 was individually verified correct
  // in code before being added here; none of this is a fix, only a regression net.
  {
    name: "AdminDirectory",
    ctor: AdminDirectoryController,
    routes: { directory: [A, AR], capabilities: [A, AR] },
  },
  {
    name: "AdminEntities",
    ctor: AdminEntitiesController,
    routes: {
      listWorkers: [A, AR],
      getWorker: [A, AR],
      listPayers: [A, AR],
      getPayer: [A, AR],
      getPayerCredits: [A, AR],
      listJobPostings: [A, AR],
      getJobPosting: [A, AR],
      listApplications: [A, AR],
    },
  },
  // #997 — the admin half of worker feedback. Same [A, AR] posture as every other admin read;
  // what makes it worth its own entry is that it is the ONE non-faceless one, so a guard
  // quietly dropped here would expose worker-authored free text rather than an opaque id.
  {
    name: "AdminFeedback",
    ctor: AdminFeedbackController,
    routes: { list: [A, AR] },
  },
  {
    name: "AdminFinance",
    ctor: AdminFinanceController,
    routes: { summary: [A, AR], ledger: [A, AR], orders: [A, AR] },
  },
  // BP-5 — the dashboard summary (platform AI spend + volume). Enrolled ON ARRIVAL rather than
  // in a later sweep: F1 (docs/audit/15_SECURITY_AUDIT.md) exists because 17 controllers were
  // added without it, and a route that joins the app outside this contract has no regression net
  // the day someone edits its decorators.
  {
    name: "AdminDashboard",
    ctor: AdminDashboardController,
    routes: { summary: [A, AR] },
  },
  // Phase 6 — the per-worker journey reads. Same [A, AR] as every other admin controller;
  // the capability (`read_entities`) is asserted in admin-worker-journey.authz.test.ts, since
  // role scoping is not this contract's concern.
  {
    name: "AdminWorkerJourney",
    ctor: AdminWorkerJourneyController,
    routes: {
      getJourneySummary: [A, AR],
      listChatSessions: [A, AR],
      getChatSession: [A, AR],
    },
  },
  // super_admin-only via @RequireAdminRole (role scoping isn't this contract's concern — it
  // asserts guard CLASSES, the same [A, AR] every admin controller carries).
  {
    name: "AdminKillSwitch",
    ctor: AdminKillSwitchController,
    routes: { status: [A, AR], requestPause: [A, AR] },
  },
  {
    name: "Devices",
    ctor: DevicesController,
    routes: { list: [W], updatePushToken: [W], revoke: [W] },
  },
  // R25: verify/reset/* are DELIBERATELY guard-less -- the PIN itself is the credential in the
  // body, so a session guard would be redundant with (and weaker than) the PIN check.
  {
    name: "Pin",
    ctor: PinController,
    routes: { set: [W], verify: [], resetRequest: [], resetConfirm: [] },
  },
  {
    name: "Profiling",
    ctor: ProfilingController,
    routes: {
      start: [C, W],
      answer: [C, W],
      review: [C, W],
      correct: [C, W],
      finalize: [C, W],
    },
  },
  {
    name: "ResumeDisclosure",
    ctor: ResumeDisclosureController,
    routes: { requestDisclosure: [I], listDisclosures: [I] },
  },
  {
    name: "Occupation",
    ctor: OccupationController,
    routes: { resolve: [SI], questionPack: [SI], recordUnresolved: [SI], domain: [SI] },
  },
  // Deliberate, PII-free static content, per-IP rate-limited (TD24 precedent) -- open by design.
  {
    name: "InterviewKits",
    ctor: InterviewKitsController,
    routes: { list: [], detail: [] },
  },
  // Deliberate public no-oracle redirect, per-IP rate-limited -- open by design.
  {
    name: "ReferralResolver",
    ctor: ReferralResolverController,
    routes: { resolve: [] },
  },
  {
    name: "JobPostingChat",
    ctor: JobPostingChatController,
    routes: {
      startSession: [P],
      postMessage: [P],
      listSessions: [P],
      listMessages: [P],
      publish: [P],
    },
  },
  {
    name: "PayerDisclosure",
    ctor: PayerDisclosureController,
    routes: { request: [P], listOwn: [P] },
  },
  {
    name: "PayerJobPostings",
    ctor: PayerJobPostingsController,
    routes: {
      create: [P],
      list: [P],
      getOne: [P],
      update: [P],
      close: [P],
      pause: [P],
      resume: [P],
      buyPlan: [P],
      buyBoost: [P],
      topUpQuota: [P],
    },
  },
  { name: "PayerOrgInvites", ctor: PayerOrgInvitesController, routes: { accept: [P] } },
  {
    name: "PayerOrgMembers",
    ctor: PayerOrgMembersController,
    routes: { list: [P, POR], invite: [P, POR], remove: [P, POR] },
  },
  {
    name: "PayerAccount",
    ctor: PayerAccountController,
    routes: { me: [P], updateMe: [P] },
  },
];

describe("API authz contract — guards on every controller route", () => {
  for (const { name, ctor, routes } of CONTRACT) {
    describe(`${name}Controller`, () => {
      for (const [method, expected] of Object.entries(routes)) {
        it(`${method} → [${expected.join(", ") || "open"}]`, () => {
          expect(effectiveGuards(ctor, method)).toEqual([...expected].sort());
        });
      }
    });
  }

  it("the contract enumerates a real handler for every listed route", () => {
    for (const { name, ctor, routes } of CONTRACT) {
      for (const method of Object.keys(routes)) {
        expect(
          typeof (ctor.prototype as Record<string, unknown>)[method],
          `${name}Controller.${method} must exist`,
        ).toBe("function");
      }
    }
  });

  // The consent-gated worker-AI controllers MUST run WorkerAuthGuard BEFORE
  // ConsentGuard (ConsentGuard reads req.worker, which WorkerAuthGuard attaches).
  // `effectiveGuards` sorts, so it can't see order — assert it here against the raw
  // (unsorted) class metadata.
  describe("consent-gated worker-AI guard ORDER (auth before consent)", () => {
    for (const { name, ctor } of [
      { name: "Chat", ctor: ChatController },
      { name: "Profiles", ctor: ProfilesController },
      { name: "Voice", ctor: VoiceController },
      // #997 — not an AI surface, but it carries the SAME class-level pair and so the same
      // ordering hazard: `ConsentGuard` reads `req.worker`, which `WorkerAuthGuard` attaches.
      { name: "WorkerFeedback", ctor: WorkerFeedbackController },
    ]) {
      it(`${name}Controller runs [WorkerAuthGuard, ConsentGuard] in order`, () => {
        expect(guardNames(ctor)).toEqual(["WorkerAuthGuard", "ConsentGuard"]);
      });
    }

    // WorkersController.setMyName applies the guards at the METHOD level (the
    // controller also has open ops routes), so assert the order on the handler.
    it("WorkersController.setMyName runs [WorkerAuthGuard, ConsentGuard] in order", () => {
      const handler = (WorkersController.prototype as unknown as Record<string, object>).setMyName;
      expect(guardNames(handler)).toEqual(["WorkerAuthGuard", "ConsentGuard"]);
    });

    // Same method-level posture for the TD54 worker-self summary read.
    it("WorkersController.getMyProfileSummary runs [WorkerAuthGuard, ConsentGuard] in order", () => {
      const handler = (WorkersController.prototype as unknown as Record<string, object>)
        .getMyProfileSummary;
      expect(guardNames(handler)).toEqual(["WorkerAuthGuard", "ConsentGuard"]);
    });

    // Worker-scoped job detail read (ADR-0024 final addendum) — method-level
    // guards, same auth-before-consent order as the other worker routes.
    it("JobsController.getJob runs [WorkerAuthGuard, ConsentGuard] in order", () => {
      const handler = (JobsController.prototype as unknown as Record<string, object>).getJob;
      expect(guardNames(handler)).toEqual(["WorkerAuthGuard", "ConsentGuard"]);
    });

    // The worker AI-job poll. Order matters here as everywhere, but so does the
    // NEGATIVE: this controller must never acquire InternalServiceGuard, because the
    // union with a worker guard is what would break the prod-canary contract.
    it("WorkerAiJobsController.get runs [WorkerAuthGuard, ConsentGuard] in order", () => {
      const handler = (WorkerAiJobsController.prototype as unknown as Record<string, object>).get;
      expect(guardNames(handler)).toEqual(["WorkerAuthGuard", "ConsentGuard"]);
    });

    it("WorkerAiJobsController carries NO class-level guard (never InternalServiceGuard)", () => {
      expect(guardNames(WorkerAiJobsController)).toEqual([]);
    });
  });
});
