import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { TradeReleaseRow } from "@badabhai/db";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { TradeReleaseRepository } from "./trade-release.repository";

/** One trade's release flags as the admin screen reads them. */
export interface TradeReleaseView {
  readonly role_kind: string;
  readonly posting_enabled: boolean;
  readonly form_enabled: boolean;
  readonly updated_by: string | null;
  readonly updated_at: string | null;
}

/** The answer to a set: the trade's flags after the call, and whether it changed. */
export interface SetTradeReleaseResult {
  readonly release: TradeReleaseView;
  readonly changed: boolean;
}

const UNDEFINED_TABLE = "42P01";

/** The switch cache lives this long; a set clears it, so an admin sees his own change at once. */
const CACHE_TTL_MS = 30_000;

/**
 * #3002 — the per-trade release switch. Standing rule: everything ships off. Each trade has a
 * switch the owner flips without a release; the migration seeds the 16 live posting kinds with
 * `posting_enabled = true`, and every other kind has no row and reads as off.
 *
 * Readers (wired in their own issues): the posting catalogue and posting validation (#3005,
 * #3006) read `isPostingEnabled`; the Campus translation target (#3014) and the trade-form
 * hand-over read `isFormEnabled`.
 *
 * WHAT THIS SWITCH DOES NOT GATE: a worker reaching a form in chat. That is decided by the
 * seeded phrases and code bindings — a trade with no seeded phrases is reached by nobody — so
 * flipping a switch never drops a worker mid-interview, and switching a trade on does not put
 * its form in front of anyone until its phrases and codes ship.
 *
 * FAIL-CLOSED reads: a read error answers off and logs the kind only (`role_kind` is trade
 * policy, not PII). The admin write answers 503 while the table is missing.
 */
@Injectable()
export class TradeReleaseService {
  private readonly logger = new Logger(TradeReleaseService.name);
  private cachedAt: number | null = null;
  private cachedRows: Map<string, TradeReleaseRow> | null = null;

  constructor(
    private readonly repo: TradeReleaseRepository,
    private readonly events: EventsService,
  ) {}

  /** May companies post this trade (#3005, #3006 read this). No row, or a read error: off. */
  async isPostingEnabled(roleKind: string): Promise<boolean> {
    return (await this.rowFor(roleKind))?.postingEnabled ?? false;
  }

  /** Is this trade's form live in the hand-over (#3014 and the form hand-over read this). */
  async isFormEnabled(roleKind: string): Promise<boolean> {
    return (await this.rowFor(roleKind))?.formEnabled ?? false;
  }

  /** Every trade kind, with its flags (a kind with no row reads as off). */
  async getAll(): Promise<{ releases: TradeReleaseView[] }> {
    try {
      const rows = await this.allRows();
      const byKind = new Map(rows.map((r) => [r.roleKind, r]));
      return {
        releases: TRADE_FORM_KINDS_ALL.map((kind) => view(byKind.get(kind) ?? null, kind)),
      };
    } catch (err) {
      throw this.missingTableAs503(err);
    }
  }

  /**
   * Set one trade's flags. A set that changes nothing writes nothing and emits nothing.
   * The row write and the `trade_release.changed` event commit together.
   *
   * @throws ServiceUnavailableException — the table is missing (the migration is not applied).
   */
  async set(
    adminId: string,
    input: { roleKind: string; postingEnabled: boolean; formEnabled: boolean },
    ctx: RequestContext,
  ): Promise<SetTradeReleaseResult> {
    try {
      const out = await this.repo.withTransaction(async (tx) => {
        const live = await this.repo.find(tx, input.roleKind);
        if (
          live !== null &&
          live.postingEnabled === input.postingEnabled &&
          live.formEnabled === input.formEnabled
        ) {
          return { row: live, changed: false };
        }
        const row = await this.repo.upsert(tx, {
          roleKind: input.roleKind,
          postingEnabled: input.postingEnabled,
          formEnabled: input.formEnabled,
          updatedBy: adminId,
        });
        const payload: PayloadInputOf<"trade_release.changed"> = {
          role_kind: input.roleKind,
          posting_enabled: input.postingEnabled,
          form_enabled: input.formEnabled,
          updated_by_admin_id: adminId,
        };
        await this.events.emit({
          event_name: "trade_release.changed",
          actor: { actor_type: "admin", actor_id: adminId },
          subject: { subject_type: "admin_session", subject_id: adminId },
          payload,
          idempotencyKey: `trade_release.changed:${input.roleKind}:${adminId}:${ctx.requestId}`,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          tx,
        });
        return { row, changed: true };
      });
      this.cachedAt = null;
      this.cachedRows = null;
      return { release: view(out.row, input.roleKind), changed: out.changed };
    } catch (err) {
      throw this.missingTableAs503(err);
    }
  }

  private async rowFor(roleKind: string): Promise<TradeReleaseRow | null> {
    try {
      return (await this.allRows()).find((r) => r.roleKind === roleKind) ?? null;
    } catch {
      this.logger.error(`trade_release read failed kind=${roleKind}`);
      return null;
    }
  }

  private async allRows(): Promise<TradeReleaseRow[]> {
    const now = Date.now();
    if (this.cachedRows !== null && this.cachedAt !== null && now - this.cachedAt < CACHE_TTL_MS) {
      return [...this.cachedRows.values()];
    }
    const rows = await this.repo.all();
    this.cachedRows = new Map(rows.map((r) => [r.roleKind, r]));
    this.cachedAt = now;
    return rows;
  }

  private missingTableAs503(err: unknown): unknown {
    if (sqlStateOf(err) === UNDEFINED_TABLE) {
      this.logger.error(
        `trade_release missing (sqlstate=${UNDEFINED_TABLE}); apply the trade_release migration`,
      );
      return new ServiceUnavailableException();
    }
    return err;
  }
}

function view(row: TradeReleaseRow | null, roleKind: string): TradeReleaseView {
  return {
    role_kind: roleKind,
    posting_enabled: row?.postingEnabled ?? false,
    form_enabled: row?.formEnabled ?? false,
    updated_by: row?.updatedBy ?? null,
    updated_at: row?.updatedAt.toISOString() ?? null,
  };
}
