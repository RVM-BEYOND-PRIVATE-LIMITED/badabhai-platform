import { Injectable, Logger } from "@nestjs/common";
import type { AdminIdentitySurface, PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { can } from "./admin-capabilities";
import { AdminIdentityCapService } from "./admin-identity-cap.service";
import { AdminIdentityRepository, type AdminIdentityRow } from "./admin-identity.repository";
import type { AdminEgressCapWindow } from "./admin-egress-cap.service";

/**
 * `id → name` for the subjects whose names were disclosed. A name is `null` when the row exists
 * but nobody has ever recorded a name for it, which is an ANSWER, not an absence.
 */
export type AdminIdentityMap = ReadonlyMap<string, string | null>;

/**
 * HARD upper bound on how many names ONE response may disclose (owner ruling 2026-08-18).
 *
 * It lives HERE, at the single decrypt boundary, rather than only in each caller's page size,
 * because a bound that every caller has to remember is a bound the next caller forgets. The
 * paged entity lists clamp to this number so a permitted admin gets a full 50-row named page
 * (`ADMIN_IDENTITY_PAGE_MAX` in `admin-entities.dto.ts` is the same constant, re-exported for
 * the DTO layer); this check is the backstop that makes the bound TRUE for every caller —
 * including one added later that forgets to clamp, which is exactly the case a source scan
 * cannot see and a page-size default cannot stop.
 *
 * Over the bound the read discloses NOTHING — not "the first fifty". A partially-named page
 * would report the unnamed rows as `name: null`, which on this contract MEANS "disclosed, and
 * nobody has recorded a name" — a lie that looks like data. Absent-for-all is the one honest
 * degradation, and it is the state the client already knows how to render.
 */
export const ADMIN_IDENTITY_MAX_SUBJECTS = 50;

/**
 * The one place a stored NAME becomes plaintext on the admin surface (owner ruling 2026-08-18,
 * reversing ADR-0025 Decision 4 — the console was unusable when every row was an opaque uuid).
 *
 * Every admin read that shows names calls {@link resolve} and merges the result into its own
 * DTO field (`full_name` / `org_name` / `name`). Consolidating the control pipeline here rather
 * than repeating it per surface is the point: there is exactly one implementation of "may this
 * admin see names, has their budget room, has the audit row committed, and only then decrypt".
 *
 * ── THE CONTROL PIPELINE, IN ORDER (any failure discloses NOTHING) ───────────────────────
 *  1. CAPABILITY — an explicit `can(admin.role, "read_identity")` over the SESSION admin the
 *     guard already resolved. Not a second `@RequireAdminRole`: the routes must stay reachable
 *     on `read_entities` for all four roles (names are ADDITIVE), and the guard sets exactly one
 *     capability per route by design. A role without it gets `null` here and therefore today's
 *     faceless response, byte for byte — no cap consumed, no event emitted, nothing to explain.
 *  2. RESPONSE BOUND — at most {@link ADMIN_IDENTITY_MAX_SUBJECTS} names per response, enforced
 *     HERE so no caller can page around it. Over the bound: nothing disclosed, nothing charged,
 *     nothing audited.
 *  3. CIPHERTEXT LOOKUP — the repository returns `(id, token|null)`. Still encrypted.
 *  4. COUNT — `result_count` = how many tokens are NON-NULL, i.e. how many names this response
 *     will actually disclose. Counted from the CIPHERTEXT, before any plaintext exists.
 *  5. EGRESS CAP, charged `result_count` — a page of fifty names costs fifty. Over-cap (or a
 *     Redis error) → emit the PII-free `admin.identity_cap_exceeded` breach and return `null`.
 *  6. AUDIT-BEFORE-DECRYPT — emit `admin.identity_viewed` and AWAIT its commit BEFORE any
 *     plaintext is computed. If the emit FAILS the exception propagates and we never reach the
 *     decrypt: fail closed, exactly as `AdminPiiRevealService` does for the phone.
 *  7. DECRYPT-AT-BOUNDARY — transiently, into the returned map and nowhere else. Never logged,
 *     cached, persisted, or put on any event.
 *
 * ── WHY AN OVER-CAP READ DEGRADES INSTEAD OF FAILING ─────────────────────────────────────
 * The reveal route answers a neutral 404 when its cap trips, because a reveal is all that route
 * does. Here the same request is ALSO serving the `read_entities` floor that all four roles
 * hold, and throwing would mean an identity control taking out the faceless read beside it —
 * re-coupling exactly what splitting `read_identity` off `read_entities` exists to separate. An
 * ops_admin who has spent their name budget must still be able to list payers and suspend one.
 *
 * The degraded response is not ambiguous, because the client already knows whether it holds
 * `read_identity` (`GET /admin/me` says so). Field absent + capability held ⇒ capped; field
 * absent + capability absent ⇒ not entitled; field present and null ⇒ this person has no name
 * on record. Three distinguishable states, no new response contract.
 *
 * ── AUDIT GRANULARITY: ONE EVENT PER RESPONSE, NEVER PER SUBJECT ─────────────────────────
 * Fifty rows per page view would be write amplification, and — the real reason — it would turn
 * the append-only spine into a queryable index of "which workers has anyone looked at". That
 * inference surface does not exist today; a privacy control must not be the thing that creates
 * it. See the payload's own header.
 */
@Injectable()
export class AdminIdentityService {
  private readonly logger = new Logger(AdminIdentityService.name);

  constructor(
    private readonly repo: AdminIdentityRepository,
    private readonly cap: AdminIdentityCapService,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
  ) {}

  /** True when this admin may see names at all. Cheap, side-effect-free, and fail-closed. */
  isPermitted(admin: AuthenticatedAdmin): boolean {
    return can(admin.role, "read_identity");
  }

  /**
   * Resolve the names for `ids` on `surface`, or `null` when none may be disclosed.
   *
   * `null` covers "this role holds no `read_identity`", "this admin is over their name budget",
   * and "this response would exceed {@link ADMIN_IDENTITY_MAX_SUBJECTS}" — one return value,
   * because the caller's job is identical in all three: serve the faceless projection. They are
   * told apart where it matters — on the spine (only the budget case emits a breach), in the
   * client (only the capability case is knowable from `GET /admin/me`), and in the logs (only
   * the bound case logs at ERROR, because only it is a caller bug).
   *
   * @param subjectId the single entity on a DETAIL read; `null` on a list read. It lands in the
   *   audit payload — never in the envelope subject, which is uniformly the admin session so the
   *   spine cannot be mistaken for a complete per-worker "who looked at me" index.
   */
  async resolve(
    admin: AuthenticatedAdmin,
    surface: AdminIdentitySurface,
    ids: readonly string[],
    subjectId: string | null,
    ctx: RequestContext,
  ): Promise<AdminIdentityMap | null> {
    // --- 1. CAPABILITY. Deny-by-default via the single-source matrix; no cap, no event.
    if (!this.isPermitted(admin)) return null;

    // --- 2. RESPONSE BOUND. Fail closed above the cap — see ADMIN_IDENTITY_MAX_SUBJECTS. No
    // query, no budget, no `identity_viewed` row: nothing was disclosed, so nothing is recorded.
    // Deliberately NOT an `identity_cap_exceeded` breach either — that event means "this
    // ACCOUNT's velocity tripped a budget", and filing a caller-side bound under it would put
    // noise in the stream a reviewer is meant to read as an alert. Logged at ERROR because it
    // is a CALLER bug (a name-bearing list that forgot to clamp), not admin behaviour.
    if (ids.length > ADMIN_IDENTITY_MAX_SUBJECTS) {
      this.logger.error(
        `identity read asked for ${ids.length} subjects on surface=${surface} (max ` +
          `${ADMIN_IDENTITY_MAX_SUBJECTS}); disclosing NO names. Clamp the caller's page size.`,
      );
      return null;
    }

    // --- 3. CIPHERTEXT LOOKUP. Nothing decrypted yet.
    const rows = await this.fetch(surface, ids);

    // --- 4. COUNT, from the ciphertext. How many names this response will actually disclose —
    // NOT the page size. A page of workers who never gave us a name discloses nothing, and
    // charging the budget (or auditing a count) for it would describe reading that never
    // happened. `result_count` and the cap charge are the SAME number by construction.
    const resultCount = rows.reduce((n, r) => (r.nameCipher === null ? n : n + 1), 0);

    // --- 5. EGRESS CAP, charged per disclosure. Fail-closed on a Redis error.
    const capResult = await this.cap.consume(admin.id, resultCount);
    if (!capResult.ok) {
      await this.emitCapExceeded(admin.id, capResult.window, ctx);
      return null;
    }

    // --- 6. AUDIT BEFORE DECRYPT. Awaited; a failure PROPAGATES, so no name is ever computed
    // for a read the spine does not record.
    await this.events.emit({
      event_name: "admin.identity_viewed",
      actor: { actor_type: "admin", actor_id: admin.id },
      // The admin SESSION, uniformly — see the class header and the payload's.
      subject: { subject_type: "admin_session", subject_id: admin.id },
      payload: {
        admin_id: admin.id,
        surface,
        subject_id: subjectId,
        result_count: resultCount,
      } satisfies PayloadInputOf<"admin.identity_viewed">,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // --- 7. DECRYPT AT THE BOUNDARY. The plaintext exists ONLY in the returned map, on its way
    // to the HTTP response — never logged, cached, persisted, or evented.
    const out = new Map<string, string | null>();
    for (const row of rows) out.set(row.id, this.decryptOrNull(row, surface));
    return out;
  }

  /** Dispatch to the one projection this surface is allowed to read. */
  private fetch(surface: AdminIdentitySurface, ids: readonly string[]): Promise<AdminIdentityRow[]> {
    const list = [...ids];
    switch (surface) {
      case "workers":
        return this.repo.workerNames(list);
      case "payers":
        return this.repo.payerOrgNames(list);
      case "admins":
        return this.repo.adminNames(list);
    }
  }

  /**
   * Decrypt one token, degrading to `null` rather than failing the whole read.
   *
   * A malformed / rotated-key / tampered token must not 500 an operations list — after a key
   * rotation that would take out every row on the screen at once, and the operator would lose
   * the faceless data too. Degrading matches what the resume and disclosure paths already do
   * with the same column. The token and the underlying error are NEVER logged (the token is the
   * ciphertext of the name); only the opaque id prefix and the surface are.
   */
  private decryptOrNull(row: AdminIdentityRow, surface: AdminIdentitySurface): string | null {
    if (row.nameCipher === null) return null;
    try {
      return this.pii.decrypt(row.nameCipher);
    } catch {
      this.logger.warn(
        `could not decrypt the stored name on surface=${surface} id=${row.id.slice(0, 8)}…; serving it as unnamed`,
      );
      return null;
    }
  }

  /**
   * Emit the PII-FREE `admin.identity_cap_exceeded` breach. Subject is the admin session whose
   * velocity tripped the cap; the payload is the opaque admin id + which window ONLY — never a
   * subject id, a surface, or any name. Awaited: a breach that failed to record is not a breach
   * anyone will ever see, and the caller is already discarding the names either way.
   */
  private async emitCapExceeded(
    adminId: string,
    window: AdminEgressCapWindow,
    ctx: RequestContext,
  ): Promise<void> {
    this.logger.warn(
      `admin identity cap exceeded admin_id=${adminId.slice(0, 8)}… window=${window} — names withheld`,
    );
    await this.events.emit({
      event_name: "admin.identity_cap_exceeded",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "admin_session", subject_id: adminId },
      payload: { admin_id: adminId, window } satisfies PayloadInputOf<"admin.identity_cap_exceeded">,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }
}
