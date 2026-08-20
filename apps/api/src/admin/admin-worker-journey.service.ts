import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import type { AdminPage } from "./admin-entities.dto";
import { decodeCursor, encodeCursor } from "./admin-events.cursor";
import { AdminEventsRepository } from "./admin-events.repository";
import { AdminWorkerJourneyRepository } from "./admin-worker-journey.repository";
import { deriveStuckQuestion, SETTLED_ANSWER_STATUSES } from "./admin-worker-journey.stuck";
import {
  type AdminChatSessionDetail,
  type AdminChatSessionListItem,
  type AdminChatSessionsQueryDto,
  type AdminJourneyInterviewKitStep,
  type AdminJourneyLoginStep,
  type AdminJourneyPackProgress,
  type AdminJourneyPhotoStep,
  type AdminJourneyProfileStep,
  type AdminJourneyProfilingStep,
  type AdminJourneyResumeStep,
  type AdminJourneySearchApplyStep,
  type AdminJourneyStepStatus,
  type AdminWorkerJourneySummary,
  type JourneyCaveat,
} from "./admin-worker-journey.dto";

/**
 * The ADMIN WORKER JOURNEY service (Phase 6) — the 7-step funnel and the interview reads.
 *
 * This is where the journey's BUSINESS RULES live, and they are the only thing here: the
 * repository fetches rows, the controller does HTTP, and every "is this step done", "what is
 * the denominator" and "is this measurement trustworthy" decision is made in this file.
 *
 * ── THE ONE RULE WORTH RESTATING: THE PROFILING DENOMINATOR ─────────────────────────────
 * Every interview runs TWO packs — the worker's occupation pack and the universal tail — and
 * the denominator is the item count of BOTH, which is exactly what the engine's own
 * `progressOf` computes for the bar the WORKER sees:
 *
 *     const allItems = [...(packs.occupation?.items ?? []), ...packs.universal.items];
 *     const total = items.length;                              // next-question.ts
 *
 * The two packs are established from DIFFERENT sources, because only one of them leaves a
 * durable record:
 *
 *  1. THE PAIRS THE WORKER'S OWN ANSWER ROWS STAMP. Every row carries the `pack_id` +
 *     `pack_version` that asked it, so this is evidence rather than inference, and it must
 *     never be replaced by "whatever is active today" — that moves a FINISHED worker's total
 *     on the next re-seed, for a worker who did nothing.
 *  2. THE CURRENTLY ACTIVE UNIVERSAL PACK, added ONLY when (1) names no universal pack of its
 *     own. Nothing pins the universal version: `chat_sessions.pack_id` is the occupation pin
 *     (`resolvePacks` sets it from `occupation?.pack_id`), `conversation_state`'s frozen
 *     contract carries that same single pair, and `resolvePacks` re-resolves the universal
 *     pack fresh every turn via `loadUniversal(now)`. For an old session it is therefore an
 *     APPROXIMATION — and it is the one available, because there is no durable record at all.
 *
 * ⚠ WHY (2) EXISTS, AND WHY THIS FILE ONCE ARGUED AGAINST IT. `packAnswerRowFor` takes ONE
 * `packId` per call and both callers pass the SESSION'S pack, so a universal answer is stored
 * with `pack_id = 'qp_welding'`. Source (1) can therefore never name the universal pack, and
 * "prefer durable evidence" resolved in practice to dropping eight questions out of every
 * worker's total: MEASURED on the verification database, 17 of 21 `(worker, pack)` groups
 * reported more settled answers than their stamped pack has items — `completed 12, total 6`,
 * status `done`, with the two questions the worker never reached (`current_city`,
 * `salary_expected`) not even representable in the denominator. That is the exact signal this
 * screen exists to show. A denominator that drifts on a re-seed is an approximation; one
 * smaller than its own numerator is wrong.
 *
 * ⚠ THE FIX IS IN THE READ PATH ONLY. Re-stamping the historical rows is a data migration
 * against `wpa_worker_question_uq` — `(worker_id, pack_id, question_key)` — so moving a
 * universal answer to its real pack collides with any row already there, and it buys this
 * read nothing it cannot compute.
 *
 * ── ONE EVENT, AND IT IS AN AUDIT OF A READ ─────────────────────────────────────────────
 * The other admin READ services emit nothing, because a read is not a state change. This one
 * emits `admin.worker_journey_viewed` on the summary and on the session detail, and the
 * asymmetry is deliberate: those reads return an entity snapshot, this one returns a
 * BEHAVIOURAL profile of one person's attempt to use the product — login times, per-question
 * outcomes across the corpus, where they stalled and under how much ask pressure, the voice
 * re-record chain, per-session spend, idle seconds. Same data class, materially higher
 * granularity, so looking must leave a trail naming who looked and at whom.
 *
 * THREE PROPERTIES OF THE EMISSION, each a decision:
 *
 *  - AFTER the 404 check, BEFORE the read completes. Auditing an unknown id would fill the
 *    spine with rows for entities that do not exist and turn the audit stream into an
 *    enumeration oracle; auditing after the response is built would lose the row whenever the
 *    read then failed.
 *  - AWAITED AND FAIL-CLOSED. An emit failure propagates and the caller gets an error instead
 *    of the data — the same discipline `AdminPiiRevealService` applies to its audit-before-
 *    decrypt. A trail that is best-effort is not a control; it is a log line. The cost is one
 *    `events` insert per page view on a low-volume internal surface.
 *  - PII-FREE. Opaque admin/worker/session ids and a view enum. Never a question key: WHICH
 *    question a worker stalled on belongs in the response, not on the audit spine.
 *
 * `listChatSessions` is deliberately NOT audited: it is a per-worker index of session ids,
 * timings and statuses, which is the entity-detail data class, and the two reads it leads to
 * are both audited themselves.
 *
 * ── HONESTY OVER TIDINESS ───────────────────────────────────────────────────────────────
 * Three measurements on this surface do not exist for all data, and each is reported as
 * MISSING rather than as a confident zero: interview-kit attribution (only from migration
 * 0079), session AI cost (only from 0077), and the stuck question (needs a
 * `conversation_state`). They ride on `caveats`, a closed enum, so the UI can say which.
 */
