import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, or } from "drizzle-orm";
import {
  applications,
  chatSessions,
  createDbClient,
  events,
  generatedResumes,
  jobPostings,
  questionPackItems,
  questionPacks,
  workerDevices,
  workerOccupations,
  workerPackAnswers,
  workerProfiles,
  workers,
  type DbClient,
} from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import type { LanguageCode } from "@badabhai/types";
import type { EventsService } from "../events/events.service";
import type { RequestContext } from "../common/request-context";
import { AdminEventsRepository } from "./admin-events.repository";
import { AdminFunnelRepository } from "./admin-funnel.repository";
import { AdminFunnelService } from "./admin-funnel.service";
import { AdminWorkerJourneyRepository } from "./admin-worker-journey.repository";
import { AdminWorkerJourneyService } from "./admin-worker-journey.service";

/**
 * B14 (#2568) — THE PARITY GATE. Totals match the per-worker journey for a seeded cohort.
 *
 * WHAT THIS PROVES. `AdminFunnelService` restates the per-worker journey's 7 status
 * rules over grouped aggregates (one worker's rows and the whole base's cannot share
 * code without one side paying the other's query shape). Restatements drift. This test
 * seeds ONE cohort covering every step outcome — bare, mid-interview, complete,
 * stopped-at-every-step, city-seeded, test-account, out-of-window — runs BOTH
 * surfaces, and asserts the 7 statuses equal worker for worker, then asserts the
 * aggregate counts equal the per-worker sums.
 *
 * A rule changed on one side without the other reddens this file, which is the whole
 * point: it is the anti-drift device the two implementations share instead of code.
 *
 * ── HOW TO RUN ───────────────────────────────────────────────────────────────────
 *   pnpm db:migrate && pnpm --filter @badabhai/db db:seed:packs --apply
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test admin-funnel.parity.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

// The cohort. Created inside the window [2026-09-01, 2026-10-01) except OUT (2020)
// and TEST (a test account, excluded by default).
const W1_BARE = uuid(0xb001);
const W2_STARTED = uuid(0xb002);
const W3_COMPLETE = uuid(0xb003);
const W4_STOPS_PROFILE = uuid(0xb004);
const W5_STOPS_PROFILE_EXTRACTING = uuid(0xb005);
const W6_STOPS_PHOTO = uuid(0xb006);
const W7_STOPS_KIT = uuid(0xb007);
const W8_TEST = uuid(0xb008);
const W9_OUTSIDE = uuid(0xb009);
const W10_CITY_SEED = uuid(0xb00a);
const W11_OTHER_TRADE = uuid(0xb00b);
const W12_BARE = uuid(0xb00c);
const ADMIN = uuid(0xb00d);
const CORR = uuid(0xb00e);

const CTX: RequestContext = { correlationId: CORR, requestId: uuid(0xb00f) };
const CONFIG = { PROFILING_PACK_LOCALE: "hi-IN" } as unknown as ServerConfig;

const OCCUPATION_PACK = "qp_welding";
const UNIVERSAL_PACK = "qp_universal";

const WINDOW_FROM = new Date("2026-09-10T00:00:00.000Z");
const WINDOW_TO = new Date("2026-09-11T00:00:00.000Z");
const SIGNUP_AT = new Date("2026-09-10T00:00:00.000Z");

describe.skipIf(!RUN)("admin funnel parity — totals match the per-worker journey", () => {
  let client!: DbClient;
  let journey!: AdminWorkerJourneyService;
  let funnel!: AdminFunnelService;
  let occupationVersion = 1;
  let universalVersion = 1;
  let occupationKeys: string[] = [];
  let universalKeys: string[] = [];

  async function cleanup(): Promise<void> {
    for (const id of [
      W1_BARE,
      W2_STARTED,
      W3_COMPLETE,
      W4_STOPS_PROFILE,
      W5_STOPS_PROFILE_EXTRACTING,
      W6_STOPS_PHOTO,
      W7_STOPS_KIT,
      W8_TEST,
      W9_OUTSIDE,
      W10_CITY_SEED,
      W11_OTHER_TRADE,
      W12_BARE,
    ]) {
      await client.db.delete(workers).where(eq(workers.id, id));
    }
    await client.db
      .delete(jobPostings)
      .where(
        or(
          eq(jobPostings.orgLabel, "funnel-parity-org"),
          eq(jobPostings.orgLabel, "funnel-parity-org-2"),
        ),
      );
    await client.db.delete(events).where(eq(events.correlationId, CORR));
  }

  beforeAll(async () => {
    if (!RUN) return;
    client = createDbClient(DATABASE_URL, { max: 1 });
    const eventsRepo = new AdminEventsRepository(client.db);
    const journeyRepo = new AdminWorkerJourneyRepository(client.db);
    // The audit emission is STUBBED, and only here — the per-worker summary emits
    // `admin.worker_journey_viewed` fail-closed before it reads. This suite is about
    // status equality, not the audit trail (the unit suite pins that).
    const auditStub = { emit: async () => ({}) } as unknown as EventsService;
    journey = new AdminWorkerJourneyService(journeyRepo, eventsRepo, auditStub, CONFIG);
    funnel = new AdminFunnelService(
      new AdminFunnelRepository(client.db),
      eventsRepo,
      journeyRepo,
      CONFIG,
    );

    // The ACTIVE versions carry the interview — read, never hard-coded, so a re-seed
    // moves the expectation with it rather than reddening this file.
    const active = await client.db
      .select({ packId: questionPacks.packId, version: questionPacks.version })
      .from(questionPacks)
      .where(and(eq(questionPacks.status, "active"), eq(questionPacks.locale, "hi-IN")));
    const occ = active.find((p) => p.packId === OCCUPATION_PACK);
    const uni = active.find((p) => p.packId === UNIVERSAL_PACK);
    expect(occ, "seeded qp_welding must have an active version").toBeDefined();
    expect(uni, "seeded qp_universal must have an active version").toBeDefined();
    if (!occ || !uni) throw new Error("seed packs missing");
    occupationVersion = occ.version;
    universalVersion = uni.version;

    const keysOf = async (packId: string, version: number): Promise<string[]> => {
      const rows = await client.db
        .select({ key: questionPackItems.questionKey })
        .from(questionPackItems)
        .where(
          and(eq(questionPackItems.packId, packId), eq(questionPackItems.packVersion, version)),
        );
      return rows.map((r) => r.key);
    };
    occupationKeys = await keysOf(OCCUPATION_PACK, occupationVersion);
    universalKeys = await keysOf(UNIVERSAL_PACK, universalVersion);
    expect(occupationKeys.length).toBeGreaterThan(0);
    expect(universalKeys.length).toBeGreaterThan(0);
    // The city-seed worker needs `current_city` to be a question the universal pack
    // actually asks — otherwise its credit has nowhere to land and the test would pass
    // vacuously.
    expect(universalKeys).toContain("current_city");

    await cleanup();

    let n = 0;
    const mkWorker = (
      id: string,
      over: {
        currentCity?: string | null;
        preferredLanguage?: LanguageCode | null;
        createdAt?: Date;
        isTestAccount?: boolean;
      } = {},
    ) => ({
      id,
      phoneE164: `funnel-parity-${process.pid}-${(n += 1)}`,
      phoneHash: `funnel-parity-hash-${process.pid}-${n}`,
      status: "active" as const,
      createdAt: SIGNUP_AT,
      isTestAccount: false,
      currentCity: null as string | null,
      preferredLanguage: null as LanguageCode | null,
      ...over,
    });
    await client.db.insert(workers).values([
      mkWorker(W1_BARE, { currentCity: "Pune", preferredLanguage: "hi" }),
      mkWorker(W2_STARTED, { currentCity: "Pune", preferredLanguage: "hi" }),
      mkWorker(W3_COMPLETE, { currentCity: "Pune", preferredLanguage: "hi" }),
      // W4 HAS a resume but only a draft profile — stops at profile_confirmed.
      mkWorker(W4_STOPS_PROFILE, { currentCity: "Pune", preferredLanguage: "hi" }),
      mkWorker(W5_STOPS_PROFILE_EXTRACTING, { currentCity: "Pune", preferredLanguage: "hi" }),
      mkWorker(W6_STOPS_PHOTO, { currentCity: "Pune", preferredLanguage: "hi" }),
      mkWorker(W7_STOPS_KIT, { currentCity: "Pune", preferredLanguage: "hi" }),
      mkWorker(W8_TEST, { currentCity: "Pune", preferredLanguage: "hi", isTestAccount: true }),
      mkWorker(W9_OUTSIDE, {
        currentCity: "Pune",
        preferredLanguage: "hi",
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
      }),
      mkWorker(W10_CITY_SEED, { currentCity: "Pune", preferredLanguage: "hi" }),
      mkWorker(W11_OTHER_TRADE, { currentCity: "Delhi", preferredLanguage: null }),
      mkWorker(W12_BARE, { currentCity: "Pune", preferredLanguage: "hi" }),
    ]);
    // Primary trade = lowest sort_order. Nine welders, one tailor.
    await client.db
      .insert(workerOccupations)
      .values([
        ...[
          W1_BARE,
          W2_STARTED,
          W3_COMPLETE,
          W4_STOPS_PROFILE,
          W5_STOPS_PROFILE_EXTRACTING,
          W6_STOPS_PHOTO,
          W7_STOPS_KIT,
          W10_CITY_SEED,
          W12_BARE,
        ].map((workerId) => ({ workerId, roleId: "role_welder", sortOrder: 0 })),
        { workerId: W11_OTHER_TRADE, roleId: "role_tailor", sortOrder: 0 },
      ]);
    // App versions for the five workers the version split will show.
    for (const workerId of [
      W3_COMPLETE,
      W4_STOPS_PROFILE,
      W5_STOPS_PROFILE_EXTRACTING,
      W6_STOPS_PHOTO,
      W7_STOPS_KIT,
    ]) {
      await client.db.insert(workerDevices).values({
        workerId,
        deviceHash: `funnel-parity-device-${workerId}`,
        appVersion: "2.4.1",
      });
    }

    // Interview sessions (ended) for every worker that answers anything. W10's carries
    // the city seed on its own persisted state.
    const sessionFor: Record<string, string> = {};
    const sessions: Array<{ workerId: string; seedCity: boolean }> = [
      { workerId: W2_STARTED, seedCity: false },
      { workerId: W3_COMPLETE, seedCity: false },
      { workerId: W4_STOPS_PROFILE, seedCity: false },
      { workerId: W5_STOPS_PROFILE_EXTRACTING, seedCity: false },
      { workerId: W6_STOPS_PHOTO, seedCity: false },
      { workerId: W7_STOPS_KIT, seedCity: false },
      { workerId: W10_CITY_SEED, seedCity: true },
    ];
    for (const { workerId, seedCity } of sessions) {
      const sessionId = uuid(0xc000 + n++);
      sessionFor[workerId] = sessionId;
      await client.db.insert(chatSessions).values({
        id: sessionId,
        workerId,
        status: "ended",
        packId: OCCUPATION_PACK,
        packVersion: occupationVersion,
        ...(seedCity ? { conversationState: { prefilled_keys: ["current_city"] } } : {}),
      });
    }

    // Settled answers, stamped with the occupation pack exactly as the flush writes
    // them (universal answers carry the occupation pack id — see the journey header).
    const answer = (workerId: string, questionKey: string) => {
      const sessionId = sessionFor[workerId];
      if (!sessionId) throw new Error(`no session for ${workerId}`);
      return {
        workerId,
        chatSessionId: sessionId,
        packId: OCCUPATION_PACK,
        packVersion: occupationVersion,
        questionKey,
        answerText: "x",
        status: "answered" as const,
        source: "chat" as const,
      };
    };
    // W2: one answered key (in progress).
    const firstOccupationKey = occupationKeys[0];
    if (!firstOccupationKey) throw new Error("occupation pack has no items");
    await client.db.insert(workerPackAnswers).values([answer(W2_STARTED, firstOccupationKey)]);
    // W3..W7: every key of both packs (profiling complete).
    for (const workerId of [
      W3_COMPLETE,
      W4_STOPS_PROFILE,
      W5_STOPS_PROFILE_EXTRACTING,
      W6_STOPS_PHOTO,
      W7_STOPS_KIT,
    ]) {
      await client.db
        .insert(workerPackAnswers)
        .values([
          ...occupationKeys.map((k) => answer(workerId, k)),
          ...universalKeys.map((k) => answer(workerId, k)),
        ]);
    }
    // W10: every key EXCEPT current_city (the seed credits exactly that one).
    await client.db
      .insert(workerPackAnswers)
      .values([
        ...occupationKeys.map((k) => answer(W10_CITY_SEED, k)),
        ...universalKeys.filter((k) => k !== "current_city").map((k) => answer(W10_CITY_SEED, k)),
      ]);

    // Profiles + resumes. Resume generation needs a profile row (FK), so every resume
    // worker gets one; the STATUS is what differs.
    const withProfile = async (
      workerId: string,
      profileStatus: "confirmed" | "extracted" | "draft",
      withResume: boolean,
    ): Promise<void> => {
      const inserted = await client.db
        .insert(workerProfiles)
        .values({ workerId, profileStatus })
        .returning({ id: workerProfiles.id });
      const profileId = inserted[0]?.id;
      if (!profileId) throw new Error(`profile insert failed for ${workerId}`);
      if (profileStatus === "confirmed") {
        await client.db
          .update(workerProfiles)
          .set({ confirmedAt: new Date("2026-09-11T00:00:00.000Z") })
          .where(eq(workerProfiles.id, profileId));
      }
      if (withResume) {
        await client.db.insert(generatedResumes).values({ workerId, profileId, resumeText: "x" });
      }
    };
    await withProfile(W3_COMPLETE, "confirmed", true);
    await withProfile(W4_STOPS_PROFILE, "draft", true);
    await withProfile(W5_STOPS_PROFILE_EXTRACTING, "extracted", true);
    await withProfile(W6_STOPS_PHOTO, "confirmed", true);
    await withProfile(W7_STOPS_KIT, "confirmed", true);

    // Applications need a job reference (applications_job_ref_chk). Two postings: W6
    // applies on one and skips on the other, because (worker, posting) is unique —
    // a decision is last-write-wins, so one row cannot be both.
    const postings = await client.db
      .insert(jobPostings)
      .values([
        {
          createdBy: uuid(0xd001),
          orgLabel: "funnel-parity-org",
          roleTitle: "welder",
          vacancyBand: "2-5",
        },
        {
          createdBy: uuid(0xd002),
          orgLabel: "funnel-parity-org-2",
          roleTitle: "tailor",
          vacancyBand: "2-5",
        },
      ])
      .returning({ id: jobPostings.id });
    const postingA = postings[0]?.id;
    const postingB = postings[1]?.id;
    if (!postingA || !postingB) throw new Error("seed postings insert failed");
    for (const workerId of [W3_COMPLETE, W6_STOPS_PHOTO, W7_STOPS_KIT]) {
      await client.db
        .insert(applications)
        .values({ workerId, jobPostingId: postingA, action: "applied" });
    }
    await client.db
      .insert(applications)
      .values({ workerId: W6_STOPS_PHOTO, jobPostingId: postingB, action: "skipped" });

    // Photos: W3 + W7 (W6 stops at photo, W7 stops at the kit).
    for (const workerId of [W3_COMPLETE, W7_STOPS_KIT]) {
      await client.db
        .update(workers)
        .set({ photoStorageKey: `funnel-parity-photo-${workerId}` })
        .where(eq(workers.id, workerId));
    }

    // Spine rows the funnel reads (inserted directly — no emitter involved).
    const evt = (over: Record<string, unknown>) => ({
      eventName: "",
      eventVersion: 1,
      occurredAt: new Date("2026-09-11T00:00:00.000Z"),
      actorType: "worker",
      subjectType: "worker",
      correlationId: CORR,
      payload: {},
      ...over,
    });
    // Search events for W3/W6/W7 (their apply already decides step 5; the search proves
    // the in-progress leg is not double-counted) and for nobody else.
    for (const workerId of [W3_COMPLETE, W6_STOPS_PHOTO, W7_STOPS_KIT]) {
      await client.db.insert(events).values(
        evt({
          eventName: "job.search_performed",
          actorId: workerId,
          subjectId: workerId,
        }),
      );
    }
    // Kit downloads attributed to W3 only. W7 has everything EXCEPT the kit — the
    // stopped-at-interview_kit case — so it must NOT appear here.
    for (const workerId of [W3_COMPLETE]) {
      await client.db.insert(events).values(
        evt({
          eventName: "interview_kit.downloaded",
          subjectType: "interview_kit",
          subjectId: null,
          payload: { worker_id: workerId, trade_key: "welding" },
        }),
      );
    }
  });

  afterAll(async () => {
    if (!client) return;
    await cleanup();
    await client.sql.end({ timeout: 5 });
  });

  it("per-worker statuses equal the per-worker journey summaries", async () => {
    const funnelStatuses = await funnel.funnelWorkerStatuses({
      signupFrom: WINDOW_FROM,
      signupTo: WINDOW_TO,
      testAccounts: "exclude",
    });
    const byWorker = new Map(funnelStatuses.map((s) => [s.workerId, s.statuses]));
    expect(byWorker.size).toBe(10);

    for (const id of [
      W1_BARE,
      W2_STARTED,
      W3_COMPLETE,
      W4_STOPS_PROFILE,
      W5_STOPS_PROFILE_EXTRACTING,
      W6_STOPS_PHOTO,
      W7_STOPS_KIT,
      W10_CITY_SEED,
      W11_OTHER_TRADE,
      W12_BARE,
    ]) {
      const summary = await journey.getJourneySummary(ADMIN, id, CTX);
      const expected = Object.fromEntries(summary.steps.map((s) => [s.key, s.status]));
      expect(byWorker.get(id), `funnel statuses for ${id}`).toEqual(expected);
    }
  });

  it("aggregate counts equal the per-worker sums, with the expected stops", async () => {
    const res = await funnel.onboardingFunnel({
      signupFrom: WINDOW_FROM,
      signupTo: WINDOW_TO,
      testAccounts: "exclude",
    });

    expect(res.total_workers).toBe(10);
    const step = (key: string) => res.steps.find((s) => s.key === key)!;
    // login always done; profiling 6 done (W3,W4,W5,W6,W7,W10) / 1 in_progress (W2) /
    // 3 not_done (W1,W11,W12 — never started).
    expect(step("login")).toMatchObject({ done: 10, in_progress: 0, not_done: 0 });
    expect(step("profiling")).toMatchObject({ done: 6, in_progress: 1, not_done: 3 });
    // Resume: W3,W4,W5,W6,W7.
    expect(step("resume")).toMatchObject({ done: 5, in_progress: 0, not_done: 5 });
    // Profile: confirmed W3,W6,W7; extracting W5.
    expect(step("profile_confirmed")).toMatchObject({ done: 3, in_progress: 1, not_done: 6 });
    // Apply: W3,W6,W7.
    expect(step("job_search_apply")).toMatchObject({ done: 3, in_progress: 0, not_done: 7 });
    // Photo: W3,W7.
    expect(step("photo")).toMatchObject({ done: 2, in_progress: 0, not_done: 8 });
    // Kit: W3 only (W7 has everything except the kit).
    expect(step("interview_kit")).toMatchObject({ done: 1, in_progress: 0, not_done: 9 });

    const stop = Object.fromEntries(res.stopped_at.map((b) => [b.key, b.count]));
    expect(stop).toEqual({
      login: 0,
      profiling: 4, // W1, W2, W11, W12 (W10's city seed completes profiling)
      resume: 1, // W10
      profile_confirmed: 2, // W4 (draft), W5 (extracting)
      job_search_apply: 0,
      photo: 1, // W6
      interview_kit: 1, // W7
      completed: 1, // W3
    });

    // Splits: welding/Pune/hi/2.4.1 cells are above the k-anon floor; the singletons
    // are suppressed, never zeroed.
    const trade = Object.fromEntries(res.splits.trade.map((c) => [c.value, c]));
    expect(trade["role_welder"]).toMatchObject({ total: 9, suppressed: false });
    expect(trade["role_tailor"]).toMatchObject({ total: 0, suppressed: true });
    const city = Object.fromEntries(res.splits.city.map((c) => [c.value, c]));
    expect(city["Pune"]).toMatchObject({ total: 9, suppressed: false });
    expect(city["Delhi"]).toMatchObject({ total: 0, suppressed: true });
    const lang = Object.fromEntries(res.splits.language.map((c) => [c.value, c]));
    expect(lang["hi"]).toMatchObject({ total: 9, suppressed: false });
    expect(lang["unknown"]).toMatchObject({ total: 0, suppressed: true });
    const app = Object.fromEntries(res.splits.app_version.map((c) => [c.value, c]));
    expect(app["2.4.1"]).toMatchObject({ total: 5, suppressed: false });
    expect(app["unknown"]).toMatchObject({ total: 5, suppressed: false });
  });

  it("test accounts are excluded by default and included on request", async () => {
    const excluded = await funnel.onboardingFunnel({
      signupFrom: WINDOW_FROM,
      signupTo: WINDOW_TO,
      testAccounts: "exclude",
    });
    expect(excluded.total_workers).toBe(10);
    const included = await funnel.onboardingFunnel({
      signupFrom: WINDOW_FROM,
      signupTo: WINDOW_TO,
      testAccounts: "include",
    });
    expect(included.total_workers).toBe(11);

    const only = await funnel.onboardingFunnel({
      signupFrom: WINDOW_FROM,
      signupTo: WINDOW_TO,
      testAccounts: "only",
    });
    expect(only.total_workers).toBe(1);
  });

  it("the sign-up window bounds the cohort", async () => {
    // W9 signed up in 2020: inside an unbounded read, outside the windowed one.
    const windowed = await funnel.onboardingFunnel({
      signupFrom: WINDOW_FROM,
      signupTo: WINDOW_TO,
      testAccounts: "include",
    });
    expect(windowed.total_workers).toBe(11);

    const all = await funnel.onboardingFunnel({ testAccounts: "include" });
    expect(all.total_workers).toBeGreaterThanOrEqual(12);
    expect(all.total_workers).toBeGreaterThan(windowed.total_workers);
  });
});
