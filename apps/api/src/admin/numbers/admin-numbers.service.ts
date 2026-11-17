import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  areRealPaymentsEnabled,
  realPaymentsBlockedReason,
  type ServerConfig,
} from "@badabhai/config";
import type { Database } from "@badabhai/db";
import type { PayerTestAccountReason, PayloadInputOf } from "@badabhai/event-schema";
import { ADMIN_ACTION_CODES, type AdminActionCode } from "../admin-action-codes";
import type { AuthenticatedAdmin } from "../admin-auth.guard";
import type { PaymentsPosture } from "../admin-finance.dto";
import { ADMIN_FUNNEL_K_ANON_FLOOR } from "../admin-funnel.dto";
import { sqlStateOf } from "../../common/db-error";
import type { RequestContext } from "../../common/request-context";
import { SERVER_CONFIG } from "../../config/config.module";
import { EventsService } from "../../events/events.service";
import type {
  AdminNumbersDefinitions,
  AdminNumbersMarkTestAccountDto,
  AdminPayerTestAccountResult,
} from "./admin-numbers.dto";
import { AdminNumbersRepository, type TestAccountWrite } from "./admin-numbers.repository";
import { NUMBERS_METRIC_GROUPS } from "./definitions";
import {
  NUMBERS_CITY_GROUP_LABELS,
  NUMBERS_CITY_GROUP_MEMBERS,
  NUMBERS_CITY_GROUP_TITLES,
  NUMBERS_DEFINITION_VERSION,
  NUMBERS_LAUNCH_CITY_GROUPS,
  NUMBERS_LAUNCH_TRADE_GROUPS,
  NUMBERS_TRADE_GROUP_LABELS,
  NUMBERS_TRADE_GROUP_MEMBERS,
  NUMBERS_TRADE_GROUP_TITLES,
  type NumbersLaunchCityGroup,
  type NumbersLaunchTradeGroup,
} from "./groups";
import { NUMBERS_WEEK_RULE } from "./week";

/** SQLSTATEs that mean the database is older than this build: fail CLOSED with a 503. */
const SCHEMA_BEHIND = new Set(["42P01", "42703"]);

/** Who marked a company: an admin on the route, or the backfill (no admin). */
export type TestAccountMarker =
  | { readonly kind: "admin"; readonly admin: AuthenticatedAdmin }
  | { readonly kind: "backfill" };

/**
 * #2755 — the numbers screen's service (part A): the definitions catalogue and the test-company
 * marks. Reached only through `AdminNumbersEnabledGuard` and `read_business_numbers`, so with
 * `ADMIN_NUMBERS_ENABLED` off none of it runs. The backfill CLI calls {@link mark} directly, so
 * the route and the CLI write and emit the same way.
 *
 * THE MARK IS `payers.is_test_account`, the one company test marker (migration 0162, #2746), and
 * ONE TRANSACTION holds the row change, `admin.payer_test_account_marked|unmarked` and (for an
 * admin) `admin.action_performed`. A re-mark or a second unmark is `changed: false`: no row
 * moves, no event is written.
 */
