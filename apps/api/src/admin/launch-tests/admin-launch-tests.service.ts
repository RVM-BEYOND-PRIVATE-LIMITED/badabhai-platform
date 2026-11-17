import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Database } from "@badabhai/db";
import type { LaunchTestFactoryField, PayloadInputOf } from "@badabhai/event-schema";
import { ADMIN_ACTION_CODES, type AdminActionCode } from "../admin-action-codes";
import type { AuthenticatedAdmin } from "../admin-auth.guard";
import { decodeEntityCursor, encodeEntityCursor } from "../admin-entities.cursor";
import { AdminIdentityService } from "../admin-identity.service";
import { CandidateSearchRepository } from "../../candidates/candidate-search.repository";
import { constraintOf, redactQueryParams, sqlStateOf } from "../../common/db-error";
import { PiiCryptoService } from "../../common/pii-crypto.service";
import type { RequestContext } from "../../common/request-context";
import { EventsService } from "../../events/events.service";
import {
  LAUNCH_TEST_WRITE_REASONS,
  type AdminContactsPerHireReport,
  type AdminLaunchTestCohortPage,
  type AdminLaunchTestCohortQueryDto,
  type AdminLaunchTestFactoryView,
  type AdminLaunchTestRecordDto,
  type AdminLaunchTestRecordResult,
  type AdminLaunchTestUpdateDto,
  type AdminLaunchTestUpdateResult,
  type LaunchTestWriteReason,
  type WorkersNotEligibleBody,
} from "./admin-launch-tests.dto";
import { AdminLaunchTestsRepository, type CohortRow } from "./admin-launch-tests.repository";
import {
  CONTACTS_PER_HIRE_LIMIT,
  REAL_PAYMENT_PROVIDER,
  autoLinkedPayer,
  changedFields,
  cohortIdForKey,
  contactsPerHireReport,
  exceedsShareLimit,
  mergeFactoryPatch,
  paymentOrderRefusal,
  portalRefusal,
  refusalBeforePool,
  refusedWorkers,
  sameCreate,
  stateFingerprint,
  stateRefusal,
  type FactoryPatch,
  type FactoryState,
  type LaunchTestWorkerRefusal,
  type PhoneHolder,
} from "./launch-test-rules";

/** SQLSTATEs that mean the database is older than this build: fail CLOSED with a 503. */
const SCHEMA_BEHIND = new Set(["42P01", "42703"]);
/** Postgres `foreign_key_violation`. */
const PG_FOREIGN_KEY_VIOLATION = "23503";

/** A refused write: an HTTP status and one closed code, with no other detail. */
function refuse(status: 400 | 409, reason: LaunchTestWriteReason, message: string): never {
  const body = {
    statusCode: status,
    error: status === 400 ? "Bad Request" : "Conflict",
    message,
    reason,
  };
  throw status === 400 ? new BadRequestException(body) : new ConflictException(body);
}

/**
 * #2755 part D — the two pre-launch tests' records (items 9 and 10). Reached only through
 * `AdminNumbersEnabledGuard` and `read_business_numbers`, so with `ADMIN_NUMBERS_ENABLED` off none
 * of it runs.
 *
 * ── LAUNCH TEST A (item 9) ─────────────────────────────────────────────────────────────────────
 * The desk records each factory by hand: its name and phone (encrypted here, at the write), its
 * groups, the five workers sent and when, the payment link, and later the result. NOTHING here
 * sends a profile, creates a link or charges money.
 *
 *  - WHO MAY BE SENT: every worker must be in the search pool with his own consent (the search's
 *    own membership statement, `CandidateSearchRepository.findCardRow`, with no company named, so
 *    no named-company grant lets an RVM student in), and never a sample worker, a test account or a
 *    linked RVM identity (part A's rules). One offending worker refuses the whole write: 400
 *    `workers_not_eligible`, naming each one with its closed code.
 *  - OUTSIDE THE PORTAL: a factory whose phone (or named account) is a company CAMPUS CREATED
 *    (`institute_companies`, #2752 item 5) is refused, 409 `campus_company`; the #2754 import
 *    ledger hook answers `portal_import` once it exists. An ordinary BadaBhai company is allowed
 *    and linked (`payer_id`) when it is the one holding the phone.
 *  - AT MOST FIVE SHARES per factory, counted under a lock on the factory row in the write
 *    transaction.
 *  - IDEMPOTENT CREATE: the row's id is derived from the admin and the Idempotency-Key, so a retry
 *    is a replay (`created: false`) and the same key for a different factory is a 409.
 *  - THE EDIT checks the merged row: paid_at iff paid, a link time needs the link, a paid order
 *    needs an account and a paid result, and must be a REAL (Razorpay) order with status `paid` of
 *    that account. A PATCH that changes nothing writes and emits nothing.
 *  - THE NAME is shown only through `AdminIdentityService` (surface `launch_test_factories`):
 *    `read_identity`, the egress cap, `admin.identity_viewed` committed, then the decrypt. Without
 *    it the field is absent. The phone is never returned.
 *  - EVENTS: `admin.launch_test_factory_recorded` / `_updated` and `admin.action_performed`, in the
 *    write's transaction. Ids, counts and closed codes only.
 *
 * ── LAUNCH TEST B (item 10) ────────────────────────────────────────────────────────────────────
 * Read-only: the first 50 confirmed hires and, for each, the contacts its company opened for that
 * posting before the hire, with each contact's follow-up outcome. Ids only.
 */