@Injectable()
export class AdminWorkerJourneyService {
  /** The three worker-SUBJECT events the funnel counts. All verified at their emitters. */
  private static readonly LOGIN_EVENT = "worker.otp_verified";
  private static readonly TEST_LOGIN_EVENT = "worker.test_login";
  private static readonly SEARCH_EVENT = "job.search_performed";

  constructor(
    private readonly repo: AdminWorkerJourneyRepository,
    // The funnel's two `events` reads. They live on the shared spine repository, not on
    // `AdminWorkerJourneyRepository`, because `events` has exactly ONE admin reader by design
    // (build-blocked in `admin-static-guards.test.ts`) — so the COMPOSITION happens here.
    private readonly eventsRepo: AdminEventsRepository,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  // =========================================================================
  // GET /admin/workers/:id/journey-summary
  // =========================================================================

  async getJourneySummary(
    adminId: string,
    workerId: string,
    ctx: RequestContext,
  ): Promise<AdminWorkerJourneySummary> {
    const worker = await this.repo.findWorkerCore(workerId);
    if (!worker) throw new NotFoundException("Worker not found");

    // AUDIT BEFORE THE READ, awaited and fail-closed — see the class header. After the 404 so
    // an unknown id leaves no row (and so the stream is not an enumeration oracle).
    await this.auditJourneyRead(adminId, workerId, "journey_summary", null, ctx);

    const [
      eventCounts,
      kit,
      answerStats,
      packVersions,
      sessionCount,
      resumes,
      profile,
      apps,
      activeUniversal,
    ] = await Promise.all([
      this.eventsRepo.countWorkerSubjectEvents(workerId, [
        AdminWorkerJourneyService.LOGIN_EVENT,
        AdminWorkerJourneyService.TEST_LOGIN_EVENT,
        AdminWorkerJourneyService.SEARCH_EVENT,
      ]),
      this.eventsRepo.countInterviewKitDownloads(workerId),
      this.repo.packAnswerStatusCounts(workerId),
      this.repo.answeredPackVersions(workerId),
      this.repo.countSessions(workerId),
      this.repo.resumeStats(workerId),
      this.repo.currentProfile(workerId),
      this.repo.applicationActionCounts(workerId),
      // Batched with the rest: it depends on nothing, and the universal tail is asked of every
      // worker whatever their trade, so it is never a speculative read.
      this.repo.findActiveUniversalPack(this.config.PROFILING_PACK_LOCALE),
    ]);

    // WHICH PACKS THIS WORKER'S INTERVIEW RAN — see the class header for the two sources and
    // why the second one is a last resort rather than a preference.
    const denominatorPairs = AdminWorkerJourneyService.denominatorPairs(
      packVersions,
      activeUniversal,
    );

    // A SECOND round trip because both WHERE clauses are built from the first batch's result.
    // That dependency is the whole property this denominator has, so it is not collapsible
    // into the batch above; the two reads inside it are independent and run together.
    const [itemCounts, orphanKeyCount] = await Promise.all([
      this.repo.countPackItems(denominatorPairs),
      this.repo.countSettledKeysOutsidePacks(workerId, denominatorPairs),
    ]);

    const caveats: JourneyCaveat[] = ["interview_kit_attribution_since_0079"];

    // ---- step 2: profiling ------------------------------------------------
    const itemCountByPair = new Map(
      itemCounts.map((c) => [`${c.packId}:${c.packVersion}`, c.itemCount]),
    );
    // ⚠ BUILT FROM THE STAMPED PAIRS, NOT FROM `denominatorPairs`. These rows describe what the
    // worker's answers SAY, and the universal pack is in the denominator precisely because no
    // answer row says it — so a row for it would have to claim `answer_count: 0` for questions
    // this worker demonstrably answered. See `AdminJourneyPackProgress`.
    const packs: AdminJourneyPackProgress[] = packVersions.map((p) => ({
      pack_id: p.packId,
      pack_version: p.packVersion,
      item_count: itemCountByPair.get(`${p.packId}:${p.packVersion}`) ?? 0,
      answer_count: p.answerCount,
    }));

    const answeredCount = AdminWorkerJourneyService.statCount(answerStats, "answered");
    const declinedCount = AdminWorkerJourneyService.statCount(answerStats, "declined");
    const unansweredCount = AdminWorkerJourneyService.statCount(answerStats, "unanswered");
    // THE NUMERATOR IS THE SETTLED SET, AND IT IS DERIVED FROM THE CONSTANT rather than summed
    // by hand. `unanswered` is NOT settled: `isSettled` in `answer-map.ts` says so, and both
    // `countAnswersBySession` and `listSettledKeys` already filter to exactly
    // SETTLED_ANSWER_STATUSES. This was the FOURTH reader and it drifted — it added
    // `unansweredCount` to a local literally named `settledTotal`, overstating
    // `steps[profiling].completed` by the unanswered count and letting `status` read `done` for
    // a worker who settled nothing.
    //
    // Deriving from the constant is the point of the fix. The bug was inert only because
    // `packAnswerRowFor` cannot currently emit `unanswered` (it returns null for that record) —
    // a property of today's flush, not of the schema, which permits the third value and arms
    // this for any future writer. A fifth reader written as a hand-rolled sum would drift the
    // same way; one written over this constant cannot.
    const settledTotal = SETTLED_ANSWER_STATUSES.reduce(
      (sum, status) => sum + AdminWorkerJourneyService.statCount(answerStats, status),
      0,
    );
    // SUMMED OVER `denominatorPairs`, i.e. over every row `countPackItems` returned — NOT over
    // `packs`, which is the stamped subset and is missing the universal tail by construction.
    const packTotal = itemCounts.reduce((sum, c) => sum + c.itemCount, 0);

    /**
     * ⚠ CLAMPED, AND THE CLAMP ANNOUNCES ITSELF.
     *
     * `settledTotal` counts ROWS; `packTotal` counts QUESTIONS. They are the same number for a
     * worker interviewed once, and they come apart in two ways that are both reachable:
     *
     *  - a RETIRED question — a settled row whose key no contributing pack still owns;
     *  - a RE-INTERVIEW under a second trade — the universal answers are stamped again with the
     *    new occupation pack (`wpa_worker_question_uq` is per pack), so one question yields two
     *    rows while the denominator counts it once.
     *
     * `13 of 12` is a bug on the screen whatever produced it, so the numerator is capped at the
     * denominator — but silently capping would be the same class of dishonesty this file
     * refuses everywhere else, so a clamp that BITES raises the caveat below, and the true
     * numbers stay on `answered_count` / `declined_count` where nothing rounds them.
     */
    const completed = packTotal > 0 ? Math.min(settledTotal, packTotal) : settledTotal;

    // THE PACK CORPUS NO LONGER ACCOUNTS FOR THIS WORKER'S ANSWERS — one caveat, three ways in,
    // because they are one fact: the denominator has stopped describing the numerator.
    if (
      // A stamped version with no items left — retired out from under the answers wholesale.
      packs.some((p) => p.item_count === 0) ||
      // A settled key no contributing pack owns — the same retirement, one question at a time,
      // and the only one of the three that is otherwise SILENT (it undercounts without ever
      // pushing the numerator past the denominator).
      orphanKeyCount > 0 ||
      // The arithmetic proof, whatever the cause — including a cause this list has not met.
      completed !== settledTotal
    ) {
      caveats.push("pack_version_retired");
    }

    // ---- step 1: login ----------------------------------------------------
    const login = AdminWorkerJourneyService.eventStat(
      eventCounts,
      AdminWorkerJourneyService.LOGIN_EVENT,
    );
    const testLogin = AdminWorkerJourneyService.eventStat(
      eventCounts,
      AdminWorkerJourneyService.TEST_LOGIN_EVENT,
    );
    const search = AdminWorkerJourneyService.eventStat(
      eventCounts,
      AdminWorkerJourneyService.SEARCH_EVENT,
    );

    const loginStep: AdminJourneyLoginStep = {
      key: "login",
      order: 1,
      // ALWAYS `done`, and that is a fact about the schema rather than optimism: the only
      // production writer of a `workers` row is `createOrGetByPhoneHash`, reached only from
      // `mintLoginForPhone`, reached only from `verifyOtp`/`testLogin`. A row exists ⇒ a login
      // completed. The counts below are what carry the nuance (including a worker who exists
      // only because of a staging test mint: `otp_verified_count === 0`).
      status: "done",
      completed: login.n,
      total: null,
      first_at: login.firstAt ?? worker.createdAt,
      last_at: login.lastAt ?? worker.createdAt,
      otp_verified_count: login.n,
      test_login_count: testLogin.n,
      last_test_login_at: testLogin.lastAt,
      worker_created_at: worker.createdAt,
    };

    const profilingStep: AdminJourneyProfilingStep = {
      key: "profiling",
      order: 2,
      status: AdminWorkerJourneyService.progressStatus(completed, packTotal),
      completed,
      // Null rather than 0 when nothing is known: `x of 0` is not a progress bar, it is a
      // missing denominator wearing one.
      total: packTotal > 0 ? packTotal : null,
      // ⚠ ALL-STATUS ON PURPOSE, and deliberately NOT narrowed to the settled set with the
      // numerator above. These two answer a different question — "when did this worker touch
      // profiling at all" — and an unanswered row is a touch. Filtering them would report a
      // worker who opened the interview and settled nothing as having never been there.
      first_at: AdminWorkerJourneyService.earliest(answerStats.map((s) => s.firstAt)),
      last_at: AdminWorkerJourneyService.latest(answerStats.map((s) => s.lastAt)),
      answered_count: answeredCount,
      declined_count: declinedCount,
      // The EXCLUDED bucket, and making it visible is this field's whole job: once unanswered
      // rows exist, `completed !== sum(packs[].answer_count)`, because `answer_count` is also
      // all-status per its DTO. That is correct, not a rounding error — and it is the trap for
      // a UI author who re-derives the headline number by summing the per-pack rows. Read
      // `completed` for progress; read these three for the breakdown.
      unanswered_count: unansweredCount,
      session_count: sessionCount,
      packs,
    };

    const resumeStep: AdminJourneyResumeStep = {
      key: "resume",
      order: 3,
      status: resumes.n > 0 ? "done" : "not_done",
      completed: null,
      total: null,
      first_at: resumes.firstAt,
      last_at: resumes.lastAt,
      has_resume: resumes.n > 0,
      resume_count: resumes.n,
      rendered_count: resumes.rendered,
    };

    const profileStep: AdminJourneyProfileStep = {
      key: "profile_confirmed",
      order: 4,
      // `confirmed` is the step. `extracting`/`extracted` mean the pipeline produced something
      // the worker has not yet confirmed — real progress, not completion. `draft` is the
      // placeholder an outage writes, so it is NOT progress.
      status:
        profile.status === "confirmed"
          ? "done"
          : profile.status === "extracting" || profile.status === "extracted"
            ? "in_progress"
            : "not_done",
      completed: null,
      total: null,
      first_at: profile.createdAt,
      last_at: profile.confirmedAt ?? profile.updatedAt,
      profile_status: profile.status,
      confirmed_at: profile.confirmedAt,
      profile_count: profile.profileCount,
    };

    const applied = AdminWorkerJourneyService.actionStat(apps, "applied");
    const skipped = AdminWorkerJourneyService.actionStat(apps, "skipped");
    const searchApplyStep: AdminJourneySearchApplyStep = {
      key: "job_search_apply",
      order: 5,
      // APPLYING is the step. Searching is real engagement but it is the step before.
      status: applied.n > 0 ? "done" : search.n > 0 || skipped.n > 0 ? "in_progress" : "not_done",
      completed: applied.n,
      total: null,
      first_at: applied.firstAt,
      last_at: applied.lastAt,
      search_count: search.n,
      first_search_at: search.firstAt,
      last_search_at: search.lastAt,
      applied_count: applied.n,
      skipped_count: skipped.n,
    };

    const photoStep: AdminJourneyPhotoStep = {
      key: "photo",
      order: 6,
      status: worker.hasPhoto ? "done" : "not_done",
      completed: null,
      total: null,
      // `workers` carries no per-column timestamp, and `updated_at` moves for any reason at
      // all — reporting it as "when the photo was added" would be a confident wrong answer.
      first_at: null,
      last_at: null,
      has_photo: worker.hasPhoto,
    };

    const kitStep: AdminJourneyInterviewKitStep = {
      key: "interview_kit",
      order: 7,
      status: kit.n > 0 ? "done" : "not_done",
      completed: kit.n,
      total: null,
      first_at: kit.firstAt,
      last_at: kit.lastAt,
      download_count: kit.n,
      trade_count: kit.trades,
      // TRUE from migration 0079 onward. The caveat above is what says a zero here cannot be
      // read as "never downloaded" — historical rows carry no worker id and cannot be
      // backfilled, because the route was anonymous by design.
      attribution_available: true,
    };

    return {
      worker_id: workerId,
      generated_at: new Date(),
      steps: [
        loginStep,
        profilingStep,
        resumeStep,
        profileStep,
        searchApplyStep,
        photoStep,
        kitStep,
      ],
      caveats,
    };
  }

  // =========================================================================
  // GET /admin/workers/:id/chat-sessions
  // =========================================================================

  async listChatSessions(
    workerId: string,
    dto: AdminChatSessionsQueryDto,
  ): Promise<AdminPage<AdminChatSessionListItem>> {
    const worker = await this.repo.findWorkerCore(workerId);
    if (!worker) throw new NotFoundException("Worker not found");

    // Over-fetch by one, so `nextCursor` is HONEST. Deriving it from "we returned exactly
    // `limit` rows" invents a next page whenever the total is an exact multiple of the page
    // size, and the operator clicks Next onto an empty screen — which reads as data loss.
    const rows = await this.repo.listSessions(
      workerId,
      { status: dto.status },
      decodeCursor(dto.cursor),
      dto.limit + 1,
    );

    const hasMore = rows.length > dto.limit;
    const page = hasMore ? rows.slice(0, dto.limit) : rows;
    const ids = page.map((r) => r.id);

    const [messageCounts, answerCounts] = await Promise.all([
      this.repo.countMessagesBySession(ids),
      this.repo.countAnswersBySession(ids),
    ]);

    const now = Date.now();
    const items = page.map((r) =>
      AdminWorkerJourneyService.toListItem(
        r,
        messageCounts.get(r.id) ?? 0,
        answerCounts.get(r.id) ?? 0,
        now,
      ),
    );

    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({ occurredAt: last.startedAt.toISOString(), id: last.id })
          : null,
    };
  }