@Injectable()
export class AdminNumbersService {
  constructor(
    private readonly repo: AdminNumbersRepository,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * Whether money on this screen is real — the finance summary's posture, from the SAME config
   * helpers the kill-switch surface uses, so the two screens can never disagree.
   */
  private posture(): PaymentsPosture {
    return {
      mode: areRealPaymentsEnabled(this.config) ? "real" : "mock",
      blocked_reason: realPaymentsBlockedReason(this.config),
    };
  }

  /** `GET /admin/numbers/definitions` — the catalogue, as code holds it. Reads no table. */
  definitions(): AdminNumbersDefinitions {
    return {
      definition_version: NUMBERS_DEFINITION_VERSION,
      week: {
        rule: NUMBERS_WEEK_RULE,
        time_zone: "Asia/Kolkata",
        utc_offset: "+05:30",
        starts_on: "monday",
      },
      cities: {
        normalisation:
          "A stored city is read in lower case, up to its first comma, with hyphens, dots and " +
          "underscores as spaces and runs of spaces collapsed, then matched against the members.",
        buckets:
          "A city given but not a member of a launch group is 'other'; no city is 'unknown'. " +
          "'all' is the roll-up of every group.",
        groups: NUMBERS_CITY_GROUP_LABELS.map((id) => ({
          id,
          title: NUMBERS_CITY_GROUP_TITLES[id],
          members: (NUMBERS_LAUNCH_CITY_GROUPS as readonly string[]).includes(id)
            ? [...NUMBERS_CITY_GROUP_MEMBERS[id as NumbersLaunchCityGroup]]
            : [],
        })),
      },
      trades: {
        buckets:
          "A known trade outside the launch split is 'other'; no trade, or a key this code does " +
          "not know, is 'unknown'. A group is the trade, never the level. 'all' is the roll-up.",
        groups: NUMBERS_TRADE_GROUP_LABELS.map((id) => {
          const launch = (NUMBERS_LAUNCH_TRADE_GROUPS as readonly string[]).includes(id)
            ? NUMBERS_TRADE_GROUP_MEMBERS[id as NumbersLaunchTradeGroup]
            : null;
          return {
            id,
            title: NUMBERS_TRADE_GROUP_TITLES[id],
            role_kinds: launch ? [...launch.roleKinds] : [],
            taxonomy_roles: launch ? [...launch.taxonomyRoles] : [],
          };
        }),
      },
      exclusions: {
        companies:
          "A company marked as a test company (payers.is_test_account) never counts, nor do its " +
          "orders, postings, hires or credits.",
        workers:
          "Test accounts (workers.is_test_account), sample workers (seeded ids) and linked RVM " +
          "identities that never signed in never count.",
      },
      metric_groups: NUMBERS_METRIC_GROUPS.map((g) => ({
        ...g,
        metrics: g.metrics.map((m) => ({ ...m, availability: { ...m.availability } })),
      })),
      small_cell_floor: ADMIN_FUNNEL_K_ANON_FLOOR,
      payments: this.posture(),
    };
  }

  /** `PUT /admin/numbers/test-accounts/:payerId` — mark a company as a test company. */
  markByAdmin(
    admin: AuthenticatedAdmin,
    payerId: string,
    dto: AdminNumbersMarkTestAccountDto,
    idempotencyKey: string,
    ctx: RequestContext,
  ): Promise<AdminPayerTestAccountResult> {
    return this.mark(payerId, dto.reason, { kind: "admin", admin }, idempotencyKey, ctx);
  }

  /**
   * Mark a company as a test company, with its reason. Shared by the route and the backfill. A
   * company already marked is `changed: false` (its first reason stands: to change the reason,
   * unmark and mark again). An unknown company is a 404.
   */
  async mark(
    payerId: string,
    reason: PayerTestAccountReason,
    by: TestAccountMarker,
    idempotencyKey: string,
    ctx: RequestContext,
  ): Promise<AdminPayerTestAccountResult> {
    const adminId = by.kind === "admin" ? by.admin.id : null;
    const write = await this.guarded(() =>
      this.repo.withTransaction(async (tx) => {
        const moved = await this.repo.setTestAccount(tx, payerId, true);
        if (moved !== "changed") return moved;
        const payload: PayloadInputOf<"admin.payer_test_account_marked"> = {
          payer_id: payerId,
          reason,
          admin_id: adminId,
        };
        await this.events.emit({
          event_name: "admin.payer_test_account_marked",
          actor:
            adminId === null
              ? { actor_type: "system", actor_id: null }
              : { actor_type: "admin", actor_id: adminId },
          subject: { subject_type: "payer", subject_id: payerId },
          payload,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          idempotencyKey: `admin.payer_test_account_marked:${payerId}:${idempotencyKey}`,
          tx,
        });
        if (adminId !== null) {
          await this.emitAction(
            tx,
            adminId,
            payerId,
            ADMIN_ACTION_CODES.payer_test_account_marked,
            ctx,
          );
        }
        return moved;
      }),
    );
    return this.result(payerId, true, write);
  }

  /** `DELETE /admin/numbers/test-accounts/:payerId` — the company counts again. */
  async unmarkByAdmin(
    admin: AuthenticatedAdmin,
    payerId: string,
    ctx: RequestContext,
  ): Promise<AdminPayerTestAccountResult> {
    const write = await this.guarded(() =>
      this.repo.withTransaction(async (tx) => {
        const moved = await this.repo.setTestAccount(tx, payerId, false);
        if (moved !== "changed") return moved;
        const payload: PayloadInputOf<"admin.payer_test_account_unmarked"> = {
          payer_id: payerId,
          admin_id: admin.id,
        };
        await this.events.emit({
          event_name: "admin.payer_test_account_unmarked",
          actor: { actor_type: "admin", actor_id: admin.id },
          subject: { subject_type: "payer", subject_id: payerId },
          payload,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          idempotencyKey: `admin.payer_test_account_unmarked:${payerId}:${ctx.requestId}`,
          tx,
        });
        await this.emitAction(
          tx,
          admin.id,
          payerId,
          ADMIN_ACTION_CODES.payer_test_account_unmarked,
          ctx,
        );
        return moved;
      }),
    );
    return this.result(payerId, false, write);
  }

  // -- internals ----------------------------------------------------------------------------

  private result(
    payerId: string,
    on: boolean,
    write: TestAccountWrite,
  ): AdminPayerTestAccountResult {
    if (write === "not_found") throw new NotFoundException();
    return { payer_id: payerId, is_test_account: on, changed: write === "changed" };
  }

  /**
   * FAIL CLOSED on a database older than this build (the marker's column or table missing): a 503,
   * never a half-written mark. Anything else is rethrown as it is.
   */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      const state = sqlStateOf(err);
      if (state !== undefined && SCHEMA_BEHIND.has(state)) {
        throw new ServiceUnavailableException("the numbers screen's schema is not applied yet");
      }
      throw err;
    }
  }

  private emitAction(
    tx: Database,
    adminId: string,
    payerId: string,
    actionCode: AdminActionCode,
    ctx: RequestContext,
  ): Promise<unknown> {
    const payload: PayloadInputOf<"admin.action_performed"> = {
      admin_id: adminId,
      action_code: actionCode,
      target_type: "payer",
      target_id: payerId,
    };
    return this.events.emit({
      event_name: "admin.action_performed",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "payer", subject_id: payerId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `admin_action:${actionCode}:${adminId}:${payerId}:${ctx.requestId}`,
      tx,
    });
  }
}
