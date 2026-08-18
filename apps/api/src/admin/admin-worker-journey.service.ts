import { Injectable, NotFoundException } from "@nestjs/common";
import type { AdminPage } from "./admin-entities.dto";
import { decodeCursor, encodeCursor } from "./admin-events.cursor";
import { AdminWorkerJourneyRepository } from "./admin-worker-journey.repository";
import { deriveStuckQuestion } from "./admin-worker-journey.stuck";
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
 * It is summed over the `(pack_id, pack_version)` pairs the WORKER'S OWN ANSWER ROWS stamp —
 * never over "the currently active pack". The interview merges an occupation pack and a
 * universal one; only the occupation pack is pinned on `chat_sessions`, and the universal
 * pack is resolved fresh from whatever is `active` at the time. Re-deriving from the active
 * pack therefore changes a FINISHED worker's total the next time a pack is re-seeded — the
 * progress bar moves for a worker who did nothing. The answer rows are the only durable
 * record of what that worker was actually asked.
 *
 * ── NO EVENTS ───────────────────────────────────────────────────────────────────────────
 * A read is not a state change, so this emits nothing — the same posture as the other admin
 * read services. The privileged read that IS audited is the PII reveal, which lives behind
 * its own capability and its own default-off flag; that asymmetry is deliberate.
 *
 * ── HONESTY OVER TIDINESS ───────────────────────────────────────────────────────────────
 * Three measurements on this surface do not exist for all data, and each is reported as
 * MISSING rather than as a confident zero: interview-kit attribution (only from migration
 * 0078), session AI cost (only from 0077), and the stuck question (needs a
 * `conversation_state`). They ride on `caveats`, a closed enum, so the UI can say which.
 */
@Injectable()
export class AdminWorkerJourneyService {
  /** The three worker-SUBJECT events the funnel counts. All verified at their emitters. */
  private static readonly LOGIN_EVENT = "worker.otp_verified";
  private static readonly TEST_LOGIN_EVENT = "worker.test_login";
  private static readonly SEARCH_EVENT = "job.search_performed";

  constructor(private readonly repo: AdminWorkerJourneyRepository) {}

  // =========================================================================
  // GET /admin/workers/:id/journey-summary
  // =========================================================================

  async getJourneySummary(workerId: string): Promise<AdminWorkerJourneySummary> {
    const worker = await this.repo.findWorkerCore(workerId);
    if (!worker) throw new NotFoundException("Worker not found");

    const [eventCounts, kit, answerStats, packVersions, sessionCount, resumes, profile, apps] =
      await Promise.all([
        this.repo.countWorkerSubjectEvents(workerId, [
          AdminWorkerJourneyService.LOGIN_EVENT,
          AdminWorkerJourneyService.TEST_LOGIN_EVENT,
          AdminWorkerJourneyService.SEARCH_EVENT,
        ]),
        this.repo.countInterviewKitDownloads(workerId),
        this.repo.packAnswerStatusCounts(workerId),
        this.repo.answeredPackVersions(workerId),
        this.repo.countSessions(workerId),
        this.repo.resumeStats(workerId),
        this.repo.currentProfile(workerId),
        this.repo.applicationActionCounts(workerId),
      ]);

    // The item counts are a SECOND round trip because their WHERE clause is built from the
    // first one's result — the pairs the worker's own answers stamp. That dependency is the
    // whole property this denominator has, so it is not collapsible into the batch above.
    const itemCounts = await this.repo.countPackItems(packVersions);

    const caveats: JourneyCaveat[] = ["interview_kit_attribution_since_0078"];

    // ---- step 2: profiling ------------------------------------------------
    const itemCountByPair = new Map(
      itemCounts.map((c) => [`${c.packId}:${c.packVersion}`, c.itemCount]),
    );
    const packs: AdminJourneyPackProgress[] = packVersions.map((p) => ({
      pack_id: p.packId,
      pack_version: p.packVersion,
      item_count: itemCountByPair.get(`${p.packId}:${p.packVersion}`) ?? 0,
      answer_count: p.answerCount,
    }));
    // A pack version the worker answered under that has NO items left has been retired out
    // from under those answers, so the denominator is an undercount. Say so rather than
    // rendering a progress bar nobody can trust.
    if (packs.some((p) => p.item_count === 0)) caveats.push("pack_version_retired");

    const answeredCount = AdminWorkerJourneyService.statCount(answerStats, "answered");
    const declinedCount = AdminWorkerJourneyService.statCount(answerStats, "declined");
    const unansweredCount = AdminWorkerJourneyService.statCount(answerStats, "unanswered");
    const settledTotal = answeredCount + declinedCount + unansweredCount;
    const packTotal = packs.reduce((sum, p) => sum + p.item_count, 0);

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
      status: AdminWorkerJourneyService.progressStatus(settledTotal, packTotal),
      completed: settledTotal,
      // Null rather than 0 when nothing is known: `x of 0` is not a progress bar, it is a
      // missing denominator wearing one.
      total: packTotal > 0 ? packTotal : null,
      first_at: AdminWorkerJourneyService.earliest(answerStats.map((s) => s.firstAt)),
      last_at: AdminWorkerJourneyService.latest(answerStats.map((s) => s.lastAt)),
      answered_count: answeredCount,
      declined_count: declinedCount,
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
      // TRUE from migration 0078 onward. The caveat above is what says a zero here cannot be
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

  async getChatSession(sessionId: string): Promise<AdminChatSessionDetail> {
    const session = await this.repo.findSession(sessionId);
    if (!session) throw new NotFoundException("Chat session not found");

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

    // The session's OWN pin is folded in: a session can be abandoned before a single answer
    // or clip lands, and its pinned pack is then the only record of which interview it was.
    const pairs = [...packVersions];
    if (session.packId !== null && session.packVersion !== null) {
      const key = `${session.packId}:${session.packVersion}`;
      if (!pairs.some((p) => `${p.packId}:${p.packVersion}` === key)) {
        pairs.push({ packId: session.packId, packVersion: session.packVersion });
      }
    }
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
