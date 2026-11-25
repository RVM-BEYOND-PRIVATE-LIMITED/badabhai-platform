import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { TradeReleaseRow } from "@badabhai/db";
import { LIVE_POSTING_TRADE_KINDS, isLivePostingTradeKind } from "@badabhai/taxonomy";
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

/** A read found no `trade_release` table: migration 0198 is not applied yet. */
const MISSING_TABLE = Symbol("trade_release missing");

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
 *
 * #3005 — A MISSING TABLE READS AS THE MIGRATION'S SEED. Code deploys on merge and migrations
 * are applied by hand (#3003), so the posting readers ship while `trade_release` may not exist.
 * Answering "off" then would switch off the 16 live trades a company posts today — a live change
 * before any owner step (tracking #3024 rule 1). So while the table is missing (SQLSTATE 42P01,
 * and only then) the readers answer what 0198 seeds: the 16 live kinds may be posted, nothing
 * else, and no form switch is on. Behaviour is then the same before and after the migration; a
 * new trade still cannot be switched on until the table exists. Any OTHER read error is still
 * off. The missing-table answer is cached like rows, so it logs once per cache window.
 */
@Injectable()
export class TradeReleaseService {
  private readonly logger = new Logger(TradeReleaseService.name);
  private cachedAt: number | null = null;
  private cachedRows: Map<string, TradeReleaseRow> | null = null;
  private cachedMissing = false;

  constructor(
    private readonly repo: TradeReleaseRepository,
    private readonly events: EventsService,
  ) {}

  /**
   * May companies post this trade (#3005, #3006 read this). No row, or a read error: off. No
   * table yet: the seed's answer (one of the 16 live kinds).
   */
  async isPostingEnabled(roleKind: string): Promise<boolean> {
    const row = await this.rowFor(roleKind);
    if (row === MISSING_TABLE) return isLivePostingTradeKind(roleKind);
    return row?.postingEnabled ?? false;
  }

  /**
   * Every kind companies may post now, from ONE read (a catalogue of 60 trades asks once, not
   * 60 times). Same answers as {@link isPostingEnabled}.
   */
  async postingEnabledKinds(): Promise<ReadonlySet<string>> {
    const rows = await this.readRows();
    if (rows === MISSING_TABLE) return new Set(LIVE_POSTING_TRADE_KINDS);
    if (rows === null) return new Set();
    return new Set(rows.filter((r) => r.postingEnabled).map((r) => r.roleKind));
  }

  /** Is this trade's form live in the hand-over (#3014 and the form hand-over read this). */
  async isFormEnabled(roleKind: string): Promise<boolean> {
    const row = await this.rowFor(roleKind);
    // The 0198 seed switches no form on.
    if (row === MISSING_TABLE) return false;
    return row?.formEnabled ?? false;
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
      this.cachedMissing = false;
      return { release: view(out.row, input.roleKind), changed: out.changed };
    } catch (err) {
      throw this.missingTableAs503(err);
    }
  }

  private async rowFor(roleKind: string): Promise<TradeReleaseRow | null | typeof MISSING_TABLE> {
    const rows = await this.readRows(roleKind);
    if (rows === MISSING_TABLE || rows === null) return rows;
    return rows.find((r) => r.roleKind === roleKind) ?? null;
  }

  /**
   * The readers' view of the table: its rows, MISSING_TABLE (no table, cached like rows), or null
   * for any other read error (fail closed, not cached). Logs the kind only.
   */
  private async readRows(
    roleKind?: string,
  ): Promise<TradeReleaseRow[] | null | typeof MISSING_TABLE> {
    const fresh = this.cachedAt !== null && Date.now() - this.cachedAt < CACHE_TTL_MS;
    if (fresh && this.cachedMissing) return MISSING_TABLE;
    try {
      return await this.allRows();
    } catch (err) {
      if (sqlStateOf(err) === UNDEFINED_TABLE) {
        this.logger.warn(
          `trade_release missing (sqlstate=${UNDEFINED_TABLE}); posting readers use the 0198 seed until it is applied`,
        );
        this.cachedRows = null;
        this.cachedMissing = true;
        this.cachedAt = Date.now();
        return MISSING_TABLE;
      }
      this.logger.error(`trade_release read failed kind=${roleKind ?? "*"}`);
      return null;
    }
  }

  private async allRows(): Promise<TradeReleaseRow[]> {
    const now = Date.now();
    if (
      this.cachedRows !== null &&
      this.cachedAt !== null &&
      !this.cachedMissing &&
      now - this.cachedAt < CACHE_TTL_MS
    ) {
      return [...this.cachedRows.values()];
    }
    const rows = await this.repo.all();
    this.cachedRows = new Map(rows.map((r) => [r.roleKind, r]));
    this.cachedMissing = false;
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