@Injectable()
export class AdminLaunchTestsService {
  constructor(
    private readonly repo: AdminLaunchTestsRepository,
    private readonly identity: AdminIdentityService,
    private readonly search: CandidateSearchRepository,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
  ) {}

  // -- GET /admin/launch-tests/cohort --------------------------------------------------------

  async listCohort(
    admin: AuthenticatedAdmin,
    query: AdminLaunchTestCohortQueryDto,
    ctx: RequestContext,
  ): Promise<AdminLaunchTestCohortPage> {
    return this.guarded(async () => {
      const cursor = decodeEntityCursor(query.cursor);
      const rows = await this.repo.listCohort(cursor, query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      const next =
        rows.length > query.limit && last !== undefined
          ? encodeEntityCursor({ createdAt: last.sortKey, id: last.id })
          : null;
      const shares = await this.sharesByCohort(page.map((r) => r.id));
      const views = page.map((row) => this.view(row, shares.get(row.id) ?? []));
      // Names are ADDITIVE: null (no read_identity, budget spent, over the bound) leaves every
      // row faceless, byte for byte; the phone is never disclosed on any path.
      const names = await this.identity.resolve(
        admin,
        "launch_test_factories",
        views.map((v) => v.id),
        null,
        ctx,
      );
      if (names !== null) {
        for (const v of views) v.factory_name = names.get(v.id) ?? null;
      }
      return { rows: views, next_cursor: next };
    });
  }

  // -- POST /admin/launch-tests/cohort -------------------------------------------------------

  async recordFactory(
    admin: AuthenticatedAdmin,
    dto: AdminLaunchTestRecordDto,
    idempotencyKey: string,
    ctx: RequestContext,
  ): Promise<AdminLaunchTestRecordResult> {
    return this.guarded(async () => {
      const cohortId = cohortIdForKey(admin.id, idempotencyKey);
      const phoneHash =
        dto.factory_phone === undefined ? null : this.pii.hashPhone(dto.factory_phone);

      // A retry of a create that already landed: the stored row, nothing re-checked or re-written.
      const replay = await this.replay(cohortId, phoneHash, dto);
      if (replay !== null) return replay;

      if (dto.link_created_at !== undefined && dto.payment_link_ref === undefined) {
        refuse(400, "link_created_without_ref", "A link's creation time needs the link");
      }
      const payerId = await this.factoryPayer(phoneHash, dto.payer_id ?? null);
      await this.assertWorkersMaySend(dto.worker_ids);

      const now = new Date();
      const created = await this.writeConflicts(() =>
        this.repo.withTransaction(async (tx) => {
          // Another factory row holding the phone (this key's own row, from a concurrent retry,
          // is the insert's conflict below and answers as a replay instead).
          if (phoneHash !== null && (await this.repo.phoneRecorded(tx, phoneHash, cohortId))) {
            refuse(
              409,
              "factory_already_recorded",
              "A factory with this phone is already recorded",
            );
          }
          const inserted = await this.repo.insertCohort(
            tx,
            {
              id: cohortId,
              factoryNameEnc: this.pii.encrypt(dto.factory_name),
              factoryPhoneEnc:
                dto.factory_phone === undefined ? null : this.pii.encrypt(dto.factory_phone),
              factoryPhoneHash: phoneHash,
              cityGroup: dto.city_group,
              tradeGroup: dto.trade_group,
              payerId,
              sentByAdminId: admin.id,
              sentAt: dto.sent_at,
              paymentLinkRef: dto.payment_link_ref ?? null,
              linkCreatedAt: dto.link_created_at ?? null,
            },
            now,
          );
          // A concurrent request with the same key won the insert: answer as its replay.
          if (!inserted) return false;
          await this.repo.lockCohort(tx, cohortId);
          if (exceedsShareLimit(await this.repo.countShares(tx, cohortId), dto.worker_ids.length)) {
            refuse(409, "share_limit_exceeded", "A factory is sent at most five workers");
          }
          await this.repo.insertShares(tx, cohortId, dto.worker_ids, dto.sent_at);
          await this.emitRecorded(tx, admin, cohortId, dto, payerId, ctx);
          return true;
        }),
      );
      if (!created) {
        const raced = await this.replay(cohortId, phoneHash, dto);
        if (raced !== null) return raced;
        throw new Error("launch tests: the key's factory row vanished after a conflicting insert");
      }
      return { factory: await this.read(cohortId), created: true };
    });
  }

  // -- PATCH /admin/launch-tests/cohort/:id --------------------------------------------------

  async updateFactory(
    admin: AuthenticatedAdmin,
    cohortId: string,
    dto: AdminLaunchTestUpdateDto,
    idempotencyKey: string,
    ctx: RequestContext,
  ): Promise<AdminLaunchTestUpdateResult> {
    return this.guarded(async () => {
      const patch = toPatch(dto);
      const changed = await this.writeConflicts(() =>
        this.repo.withTransaction(async (tx) => {
          const current = await this.repo.lockCohort(tx, cohortId);
          if (current === undefined) throw new NotFoundException();
          const next = mergeFactoryPatch(current, patch);
          const fields = changedFields(current, next);
          if (fields.length === 0) return false;

          const broken = stateRefusal(next);
          if (broken !== null) refuse(400, broken, "The record would break a launch-test rule");
          if (fields.includes("payer") && next.payerId !== null) {
            await this.assertAccountAllowed(next.payerId, tx);
          }
          if (
            next.paymentOrderId !== null &&
            (fields.includes("payment_order") || fields.includes("payer"))
          ) {
            const order = await this.repo.paymentOrder(tx, next.paymentOrderId);
            // `payment_order_without_payer` above guarantees an account here.
            const bad = paymentOrderRefusal(order, next.payerId!, REAL_PAYMENT_PROVIDER);
            if (bad !== null) {
              refuse(409, bad, "Only a real paid order of the factory's own account can be linked");
            }
            if (await this.repo.orderLinkedElsewhere(tx, next.paymentOrderId, cohortId)) {
              refuse(
                409,
                "payment_order_already_linked",
                "That order is linked to another factory",
              );
            }
          }

          await this.repo.updateCohort(tx, cohortId, next, admin.id, new Date());
          await this.emitUpdated(tx, admin, cohortId, fields, next, idempotencyKey, ctx);
          return true;
        }),
      );
      return { factory: await this.read(cohortId), changed };
    });
  }

  // -- GET /admin/launch-tests/contacts-per-hire ---------------------------------------------

  async contactsPerHire(): Promise<AdminContactsPerHireReport> {
    return this.guarded(async () => {
      const { hires, contacts } = await this.repo.contactsPerHire(CONTACTS_PER_HIRE_LIMIT);
      return { limit: CONTACTS_PER_HIRE_LIMIT, ...contactsPerHireReport(hires, contacts) };
    });
  }

  // -- internals: the checks -----------------------------------------------------------------

  /**
   * The account a new factory row links, after the "outside the portal" check: refused when a
   * company holding its phone, or the account named, is a Campus company (or the #2754 import
   * ledger holds the phone); the named account must exist; with none named, the one ordinary
   * company holding the phone is linked.
   */
  private async factoryPayer(
    phoneHash: string | null,
    named: string | null,
  ): Promise<string | null> {
    const holders = phoneHash === null ? [] : await this.repo.phoneHolders(phoneHash);
    const imported = phoneHash === null ? false : await this.repo.importedFromPortal(phoneHash);
    this.assertOutsidePortal(holders, imported);
    if (named === null) return autoLinkedPayer(holders);
    await this.assertAccountAllowed(named);
    return named;
  }

  /** A named account must exist and must not be a Campus company. */
  private async assertAccountAllowed(payerId: string, tx?: Database): Promise<void> {
    const account = await this.repo.payerFacts(payerId, tx);
    if (account === undefined) refuse(400, "payer_not_found", "No such company account");
    this.assertOutsidePortal([account], false);
  }

  private assertOutsidePortal(holders: readonly PhoneHolder[], imported: boolean): void {
    const refusal = portalRefusal(holders, imported);
    if (refusal === "campus_company") {
      refuse(409, refusal, "This factory is a Campus company, not one outside the portal");
    }
    if (refusal === "portal_import") {
      refuse(409, refusal, "This factory came over from the RVM portal");
    }
  }

  /**
   * Every requested worker may be sent, or the whole write is refused with each offender named.
   * The non-pool rules first (one read); the pool is asked only for the workers that pass them.
   */
  private async assertWorkersMaySend(workerIds: readonly string[]): Promise<void> {
    const facts = new Map((await this.repo.workerFacts(workerIds)).map((f) => [f.workerId, f]));
    const answers = new Map<string, LaunchTestWorkerRefusal | null>();
    for (const workerId of workerIds) {
      const fact = facts.get(workerId) ?? {
        workerId,
        exists: false,
        testWorker: false,
        linkedRvmIdentity: false,
      };
      const before = refusalBeforePool(fact);
      answers.set(
        workerId,
        before ??
          ((await this.search.findCardRow(workerId)) === null ? "not_in_search_pool" : null),
      );
    }
    const refused = refusedWorkers(workerIds, answers);
    if (refused.length > 0) {
      const body: WorkersNotEligibleBody = {
        statusCode: 400,
        error: "Bad Request",
        message: "One or more workers may not be sent to a launch-test factory",
        reason: "workers_not_eligible",
        workers: refused,
      };
      throw new BadRequestException(body);
    }
  }

  /** The stored row for a replayed create, or null when the key has made no row yet. */
  private async replay(
    cohortId: string,
    phoneHash: string | null,
    dto: AdminLaunchTestRecordDto,
  ): Promise<AdminLaunchTestRecordResult | null> {
    const stored = await this.repo.replayFacts(cohortId, phoneHash);
    if (stored === undefined) return null;
    const asked = {
      phoneHash,
      cityGroup: dto.city_group,
      tradeGroup: dto.trade_group,
      sentAtMs: dto.sent_at.getTime(),
      workerIds: dto.worker_ids,
    };
    const same = sameCreate(
      {
        // The hash itself never leaves the database: equal hashes are compared there.
        phoneHash: stored.samePhone ? phoneHash : `different:${phoneHash ?? "none"}`,
        cityGroup: stored.cityGroup,
        tradeGroup: stored.tradeGroup,
        sentAtMs: stored.sentAt.getTime(),
        workerIds: stored.workerIds,
      },
      asked,
    );
    if (!same) {
      refuse(
        409,
        LAUNCH_TEST_WRITE_REASONS.keyReused,
        "This Idempotency-Key recorded a different factory",
      );
    }
    return { factory: await this.read(cohortId), created: false };
  }

  // -- internals: reads, events, errors ------------------------------------------------------

  private async read(cohortId: string): Promise<AdminLaunchTestFactoryView> {
    const row = await this.repo.findCohort(cohortId);
    if (row === undefined) throw new NotFoundException();
    const shares = await this.sharesByCohort([cohortId]);
    return this.view(row, shares.get(cohortId) ?? []);
  }

  private async sharesByCohort(cohortIds: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (const s of await this.repo.sharesFor(cohortIds)) {
      const list = out.get(s.cohortId) ?? [];
      list.push(s.workerId);
      out.set(s.cohortId, list);
    }
    return out;
  }

  private view(row: CohortRow, workerIds: string[]): AdminLaunchTestFactoryView {
    return {
      id: row.id,
      has_phone: row.hasPhone,
      city_group: row.cityGroup,
      trade_group: row.tradeGroup,
      payer_id: row.payerId,
      sent_by_admin_id: row.sentByAdminId,
      sent_at: row.sentAt,
      payment_link_ref: row.paymentLinkRef,
      link_created_at: row.linkCreatedAt,
      result: row.result,
      paid_at: row.paidAt,
      payment_order_id: row.paymentOrderId,
      share_count: workerIds.length,
      worker_ids: workerIds,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      updated_by_admin_id: row.updatedByAdminId,
    };
  }

  private async emitRecorded(
    tx: Database,
    admin: AuthenticatedAdmin,
    cohortId: string,
    dto: AdminLaunchTestRecordDto,
    payerId: string | null,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"admin.launch_test_factory_recorded"> = {
      cohort_id: cohortId,
      admin_id: admin.id,
      share_count: dto.worker_ids.length,
      has_phone: dto.factory_phone !== undefined,
      payer_id: payerId,
    };
    await this.events.emit({
      event_name: "admin.launch_test_factory_recorded",
      actor: { actor_type: "admin", actor_id: admin.id },
      // The admin SESSION: a launch-test factory is not a platform entity (it may have no account).
      subject: { subject_type: "admin_session", subject_id: admin.id },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `admin.launch_test_factory_recorded:${cohortId}`,
      tx,
    });
    await this.emitAction(
      tx,
      admin.id,
      cohortId,
      ADMIN_ACTION_CODES.launch_test_factory_recorded,
      cohortId,
      ctx,
    );
  }

  private async emitUpdated(
    tx: Database,
    admin: AuthenticatedAdmin,
    cohortId: string,
    fields: LaunchTestFactoryField[],
    next: FactoryState,
    idempotencyKey: string,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"admin.launch_test_factory_updated"> = {
      cohort_id: cohortId,
      admin_id: admin.id,
      changed: fields,
      result: next.result,
      payer_id: next.payerId,
      payment_order_id: next.paymentOrderId,
    };
    // The key AND the state it moved to: a retry dedupes, a reused key for another change does not.
    const once = `${cohortId}:${idempotencyKey}:${stateFingerprint(next)}`;
    await this.events.emit({
      event_name: "admin.launch_test_factory_updated",
      actor: { actor_type: "admin", actor_id: admin.id },
      subject: { subject_type: "admin_session", subject_id: admin.id },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `admin.launch_test_factory_updated:${once}`,
      tx,
    });
    await this.emitAction(
      tx,
      admin.id,
      cohortId,
      ADMIN_ACTION_CODES.launch_test_factory_updated,
      once,
      ctx,
    );
  }

  private emitAction(
    tx: Database,
    adminId: string,
    cohortId: string,
    actionCode: AdminActionCode,
    once: string,
    ctx: RequestContext,
  ): Promise<unknown> {
    const payload: PayloadInputOf<"admin.action_performed"> = {
      admin_id: adminId,
      action_code: actionCode,
      target_type: "launch_test_cohort",
      target_id: cohortId,
    };
    return this.events.emit({
      event_name: "admin.action_performed",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "admin_session", subject_id: adminId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `admin_action:${actionCode}:${adminId}:${once}`,
      tx,
    });
  }

  /**
   * A write's unique and foreign-key races, as the closed codes the pre-checks give: another
   * request recorded the same phone or linked the same order between the check and the write, or
   * the account vanished. Anything else is rethrown, its bound parameters redacted (they carry
   * ciphertext).
   */
  private async writeConflicts<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      const state = sqlStateOf(err);
      const constraint = constraintOf(err);
      if (state === "23505" && constraint === "launch_test_cohort_phone_hash_uq") {
        refuse(409, "factory_already_recorded", "A factory with this phone is already recorded");
      }
      if (state === "23505" && constraint === "launch_test_cohort_payment_order_uq") {
        refuse(409, "payment_order_already_linked", "That order is linked to another factory");
      }
      if (
        state === PG_FOREIGN_KEY_VIOLATION &&
        constraint === "launch_test_cohort_payer_id_payers_id_fk"
      ) {
        refuse(400, "payer_not_found", "No such company account");
      }
      throw redactQueryParams(err, "launch test factory write");
    }
  }

  /**
   * FAIL CLOSED on a database older than this build (either table, or a #2753 table Test B reads,
   * missing): a 503, never a half-written record. Anything else is rethrown as it is.
   */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      const state = sqlStateOf(err);
      if (state !== undefined && SCHEMA_BEHIND.has(state)) {
        throw new ServiceUnavailableException("the launch-test records' schema is not applied yet");
      }
      throw err;
    }
  }
}

/** The PATCH body as the rules' patch: absent stays absent, null clears. */
function toPatch(dto: AdminLaunchTestUpdateDto): FactoryPatch {
  return {
    paymentLinkRef: dto.payment_link_ref,
    linkCreatedAt: dto.link_created_at,
    result: dto.result,
    paidAt: dto.paid_at,
    payerId: dto.payer_id,
    paymentOrderId: dto.payment_order_id,
  };
}
