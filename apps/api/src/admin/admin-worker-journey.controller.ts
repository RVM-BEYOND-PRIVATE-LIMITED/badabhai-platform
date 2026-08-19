import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminWorkerJourneyService } from "./admin-worker-journey.service";
import {
  AdminChatSessionsQuerySchema,
  AdminJourneyParamsSchema,
  type AdminChatSessionsQueryDto,
  type AdminJourneyParamsDto,
} from "./admin-worker-journey.dto";

/**
 * Read-only WORKER JOURNEY API for the Admin Portal (Phase 6).
 *
 * WHY THIS EXISTS. "We are creating this app for users who are not habituated with apps, so
 * we need complete transparency to make sure the app is as easy to use as possible." The
 * portal could already list workers and their aggregate counts; it could not answer, for ONE
 * worker, which steps they finished and — for the AI profiling interview — exactly which
 * question they stalled on and how far through they got. That is what these three routes are.
 *
 * ══ RBAC: `read_entities` (OWNER RULING), PLUS AN AUDIT EVENT ═══════════════════════════
 *
 * ⚠ FIRST, THE HONEST STATEMENT OF WHAT THIS AGGREGATES. This is the SAME DATA CLASS as the
 * entity detail — opaque ids, enums, timestamps, counts, question KEYS; no name, no phone, no
 * transcript — but it is materially MORE of it, and it is BEHAVIOURAL rather than a state
 * snapshot. `GET /admin/workers/:id` returns ~13 scalars about a worker's current state. The
 * journey adds: how many times they logged in and when; the outcome of each question across a
 * 132-key corpus (including `salary_expected`, `education`, `language_spoken`); exactly where
 * the interview stalled, with the ask pressure and servability that led to it; the voice
 * re-record chain; per-session AI spend; idle seconds; search/apply/skip counts; kit
 * downloads. That is a profile of one person's attempt to use the product. Anyone reading
 * this header to decide whether some LATER field belongs here should weigh it against that,
 * not against "it's only the same data as the detail page".
 *
 * IT STILL SITS ON `read_entities` — all four admin roles, analyst included — and that is a
 * ruling, taken with the aggregation above on the table. Two mechanical facts back it:
 *
 *  1. `ADMIN_CAPABILITIES` IS PINNED TO A SIGNED ADR. The matrix-drift test transcribes
 *     ADR-0025 Decision 3.1 verbatim and fails CI on any added or removed capability. Minting
 *     one is an ADR amendment — an Architect decision, not a backend one — and inventing a
 *     capability that appears in the code and not in the ADR is exactly the drift that test
 *     was written to catch.
 *
 *  2. A NEW CAPABILITY WOULD REACH INTO FRONTEND-OWNED CODE. `apps/admin-web` carries an
 *     exhaustive `CAPABILITY_LABELS: Record<AdminCapability, string>` with a key-parity test.
 *     A backend-only PR cannot complete that half, and a half-added capability renders as a
 *     permission nobody can name.
 *
 * AND THE COMPENSATING CONTROL: both per-worker reads emit `admin.worker_journey_viewed`
 * (PII-free — opaque admin/worker/session ids + a view enum), awaited and fail-closed, so
 * every look at a worker's journey is non-repudiably recorded on the spine the way every PII
 * reveal is. Access being broad is exactly why the trail has to exist. See the SERVICE header
 * for the emission's ordering and failure posture.
 *
 * NO TRANSCRIPT CAPABILITY IS ADDED HERE, and none is needed: this surface returns no
 * `body_text` and no `transcript_text` (see the DTO header). If a transcript read is ever
 * wanted, THAT is the thing that earns its own capability, its own default-off flag and its
 * own security review — the way `reveal_pii` did.
 *
 * Every route: `AdminAuthGuard` + `AdminRolesGuard`, capability declared at the METHOD level
 * (a route that forgets the decorator is DENIED, never opened), and every one is a GET.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminWorkerJourneyController {
  constructor(private readonly service: AdminWorkerJourneyService) {}

  /**
   * The 7-step funnel for ONE worker: login → profiling → resume → profile confirmed →
   * search/apply → photo → interview kit. Always all seven steps, in order; a step that has
   * not happened reports `not_done` rather than being omitted.
   *
   * 404 when the worker does not exist. The worker id comes from the PATH and is validated as
   * a uuid; the ADMIN is resolved from the session by the guard, never from the request — and
   * it is that session id, not anything the caller sends, that goes on the audit event.
   */
  @Get("workers/:id/journey-summary")
  @RequireAdminRole("read_entities")
  getJourneySummary(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminJourneyParamsSchema)) params: AdminJourneyParamsDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.getJourneySummary(admin.id, params.id, ctx);
  }

  /**
   * One worker's interview sessions, newest first — status, timings, the pinned pack, message
   * and answer counts, and the abandonment signal (`abandoned` + `idle_seconds`).
   *
   * Keyset-paginated on `(started_at, id)` DESC with a hard page cap; migration 0079 adds the
   * matching index. 404 when the worker does not exist.
   */
  @Get("workers/:id/chat-sessions")
  @RequireAdminRole("read_entities")
  listChatSessions(
    @Param(new ZodValidationPipe(AdminJourneyParamsSchema)) params: AdminJourneyParamsDto,
    @Query(new ZodValidationPipe(AdminChatSessionsQuerySchema)) query: AdminChatSessionsQueryDto,
  ) {
    return this.service.listChatSessions(params.id, query);
  }

  /**
   * ONE session in depth: settled answers (keys + statuses), the voice attempt/retry chain
   * including superseded attempts, the correlated AI jobs, the session's AI spend, and the
   * derived STUCK QUESTION.
   *
   * ⚠ Returns NO transcript text of any kind — see `admin-worker-journey.dto.ts`.
   *
   * 404 when the session does not exist. Scoped by session id rather than nested under the
   * worker because a session id is globally unique and the row carries its own `worker_id`,
   * which the response returns — so an operator can always see whose session they opened.
   * That same `worker_id`, read off the row, is the audit event's subject.
   */
  @Get("chat-sessions/:id")
  @RequireAdminRole("read_entities")
  getChatSession(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminJourneyParamsSchema)) params: AdminJourneyParamsDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.getChatSession(admin.id, params.id, ctx);
  }
}
