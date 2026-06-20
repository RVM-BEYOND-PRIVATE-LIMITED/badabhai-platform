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
import { PayerReachController } from "../payer-portal/payer-reach.controller";

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

const CONTRACT: ControllerContract[] = [
  { name: "Actions", ctor: ActionsController, routes: { record: [], recordBatch: [] } },
  {
    name: "Applications",
    ctor: ApplicationsController,
    routes: {
      feed: [C, W],
      apply: [C, W],
      skip: [C, W],
      applicants: [I],
      workerApplications: [I],
    },
  },
  {
    name: "Auth",
    ctor: AuthController,
    routes: { requestOtp: [], verifyOtp: [], me: [W], refresh: [W], logout: [W] },
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
  { name: "PostingPlans", ctor: PostingPlansController, routes: { buyPlan: [], buyBoost: [] } },
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
    routes: { requestUnlock: [P], reveal: [P], listOwn: [P], ownCredits: [P] },
  },
  { name: "PayerReach", ctor: PayerReachController, routes: { applicants: [P] } },
  {
    name: "Resume",
    ctor: ResumeController,
    routes: { generate: [], get: [I], regenerate: [I], download: [W], share: [I] },
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
  { name: "Voice", ctor: VoiceController, routes: { upload: [C, W], transcribe: [C, W] } },
  { name: "Workers", ctor: WorkersController, routes: { list: [], getProfile: [], setName: [] } },
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
  });
});
