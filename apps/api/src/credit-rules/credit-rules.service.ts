import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import {
  changedCreditRuleKeys,
  CreditRulesSchema,
  DEFAULT_CREDIT_RULES,
  parseCreditRules,
  type CreditRules,
  type CreditRuleKey,
} from "@badabhai/pricing";
import { isUniqueViolation, sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import { ADMIN_ACTION_CODES } from "../admin/admin-action-codes";
import { CreditRulesRepository } from "./credit-rules.repository";

/** The active rules and where they came from (the `ActiveMatchConfig` shape). */
export interface ActiveCreditRules {
  readonly rules: CreditRules;
  /** 0 before the first edit. */
  readonly revision: number;
  /** "db" = a valid stored row; "default" = no row, an invalid row, or the table is missing. */
  readonly source: "db" | "default";
  /** When the active revision was written, or null with no row. */
  readonly updatedAt: Date | null;
}

/** What `PUT /admin/credit-rules` changed. */
export interface CreditRulesUpdateResult extends ActiveCreditRules {
  readonly changed: boolean;
  readonly changedKeys: readonly CreditRuleKey[];
}

/** Postgres "undefined_table": the switch is on and the migration is not applied yet. */
const UNDEFINED_TABLE = "42P01";

/**
 * How long a loaded revision is reused. The same 30 seconds as `MatchConfigService`: an edit shows
 * within a page refresh on every process, and the instance that served the edit drops its cache at
 * once (#2750 private notes item 10).
 */
const CACHE_TTL_MS = 30_000;

/**
 * #2750 item 1 — THE one place `apps/api` learns a credit-rule number. Every later part (the cost
 * of a contact, welcome credits, limits, the couldn't-reach windows, returned credits, refunds,
 * goodwill) reads its numbers from {@link get}; none may hard-code one.
 *
 * Shaped like {@link ../match/match-config.service.ts MatchConfigService}: load the active row,
 * validate it, FAIL CLOSED WHOLE to the brief's defaults, and say so (`source: "default"`) rather
 * than hide it. A database that cannot be read degrades to the defaults with one error log, never
 * a 500 on a company's request; the defaults ARE the brief's rules.
 *
 * THE SWITCH. Nothing here reads the table unless the `credit_rules` switch is pilot or on, so a
 * deploy ahead of the migration touches nothing. The admin routes answer 404 while it is off
 * everywhere ({@link assertLive}); company paths ask the switch per company before they call
 * {@link get}.
 *
 * PII-free: integers, ids and times.
 */
@Injectable()
export class CreditRulesService {
  private readonly logger = new Logger(CreditRulesService.name);
  private cached: { value: ActiveCreditRules; loadedAtMs: number } | null = null;
  private inFlight: Promise<ActiveCreditRules> | null = null;

  constructor(
    private readonly repo: CreditRulesRepository,
    private readonly events: EventsService,
    private readonly rollout: FeatureRolloutService,
  ) {}

  /** 404 unless the `credit_rules` switch is pilot or on: the admin routes do not exist while off. */
  assertLive(): void {
    if (!this.rollout.isLiveForServiceCaller("credit_rules")) throw new NotFoundException();
  }

  /** Just the rules — the call every consumer makes. Never throws. */
  async get(): Promise<CreditRules> {
    try {
      return (await this.getActive()).rules;
    } catch (err) {
      this.logger.error(
        `credit_rules_config load failed (sqlstate=${sqlStateOf(err) ?? "none"}); serving the brief's defaults`,
      );
      return DEFAULT_CREDIT_RULES;
    }
  }

  /** The active rules with their provenance, cached for {@link CACHE_TTL_MS}. */
  async getActive(): Promise<ActiveCreditRules> {
    const cached = this.cached;
    if (cached !== null && Date.now() - cached.loadedAtMs < CACHE_TTL_MS) return cached.value;
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.load()
      .then((value) => {
        this.cached = { value, loadedAtMs: Date.now() };
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Drop the cache. Called after an edit, and by tests. */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * `GET /admin/credit-rules` — the active rules, read fresh (an admin about to edit must see the
   * revision the edit will be checked against, not a cached one). 503 while the table is missing.
   */
  async readForAdmin(): Promise<ActiveCreditRules> {
    try {
      return await this.load({ missingTable: "throw" });
    } catch (err) {
      throw this.mapReadError(err);
    }
  }

  /**
   * `PUT /admin/credit-rules` — write the next revision, with its `audit_logs` row (the admin, the
   * written reason, the old and new values) and its value-free `admin.action_performed` event, in
   * ONE transaction. Optimistic: `expectedRevision` must be the newest stored revision, else 409
   * and nothing is written. An edit that changes no value writes nothing and answers
   * `changed: false`.
   */
  async update(
    adminId: string,
    input: { rules: CreditRules; expectedRevision: number; reasonText: string },
    ctx: RequestContext,
  ): Promise<CreditRulesUpdateResult> {
    const current = await this.readForAdmin();
    // The edit body is validated by the DTO; re-run the stored-row schema so a value the reader
    // would refuse can never be written (the two schemas share their keys and bounds).
    const next = CreditRulesSchema.safeParse(input.rules);
    if (!next.success) throw new BadRequestException("credit rules failed validation");
    const changedKeys = changedCreditRuleKeys(current.rules, next.data);
    if (current.revision !== input.expectedRevision) throw this.stale();
    if (changedKeys.length === 0) return { ...current, changed: false, changedKeys };

    const action = ADMIN_ACTION_CODES.credit_rules_changed;
    let result: Awaited<ReturnType<CreditRulesRepository["publish"]>>;
    try {
      result = await this.repo.publish(
        {
          rules: next.data,
          expectedRevision: input.expectedRevision,
          adminId,
          audit: {
            action,
            metadata: {
              revision: input.expectedRevision + 1,
              changed_keys: changedKeys,
              before: Object.fromEntries(changedKeys.map((k) => [k, current.rules[k]])),
              after: Object.fromEntries(changedKeys.map((k) => [k, next.data[k]])),
              reason_text: input.reasonText,
            },
          },
        },
        async (tx, row) => {
          const payload: PayloadInputOf<"admin.action_performed"> = {
            admin_id: adminId,
            action_code: action,
            target_type: "credit_rules_config",
            target_id: row.id,
          };
          await this.events.emit({
            event_name: "admin.action_performed",
            actor: { actor_type: "admin", actor_id: adminId },
            subject: { subject_type: "credit_rules_config", subject_id: row.id },
            payload,
            correlationId: ctx.correlationId,
            requestId: ctx.requestId,
            idempotencyKey: `admin_action:${action}:${row.id}`,
            tx,
          });
        },
      );
    } catch (err) {
      // Two admins saved the same revision at once: the revision index refused the second.
      if (isUniqueViolation(err)) throw this.stale();
      throw this.mapReadError(err);
    }
    if (result.outcome === "stale") throw this.stale();

    this.invalidate();
    this.logger.log(
      `credit rules revision=${result.row.revision} written by admin=${adminId} keys=${changedKeys.join(",")}`,
    );
    return {
      rules: next.data,
      revision: result.row.revision,
      source: "db",
      updatedAt: result.row.createdAt,
      changed: true,
      changedKeys,
    };
  }

  private stale(): ConflictException {
    return new ConflictException(
      "The credit rules were changed since you loaded them; reload and try again",
    );
  }

  /** A missing table is a 503 (the switch is ahead of the migration); anything else rethrows. */
  private mapReadError(err: unknown): unknown {
    if (sqlStateOf(err) === UNDEFINED_TABLE) {
      this.logger.error(
        "credit_rules_config is missing (42P01): the credit_rules switch is on before its migration",
      );
      return new ServiceUnavailableException("The credit rules are not available yet");
    }
    return err;
  }

  /**
   * Read and validate the active row. With `missingTable: "default"` (every consumer) a missing
   * table reads as "no row"; the admin read asks for the error instead.
   */
  private async load(
    opts: { missingTable: "default" | "throw" } = { missingTable: "default" },
  ): Promise<ActiveCreditRules> {
    let row: Awaited<ReturnType<CreditRulesRepository["getActive"]>>;
    try {
      row = await this.repo.getActive();
    } catch (err) {
      if (opts.missingTable === "default" && sqlStateOf(err) === UNDEFINED_TABLE) {
        this.logger.error(
          "credit_rules_config is missing (42P01); serving the brief's defaults until the migration is applied",
        );
        return { rules: DEFAULT_CREDIT_RULES, revision: 0, source: "default", updatedAt: null };
      }
      throw err;
    }
    if (!row)
      return { rules: DEFAULT_CREDIT_RULES, revision: 0, source: "default", updatedAt: null };
    if (!CreditRulesSchema.safeParse(row.rules).success) {
      this.logger.error(
        `active credit_rules_config revision=${row.revision} FAILED validation; serving the brief's defaults (fail-closed)`,
      );
      return {
        rules: DEFAULT_CREDIT_RULES,
        revision: row.revision,
        source: "default",
        updatedAt: row.createdAt,
      };
    }
    return {
      rules: parseCreditRules(row.rules),
      revision: row.revision,
      source: "db",
      updatedAt: row.createdAt,
    };
  }
}
