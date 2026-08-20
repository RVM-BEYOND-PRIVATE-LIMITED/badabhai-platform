import { HttpException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { ServerConfig } from "@badabhai/config";

import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { can } from "./admin-capabilities";
import { AdminAiTraceCapService } from "./admin-ai-trace-cap.service";
import {
  AdminAiTracesRepository,
  type AdminAiTraceListRow,
} from "./admin-ai-traces.repository";
import { decodeEntityCursor, encodeEntityCursor } from "./admin-entities.cursor";
import type { AdminPage } from "./admin-entities.dto";
import type {
  AdminAiTraceDetail,
  AdminAiTraceListItem,
  AdminAiTracesQueryDto,
} from "./admin-ai-traces.dto";

/**
 * Canonical 8-4-4-4-12 hex form — what a `uuid` column accepts and what `encodeEntityCursor`
 * emits. A cursor id that is not one cannot match a row, so falling back to the first page loses
 * nothing a correct cursor would have found. (`decodeEntityCursor` validates the timestamp half
 * and accepts the id half as any string, which then binds against a `uuid` column and 500s at
 * 22P02 — the trap `AdminFeedbackService` documents.)
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The admin AI-trace read (migration 0083) — a PII-free list, and the single most privileged
 * disclosure on the admin surface behind it.
 *
 * ── THE LIST: NO CAP AND NO AUDIT ROW, BUT THE SAME GATE ────────────────────────────────
 * {@link list} decrypts nothing, returns no ciphertext, and emits no audit event. It serves the
 * scalars — task type, model, success, the two LENGTHS, opaque ids. It sits on the SAME
 * `read_ai_traces` capability and the same flag as the decrypt, per the owner ruling; the
 * controller header records why, and records the argument for reopening it to `read_entities`
 * so that stays a ruling somebody makes rather than a decision that quietly happened.
 *
 * ── THE DETAIL: THE CONTROL PIPELINE, IN ORDER (any failure discloses NOTHING) ───────────
 *  1. FLAG. `AdminAiTraceFlagGuard` throws a NEUTRAL 404 for EVERY role — ahead of the roles
 *     guard, so a lesser role cannot get a 403 that confirms the surface exists.
 *     {@link isEnabled} is re-checked HERE as defence in depth and throws the same neutral
 *     shape.
 *  2. CAPABILITY. `read_ai_traces`, super_admin ONLY, enforced by `@RequireAdminRole` on the
 *     route (a 403 for a lesser role, which is correct once the flag is on: the route is then
 *     known to exist and the honest answer is "not you"). Re-checked here with `can(...)` for the
 *     same defence-in-depth reason as the flag, and because a service that discloses prompts
 *     should not depend on a decorator it cannot see for its only authorization.
 *  3. EGRESS CAP, charged ONE unit, BEFORE the lookup. Over-cap (or a Redis error) → the neutral
 *     404, and a PII-free `admin.identity_cap_exceeded`-shaped breach is NOT invented here; see
 *     the note on {@link readOne} for why this cap reports through the log rather than a new
 *     event.
 *  4. LOOKUP. An unknown id throws the SAME neutral 404 as every denied case — no enumeration
 *     oracle for trace ids.
 *  5. AUDIT-BEFORE-DECRYPT. `admin.ai_trace_viewed` is emitted and AWAITED before any plaintext
 *     is computed. If the emit FAILS the exception propagates and the decrypt never runs: no
 *     audit row, no text. This is the rule `AdminPiiRevealService` applies to a phone, and it
 *     matters more here because the disclosure is larger.
 *  6. DECRYPT AT THE BOUNDARY. The plaintext exists only in the returned object, on its way to
 *     one HTTP response with `Cache-Control: no-store`. Never logged, cached, persisted or
 *     evented — the audit row carries LENGTHS, which is the same §2 discipline the table itself
 *     follows.
 *
 * ── WHY THE DETAIL THROWS WHERE THE IDENTITY READ DEGRADES ──────────────────────────────
 * `AdminIdentityService` returns `null` on an over-cap read because the same request is ALSO
 * serving the faceless projection every role is entitled to, and an identity control must not
 * take out the `read_entities` floor beside it. This route has no floor beside it: reading the
 * trace is ALL it does, so there is nothing left to serve and the neutral 404 is the honest
 * answer. Same reasoning `AdminPiiRevealService` gives for its own route.
 */
@Injectable()
export class AdminAiTracesService {
  private readonly logger = new Logger(AdminAiTracesService.name);

  constructor(
    private readonly repo: AdminAiTracesRepository,
    private readonly cap: AdminAiTraceCapService,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** True when the trace-read flag is ON. `AdminAiTraceFlagGuard` owns the route-level check. */
  isEnabled(): boolean {
    return this.config.ADMIN_AI_TRACE_READ_ENABLED;
  }

  /**
   * Turn `limit + 1` fetched rows into a page plus an HONEST `nextCursor`.
   *
   * Over-fetching by one is what makes it honest: deriving the cursor from "we returned exactly
   * `limit` rows" produces a phantom next page whenever the total is an exact multiple of the
   * page size, and the operator clicks Next onto an empty screen — which reads as data loss.
   *
   * THE CURSOR TIMESTAMP COMES FROM `sortKey`, NEVER FROM `item.created_at`. That field is a JS
   * `Date` and therefore already millisecond-truncated by the driver; minting a cursor from it
   * skipped every row sharing the boundary millisecond — silently, with a healthy-looking
   * `nextCursor`. See {@link AdminAiTraceListRow}. `sortKey` is Postgres's own full-microsecond
   * rendering of the same instant.
   */
  private static page(
    rows: AdminAiTraceListRow[],
    limit: number,
  ): AdminPage<AdminAiTraceListItem> {
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept[kept.length - 1];
    return {
      items: kept.map((r) => r.item),
      nextCursor:
        hasMore && last
          ? encodeEntityCursor({ createdAt: last.sortKey, id: last.item.id })
          : null,
    };
  }

  /**
   * One page of traces, newest first — PII-FREE.
   *
   * NO AUDIT EVENT, and the asymmetry with `admin.feedback_viewed` is deliberate rather than an
   * omission. That event exists because the feedback list PROJECTS a worker's prose; this list
   * projects lengths and labels, so an event here would record "an admin looked at a page of
   * metadata" — noise in a stream whose value is that every row in it is a real disclosure. The
   * decrypt is what gets audited, because the decrypt is what discloses.
   *
   * A malformed/tampered/truncated cursor is served as the FIRST page rather than a 500: a cursor
   * is client-held state and will arrive hand-edited or clipped by a link shortener eventually.
   */
  async list(
    dto: AdminAiTracesQueryDto,
  ): Promise<AdminPage<AdminAiTraceListItem>> {
    const cursor = decodeEntityCursor(dto.cursor);
    const rows = await this.repo.list(
      { taskType: dto.taskType, success: dto.success, workerId: dto.workerId },
      cursor && UUID_RE.test(cursor.id) ? cursor : null,
      dto.limit + 1,
    );
    return AdminAiTracesService.page(rows, dto.limit);
  }

  /**
   * Read ONE trace, DECRYPTED. Every step below happens before the next; any failure discloses
   * nothing. See the class header for the pipeline and the reasoning behind each step.
   *
   * @param admin the session admin the guard resolved — never a caller-supplied id.
   * @param id the validated path uuid — the non-spoofable target (no IDOR).
   */
  async readOne(
    admin: AuthenticatedAdmin,
    id: string,
    ctx: RequestContext,
  ): Promise<AdminAiTraceDetail> {
    // --- 1. FLAG (defence in depth behind `AdminAiTraceFlagGuard`).
    if (!this.isEnabled()) throw AdminAiTracesService.neutralNotFound();

    // --- 2. CAPABILITY. Deny-by-default via the single-source matrix. The route decorator has
    // already enforced this; a service that hands over prompts does not delegate its only
    // authorization to a decorator in another file.
    if (!can(admin.role, "read_ai_traces")) throw AdminAiTracesService.neutralNotFound();

    // --- 3. EGRESS CAP, one unit, BEFORE the lookup and therefore before any I/O that could
    // itself become a timing signal. Fail-closed on a Redis error (the base class denies).
    //
    // NO BREACH EVENT, unlike the reveal and identity caps, and this is a considered difference
    // rather than a gap. Those two emit `admin.*_cap_exceeded` because their budgets are sized in
    // the tens-to-hundreds and a breach is a plausible ACCIDENT worth distinguishing from abuse.
    // This budget is 20/hour on a route that only a super_admin can reach at all and only while a
    // default-OFF flag is on; there is no ordinary usage that reaches it. Adding a fourth
    // near-identical breach event to the spine for a case that means "a super_admin is reading
    // prompts in bulk" would put a rare, high-signal fact in a stream people already filter. It
    // is logged at WARN with the admin-id PREFIX only, which is where an alert on this belongs.
    // Revisit if the route is ever opened to a second role.
    const capResult = await this.cap.consume(admin.id, 1);
    if (!capResult.ok) {
      this.logger.warn(
        `admin ai-trace decrypt cap exceeded admin_id=${admin.id.slice(0, 8)}… ` +
          `window=${capResult.window} — nothing disclosed`,
      );
      throw AdminAiTracesService.neutralNotFound();
    }

    // --- 4. LOOKUP. Still ciphertext. An unknown id throws the SAME neutral shape as every
    // denied case above, so this route is not an existence oracle for trace ids.
    const row = await this.repo.byId(id);
    if (!row) throw AdminAiTracesService.neutralNotFound();

    // --- 5. AUDIT BEFORE DECRYPT. Awaited; a failure PROPAGATES, so no plaintext is ever
    // computed for a read the spine does not record. The emit is standalone (in no transaction
    // this response could roll back), so the audit row survives even if the decrypt then throws.
    //
    // The payload carries the two LENGTHS and never the text — the same rule the table itself
    // follows, restated on the spine. They come from the SCALARS, which were read before
    // anything was decrypted, so the audited size cannot disagree with the stored one.
    await this.events.emit({
      event_name: "admin.ai_trace_viewed",
      actor: { actor_type: "admin", actor_id: admin.id },
      // The admin SESSION, uniformly — see the payload's own header. The worker is in the
      // payload, where it is honest about being one read rather than a complete index.
      subject: { subject_type: "admin_session", subject_id: admin.id },
      payload: {
        admin_id: admin.id,
        trace_id: row.scalars.id,
        worker_id: row.scalars.worker_id,
        task_type: row.scalars.task_type,
        prompt_chars: row.scalars.prompt_chars,
        response_chars: row.scalars.response_chars,
      } satisfies PayloadInputOf<"admin.ai_trace_viewed">,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // --- 6. DECRYPT AT THE BOUNDARY. The plaintext exists ONLY in the returned object, on its
    // way to one `no-store` HTTP response.
    this.logger.log(
      `admin ai-trace decrypt admin_id=${admin.id.slice(0, 8)}… trace_id=${row.scalars.id.slice(0, 8)}… ` +
        `task=${row.scalars.task_type}`,
    );
    return {
      ...row.scalars,
      prompt: this.decryptOrNull(row.cipher.promptEnc, row.scalars.id),
      response: this.decryptOrNull(row.cipher.responseEnc, row.scalars.id),
    };
  }

  /**
   * Decrypt one token, degrading to `null` rather than failing the whole read.
   *
   * A malformed / rotated-key / tampered token must not 500 the screen — after a key retirement
   * that would take out every trace at once, and the operator would lose the metadata they are
   * still entitled to. `AdminIdentityService` degrades the same way for the same reason.
   *
   * ⚠ THE AMBIGUITY IS ACKNOWLEDGED, NOT HIDDEN: `null` here is indistinguishable from "the
   * column was null" (a call with no reply). The alternative — a distinct error field — would
   * mean the response describing the state of our key material to a caller, and the operator's
   * next action is identical either way. The failure IS distinguishable where it matters, in the
   * log line below, which carries the trace id prefix and never the token (the token is the
   * ciphertext of what a worker said, so it is not a debugging aid, it is the thing being
   * protected).
   */
  private decryptOrNull(token: string | null, traceId: string): string | null {
    if (token === null) return null;
    try {
      return this.pii.decrypt(token);
    } catch {
      this.logger.warn(
        `could not decrypt a stored ai trace column trace_id=${traceId.slice(0, 8)}…; ` +
          `serving it as absent`,
      );
      return null;
    }
  }

  /**
   * The single NEUTRAL non-success shape. A flag that is off, a role that is not super_admin
   * reaching the service anyway, an over-cap denial, a Redis-down fail-closed deny, and an
   * unknown id ALL throw THIS — so none of them is an oracle for any of the others, and none is
   * an oracle for whether the feature exists at all.
   */
  private static neutralNotFound(): HttpException {
    return new NotFoundException("Not found");
  }
}