  // =========================================================================
  // GET /admin/chat-sessions/:id
  // =========================================================================

  async getChatSession(
    adminId: string,
    sessionId: string,
    ctx: RequestContext,
  ): Promise<AdminChatSessionDetail> {
    const session = await this.repo.findSession(sessionId);
    if (!session) throw new NotFoundException("Chat session not found");

    // The audited SUBJECT is the WORKER, read off the session row — never a caller-supplied
    // id. An audit keyed on the session alone would not answer "who has been looked at".
    await this.auditJourneyRead(adminId, session.workerId, "chat_session", sessionId, ctx);

    const [answers, voiceAnswers, jobs, aiCost, settledKeys, packVersions, messageCounts] =
      await Promise.all([
        this.repo.listSessionAnswers(sessionId),
        this.repo.listSessionVoiceAnswers(sessionId),
        this.repo.listSessionAiJobs(sessionId),
        this.repo.sessionAiCost(sessionId),
        this.repo.listSettledKeys(sessionId),
        this.repo.sessionPackVersions(sessionId),
        this.repo.countMessagesBySession([sessionId]),
      ]);

    // ---- which packs' items can name this session's questions -------------
    //
    // THREE SOURCES, IN PRECEDENCE ORDER, because `deriveStuckQuestion` takes the FIRST item
    // it sees for a key:
    //
    //  1. the pairs the session's own answers + voice attempts STAMP — durable, exact;
    //  2. the session's own PIN — a session abandoned before a single answer or clip has no
    //     stamped pair at all, and the pin is then the only record of which interview it was;
    //  3. the CURRENTLY ACTIVE universal pack — a last resort, and the fix for the population
    //     this feature cares about most.
    //
    // ⚠ WHY (3) IS NEEDED. `chat_sessions.pack_id` pins the OCCUPATION pack ONLY; the
    // universal tail is resolved fresh every turn and never pinned. So in a text-mode session
    // that died in the universal block with nothing universal settled, sources 1 and 2 cover
    // NONE of the universal keys in `ask_counts` — every one of them resolves to no item and
    // the ranking is blind on the two legs that need `is_mandatory`/`display_order`.
    //
    // ⚠ AND WHY IT IS LAST. It is today's ACTIVE version, not necessarily the one that ran, so
    // for an old session it is an approximation — which is exactly why it may not displace a
    // pair the session actually stamped, and why `stuck.unresolved_count` still reports
    // whatever it did not cover. (The profiling DENOMINATOR deliberately does NOT do this: the
    // same substitution there would move a finished worker's progress bar on every reseed.)
    const pairs = [...packVersions];
    const addPair = (packId: string, packVersion: number): void => {
      const key = `${packId}:${packVersion}`;
      if (!pairs.some((p) => `${p.packId}:${p.packVersion}` === key)) {
        pairs.push({ packId, packVersion });
      }
    };
    if (session.packId !== null && session.packVersion !== null) {
      addPair(session.packId, session.packVersion);
    }
    const universal = await this.repo.findActiveUniversalPack(this.config.PROFILING_PACK_LOCALE);
    if (universal) addPair(universal.packId, universal.packVersion);

    const items = await this.repo.listPackItems(pairs);

    const stuck = deriveStuckQuestion({
      askCounts: session.askCounts,
      settledKeys,
      answerMapStatuses: session.answerStatuses,
      items,
      pinnedPackId: session.packId,
      hasConversationState: session.hasConversationState,
    });

    const caveats: JourneyCaveat[] = [];
    if (aiCost === null) caveats.push("ai_cost_not_recorded");
    if (stuck.outcome === "no_conversation_state") caveats.push("no_conversation_state");
    // The ranking's blindness is REPORTED, never absorbed: an unresolvable key is judged on
    // neither servability nor engine position, so an operator must be able to see that some
    // of the ordering rests on nothing.
    if (stuck.unresolved_count > 0) caveats.push("stuck_items_unresolved");

    const base = AdminWorkerJourneyService.toListItem(
      session,
      messageCounts.get(sessionId) ?? 0,
      settledKeys.length,
      Date.now(),
    );

    return {
      ...base,
      answers,
      voice_answers: voiceAnswers,
      ai_jobs: jobs,
      ai_cost: aiCost,
      stuck,
      caveats,
    };
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /**
   * Record that `adminId` read `workerId`'s journey. AWAITED; a failure PROPAGATES.
   *
   * The payload is opaque ids + a closed enum, and that is the whole contract: no question
   * key, no status, no count, no free text (`.strict()` on the payload schema is the
   * structural backstop). The ACTOR is the session admin the guard resolved; the SUBJECT is
   * the worker — for the session read, taken off the session ROW rather than from the path,
   * so the trail cannot be pointed at a worker the caller names.
   */
  private async auditJourneyRead(
    adminId: string,
    workerId: string,
    view: "journey_summary" | "chat_session",
    chatSessionId: string | null,
    ctx: RequestContext,
  ): Promise<void> {
    await this.events.emit({
      event_name: "admin.worker_journey_viewed",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: {
        admin_id: adminId,
        subject_id: workerId,
        view,
        chat_session_id: chatSessionId,
      } satisfies PayloadInputOf<"admin.worker_journey_viewed">,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private static toListItem(
    row: {
      id: string;
      workerId: string;
      status: string;
      startedAt: Date;
      endedAt: Date | null;
      lastMessageAt: Date | null;
      packId: string | null;
      packVersion: number | null;
    },
    messageCount: number,
    answerCount: number,
    nowMs: number,
  ): AdminChatSessionListItem {
    return {
      id: row.id,
      worker_id: row.workerId,
      status: row.status as AdminChatSessionListItem["status"],
      started_at: row.startedAt,
      ended_at: row.endedAt,
      last_message_at: row.lastMessageAt,
      // "Idle since" — the abandonment signal, paired with the status. NULL when the worker
      // never spoke, which is itself the strongest signal there is: a session opened and
      // dropped before a single turn. Deriving 0 from `started_at` instead would make that
      // worker look like they had just been active.
      idle_seconds:
        row.lastMessageAt === null
          ? null
          : Math.max(0, Math.floor((nowMs - row.lastMessageAt.getTime()) / 1000)),
      pack_id: row.packId,
      pack_version: row.packVersion,
      message_count: messageCount,
      answer_count: answerCount,
      abandoned: row.status === "abandoned",
    };
  }

  /**
   * The `(pack_id, pack_version)` pairs the profiling denominator is summed over.
   *
   * THE STAMPED PAIRS ALWAYS, plus the active universal pack under two conditions — and each
   * condition is the durable-evidence rule doing its job rather than a special case:
   *
   *  - THE WORKER HAS AT LEAST ONE ANSWER ROW. With none there is no evidence any interview
   *    ran, and `total` stays null. Handing a worker who never started one a denominator of 8
   *    would be `x of 0`'s mistake in the other direction: a number that describes the corpus
   *    rather than this person.
   *  - THE STAMPED PAIRS NAME NO UNIVERSAL PACK. If a row already stamps `qp_universal`, that
   *    is a durable record of the version the worker actually met, and today's active version
   *    must not displace or supplement it. No writer produces such a row TODAY (see the class
   *    header), which is exactly why the guard is written now: a later fix to
   *    `packAnswerRowFor` would otherwise start adding v2's items on top of the v1 items the
   *    worker's rows already account for.
   *
   * MATCHED ON `packId`, NOT ON THE PAIR. A stamped `qp_universal:1` beside an active
   * `qp_universal:2` is the same tail at two versions, and counting both would double it.
   */
  private static denominatorPairs(
    stamped: ReadonlyArray<{ packId: string; packVersion: number }>,
    activeUniversal: { packId: string; packVersion: number } | null,
  ): Array<{ packId: string; packVersion: number }> {
    const pairs = stamped.map((p) => ({ packId: p.packId, packVersion: p.packVersion }));
    if (pairs.length === 0 || activeUniversal === null) return pairs;
    if (pairs.some((p) => p.packId === activeUniversal.packId)) return pairs;
    return [...pairs, activeUniversal];
  }

  /** `completed`/`total` → a funnel status. `total === 0` is "unknown", never "complete". */
  private static progressStatus(completed: number, total: number): AdminJourneyStepStatus {
    if (completed === 0) return "not_done";
    if (total > 0 && completed >= total) return "done";
    return "in_progress";
  }

  private static statCount(
    stats: ReadonlyArray<{ status: string; n: number }>,
    status: string,
  ): number {
    return stats.find((s) => s.status === status)?.n ?? 0;
  }

  private static actionStat(
    stats: ReadonlyArray<{ action: string; n: number; firstAt: Date | null; lastAt: Date | null }>,
    action: string,
  ): { n: number; firstAt: Date | null; lastAt: Date | null } {
    const row = stats.find((s) => s.action === action);
    return { n: row?.n ?? 0, firstAt: row?.firstAt ?? null, lastAt: row?.lastAt ?? null };
  }

  private static eventStat(
    stats: ReadonlyArray<{
      eventName: string;
      n: number;
      firstAt: Date | null;
      lastAt: Date | null;
    }>,
    eventName: string,
  ): { n: number; firstAt: Date | null; lastAt: Date | null } {
    const row = stats.find((s) => s.eventName === eventName);
    return { n: row?.n ?? 0, firstAt: row?.firstAt ?? null, lastAt: row?.lastAt ?? null };
  }

  private static earliest(dates: ReadonlyArray<Date | null>): Date | null {
    const real = dates.filter((d): d is Date => d !== null);
    if (real.length === 0) return null;
    return real.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
  }

  private static latest(dates: ReadonlyArray<Date | null>): Date | null {
    const real = dates.filter((d): d is Date => d !== null);
    if (real.length === 0) return null;
    return real.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
  }
}
