import "reflect-metadata";
import { describe, it, expect } from "vitest";

// Every controller in apps/api. Importing them here also proves they compile +
// their metadata is well-formed.
import { ActionsController } from "../actions/actions.controller";
import { ApplicationsController } from "../applications/applications.controller";
import { AuthController } from "../auth/auth.controller";
import { ChatController } from "../chat/chat.controller";
import { ConsentController } from "../consent/consent.controller";
import { EventsController } from "../events/events.controller";
import { HealthController } from "../health/health.controller";
import { InterviewKitController } from "../interview-kit/interview-kit.controller";
import { JobPostingsController } from "../job-postings/job-postings.controller";
import { MessagingController } from "../messaging/messaging.controller";
import { CapacityController } from "../posting-plans/capacity.controller";
import { PostingPlansController } from "../posting-plans/posting-plans.controller";
import { PricingController } from "../pricing/pricing.controller";
import { AiJobsController } from "../profiles/ai-jobs.controller";
import { ProfilesController } from "../profiles/profiles.controller";
import { ReachController } from "../reach/reach.controller";
import { ResumeController } from "../resume/resume.controller";
import { UnlocksController } from "../unlocks/unlocks.controller";
import { VoiceController } from "../voice/voice.controller";
import { WorkersController } from "../workers/workers.controller";
import { PayerAuthController } from "../payer-portal/payer-auth.controller";
import { PayerUnlocksController } from "../payer-portal/payer-unlocks.controller";
import { PayerCapacityController } from "../payer-portal/payer-capacity.controller";
import { PayerReachController } from "../payer-portal/payer-reach.controller";
import { AgencyJobsController } from "../agency/agency-jobs.controller";
import { AgencyInvitesController } from "../agency/agency-invites.controller";
import { AdminAuthController } from "../admin/admin-auth.controller";
import { AdminEventsController } from "../admin/admin-events.controller";
import { AdminActionsController } from "../admin/admin-actions.controller";
import { AdminPiiRevealController } from "../admin/admin-pii-reveal.controller";
import { SkillsController } from "../skills/skills.controller";

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

const CONTRACT: ControllerContract[] = [
  { name: "Actions", ctor: ActionsController, routes: { record: [], recordBatch: [] } },
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
    routes: {
      requestOtp: [],
      verifyOtp: [],
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
  { name: "Consent", ctor: ConsentController, routes: { accept: [] } },
  { name: "Events", ctor: EventsController, routes: { list: [] } },
  { name: "Health", ctor: HealthController, routes: { check: [] } },
  { name: "InterviewKit", ctor: InterviewKitController, routes: { download: [] } },
  {
    name: "JobPostings",
    ctor: JobPostingsController,
    routes: { create: [], list: [], getOne: [], update: [], close: [] },
  },
  {
    name: "Messaging",
    ctor: MessagingController,
    routes: { createInvite: [W], recordClick: [], reengage: [I] },
  },
  { name: "Capacity", ctor: CapacityController, routes: { buyCapacity: [I] } },
  { name: "PostingPlans", ctor: PostingPlansController, routes: { buyPlan: [I], buyBoost: [I] } },
  {
    name: "Pricing",
    ctor: PricingController,
    routes: { getCatalog: [], updateCatalog: [], quote: [] },
  },
  { name: "AiJobs", ctor: AiJobsController, routes: { list: [], get: [] } },
  // P0 fix (PR #91).
  { name: "Profiles", ctor: ProfilesController, routes: { extract: [C, W], confirm: [C, W] } },
  { name: "Reach", ctor: ReachController, routes: { applicants: [], feed: [] } },
  // Self-serve PAYER surface (ADR-0019). signup/login are PUBLIC (external boundary);
  // refresh/logout + every unlock/reach route bind to the payer session (PayerAuthGuard).
  // The ops `/reach/*` + `/unlocks*` rows above stay their own principal (one per route).
  {
    name: "PayerAuth",
    ctor: PayerAuthController,
    routes: { signup: [], requestLogin: [], verifyLogin: [], refresh: [P], logout: [P] },
  },
  {
    name: "PayerUnlocks",
    ctor: PayerUnlocksController,
    routes: {
      requestUnlock: [P],
      reveal: [P],
      listOwn: [P],
      ownCredits: [P],
      creditsLedger: [P],
      buyPack: [P],
    },
  },
  // Payer-self capacity view/buy (ADR-0019 + ADR-0016): session-bound, NO :payerId param.
  {
    name: "PayerCapacity",
    ctor: PayerCapacityController,
    routes: { ownCapacity: [P], buyCapacity: [P] },
  },
  { name: "PayerReach", ctor: PayerReachController, routes: { applicants: [P] } },
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
    },
  },
  {
    name: "AgencyInvites",
    ctor: AgencyInvitesController,
    routes: { createInvite: [P, R], recordClick: [P, R], referralsSummary: [P, R] },
  },
  // TD70 item 5 (2026-07-16): `generate` moved from OPEN to WorkerAuthGuard — the
  // acting worker_id is session-derived (XB-A); a legacy body worker_id must match
  // the session or the route 404s (no existence oracle, matching `download`).
  {
    name: "Resume",
    ctor: ResumeController,
    routes: { generate: [W], get: [I], regenerate: [I], download: [W], share: [I] },
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
      list: [],
      getProfile: [],
      setName: [],
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
    routes: { requestLogin: [], verifyLogin: [], verifyMfa: [], refresh: [A], logout: [A], me: [A] },
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
  // FORK-B-1 seam A (ADR-0030): the ai-service's ONLY api credential. SCOPED
  // SkillsInternalGuard (SKILLS_INTERNAL_TOKEN) by design — NOT InternalServiceGuard,
  // so this credential can never open the resume-PII/money routes (#222 review).
  {
    name: "Skills",
    ctor: SkillsController,
    routes: { nearestAliases: [SI], recordUnresolved: [SI] },
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
    ]) {
      it(`${name}Controller runs [WorkerAuthGuard, ConsentGuard] in order`, () => {
        expect(guardNames(ctor)).toEqual(["WorkerAuthGuard", "ConsentGuard"]);
      });
    }

    // WorkersController.setMyName applies the guards at the METHOD level (the
    // controller also has open ops routes), so assert the order on the handler.
    it("WorkersController.setMyName runs [WorkerAuthGuard, ConsentGuard] in order", () => {
      const handler = (WorkersController.prototype as unknown as Record<string, object>)
        .setMyName;
      expect(guardNames(handler)).toEqual(["WorkerAuthGuard", "ConsentGuard"]);
    });

    // Same method-level posture for the TD54 worker-self summary read.
    it("WorkersController.getMyProfileSummary runs [WorkerAuthGuard, ConsentGuard] in order", () => {
      const handler = (WorkersController.prototype as unknown as Record<string, object>)
        .getMyProfileSummary;
      expect(guardNames(handler)).toEqual(["WorkerAuthGuard", "ConsentGuard"]);
    });
  });
});
