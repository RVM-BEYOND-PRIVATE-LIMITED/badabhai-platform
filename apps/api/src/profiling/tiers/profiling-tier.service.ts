import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";

import type { QuestionPack } from "@badabhai/ai-contracts";
import type { ServerConfig } from "@badabhai/config";
import type { WorkerProfilingTier } from "@badabhai/db";
import { PROFILING_TIERS, profilingTierRank, type ProfilingTier } from "@badabhai/types";

import type { RequestContext } from "../../common/request-context";
import { SERVER_CONFIG } from "../../config/config.module";
import { EventsService } from "../../events/events.service";
import { descriptorForKind } from "../roles/role-registry";
import type { TradeFormKind } from "../trade-form-router";
import { defaultEstimates, seniorPathQuestionCount } from "./profiling-tier-estimates";
import {
  effectiveTier,
  isUpgrade,
  keysExcludedAtTier,
  packIsTagged,
  type ItemTierMap,
} from "./profiling-tier.policy";
import { ProfilingTierRepository } from "./profiling-tier.repository";
import type { ChooseTierResponse, TierStateResponse } from "./profiling-tier.dto";

/** The form a worker was handed, as `TradeFormService` resolves it. */
export interface TierFormContext {
  readonly kind: TradeFormKind;
  /** The interview that handed the form over; null when it came from a résumé import. */
  readonly sessionId: string | null;
  readonly pack: QuestionPack;
}

/** What the form needs to ask a worker only his tier's questions. */
export interface FormTierScope {
  readonly tier: ProfilingTier;
  /** The stored row, when there is one — `upgradedFrom` drives the upgrade view. */
  readonly row: WorkerProfilingTier | null;
  /** Pack question keys this tier does NOT ask (own tag, or a parent that is out). */
  readonly excluded: ReadonlySet<string>;
}

/**
 * TIERED PROFILING — choosing, upgrading, and scoping a worker's tier. Business rules only: what
 * a tag MEANS is `profiling-tier.policy.ts`, and the rows are `ProfilingTierRepository`'s.
 *
 * OFF MEANS ABSENT. With `PROFILING_TIERS_ENABLED` off every method answers as if tiers did not
 * exist — `formScope` is null (the form serves Hard), the state says `enabled: false`, a choice is
 * a 404 — and NO query touches migration 0126's table or column. That is what makes 0126
 * apply-before-flag-on rather than apply-before-deploy.
 *
 * WHO GETS THE TIER SCREEN (`needs_choice`): a worker on the Chat path (the form came from an
 * interview handover) who has no tier row and has not started this form. A résumé-import worker
 * keeps today's flow (owner decision D5: "upload unchanged"), and so does anybody who was already
 * part-way through the form before tiers existed — both profile at Hard.
 */
@Injectable()
export class ProfilingTierService {
  private readonly logger = new Logger(ProfilingTierService.name);
  /** Packs already warned about as untagged, so the warning is once per process, not per request. */
  private readonly warnedUntagged = new Set<string>();

  constructor(
    private readonly repo: ProfilingTierRepository,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG)
    private readonly config: Pick<ServerConfig, "PROFILING_TIERS_ENABLED">,
  ) {}

  get enabled(): boolean {
    return this.config.PROFILING_TIERS_ENABLED === true;
  }

  /**
   * The tier this worker's form is scoped to, with the question keys it excludes. Null when tiers
   * are off — the caller then serves every question, which is Hard and today's form.
   */
  async formScope(workerId: string, pack: QuestionPack): Promise<FormTierScope | null> {
    if (!this.enabled) return null;
    const [row, itemTiers] = await Promise.all([
      this.repo.findForWorker(workerId),
      this.repo.findItemTiers(pack.pack_id, pack.version),
    ]);
    if (!this.tagged(pack, itemTiers)) return null;
    const tier = effectiveTier(row?.tier);
    return { tier, row, excluded: keysExcludedAtTier(pack.items, itemTiers, tier) };
  }

  /**
   * `GET /profiling/form/tiers` — whether the worker must choose, his current tier, and every
   * tier's time estimate for his role.
   *
   * EMITS `profile.tier_screen_shown` when there is a screen to show: a first choice, or an
   * "add more detail" for a worker below Hard. Keyed on (worker, session, context, tier), so the
   * client re-fetching the same screen counts once.
   */
  async state(
    workerId: string,
    ctx: TierFormContext,
    hasStartedForm: boolean,
    requestCtx?: RequestContext,
  ): Promise<TierStateResponse> {
    const off: TierStateResponse = {
      enabled: false,
      kind: ctx.kind,
      needs_choice: false,
      current_tier: null,
      upgradable_to: [],
      tiers: [],
    };
    if (!this.enabled) return off;
    const [row, itemTiers] = await Promise.all([
      this.repo.findForWorker(workerId),
      this.repo.findItemTiers(ctx.pack.pack_id, ctx.pack.version),
    ]);
    // An unseeded pack: tiers are off FOR THIS FORM, so the client goes straight to it.
    if (!this.tagged(ctx.pack, itemTiers)) return off;
    const needsChoice = row === null && ctx.sessionId !== null && !hasStartedForm;
    const current: ProfilingTier | null = needsChoice ? null : effectiveTier(row?.tier);
    const upgradableTo =
      current === null ? [] : PROFILING_TIERS.filter((t) => isUpgrade(current, t));

    if (needsChoice || upgradableTo.length > 0) {
      await this.emitQuietly(
        {
          event_name: "profile.tier_screen_shown",
          actor: { actor_type: "worker", actor_id: workerId },
          subject: { subject_type: "worker", subject_id: workerId },
          payload: {
            worker_id: workerId,
            form_kind: ctx.kind,
            context: needsChoice ? "select" : "upgrade",
            current_tier: current,
          },
          idempotencyKey:
            `profile.tier_screen_shown:${workerId}:${ctx.sessionId ?? "import"}:` +
            `${needsChoice ? "select" : "upgrade"}:${current ?? "none"}`,
          correlationId: requestCtx?.correlationId,
          requestId: requestCtx?.requestId,
        },
        "tier screen",
      );
    }

    return {
      enabled: true,
      kind: ctx.kind,
      needs_choice: needsChoice,
      current_tier: current,
      upgradable_to: [...upgradableTo],
      tiers: this.estimatesFor(ctx, itemTiers),
    };
  }

  /**
   * `POST /profiling/form/tier` — a first choice or an upgrade. NEVER a downgrade: a lower tier
   * than the one held is a 409, and answers already given are kept whatever happens.
   *
   * THE SAME TIER AGAIN IS A 200 with `change: "unchanged"` and no event — a retried tap on a
   * flaky link must not count twice or fail.
   */
  async choose(
    workerId: string,
    ctx: TierFormContext,
    tier: ProfilingTier,
    hasStartedForm: boolean,
    requestCtx?: RequestContext,
    now: Date = new Date(),
  ): Promise<ChooseTierResponse> {
    if (!this.enabled) throw new NotFoundException("tiered profiling is not enabled");
    const itemTiers = await this.repo.findItemTiers(ctx.pack.pack_id, ctx.pack.version);
    if (!this.tagged(ctx.pack, itemTiers)) {
      throw new NotFoundException("tiered profiling is not available for this form yet");
    }

    const row = await this.repo.findForWorker(workerId);
    const needsChoice = row === null && ctx.sessionId !== null && !hasStartedForm;
    if (row === null && needsChoice) {
      const { row: stored, inserted } = await this.repo.insertSelected({
        workerId,
        tier,
        formKind: ctx.kind,
        chatSessionId: ctx.sessionId,
        at: now,
      });
      if (inserted) {
        await this.emitQuietly(
          {
            event_name: "profile.tier_selected",
            actor: { actor_type: "worker", actor_id: workerId },
            subject: { subject_type: "worker", subject_id: workerId },
            payload: { worker_id: workerId, form_kind: ctx.kind, pack_id: ctx.pack.pack_id, tier },
            idempotencyKey: `profile.tier_selected:${workerId}`,
            correlationId: requestCtx?.correlationId,
            requestId: requestCtx?.requestId,
          },
          "tier selection",
        );
        return { tier, previous_tier: null, change: "selected" };
      }
      // A concurrent request chose first. Fall through and treat this one as a change to THAT.
      return this.changeFrom(workerId, ctx, stored, tier, requestCtx, now);
    }
    // No row and not a first choice: the worker profiles at Hard (résumé import, or a form begun
    // before tiers existed). Nothing is deeper than Hard, so the only acceptable choice is Hard.
    const current = row ?? null;
    if (current === null) {
      if (tier === "hard") return { tier, previous_tier: "hard", change: "unchanged" };
      throw new ConflictException(`profiling tier is hard and cannot be lowered to ${tier}`);
    }
    return this.changeFrom(workerId, ctx, current, tier, requestCtx, now);
  }

  /**
   * The form was finished at a tier — `profile.tier_completed`, once per (worker, pack, tier).
   * The duration runs from when the CURRENT tier was chosen; null when that is unknown.
   * Never throws: the answer that finished the form is already durable.
   */
  async recordCompletion(
    workerId: string,
    ctx: TierFormContext,
    scope: FormTierScope,
    questionCount: number,
    requestCtx?: RequestContext,
    now: Date = new Date(),
  ): Promise<void> {
    const selectedAt = scope.row?.selectedAt ?? null;
    await this.emitQuietly(
      {
        event_name: "profile.tier_completed",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: {
          worker_id: workerId,
          form_kind: ctx.kind,
          pack_id: ctx.pack.pack_id,
          pack_version: ctx.pack.version,
          tier: scope.tier,
          duration_ms: selectedAt ? Math.max(0, now.getTime() - selectedAt.getTime()) : null,
          question_count: questionCount,
        },
        idempotencyKey: `profile.tier_completed:${workerId}:${ctx.pack.pack_id}:${scope.tier}`,
        correlationId: requestCtx?.correlationId,
        requestId: requestCtx?.requestId,
      },
      "tier completion",
    );
  }

  /**
   * Every tier's estimate for this role.
   *
   * TODO(tier-estimates): once `profile.tier_completed` has enough durations per (form_kind,
   * tier), read their median here and let it win over both the per-role override and the
   * computed default. Until then the computed default is all there is (`tier-tagging.md` §5).
   */
  private estimatesFor(ctx: TierFormContext, itemTiers: ItemTierMap): TierStateResponse["tiers"] {
    const tenureKey = descriptorForKind(ctx.kind)?.tenureQuestionKey;
    const counts = Object.fromEntries(
      PROFILING_TIERS.map((t) => [
        t,
        seniorPathQuestionCount(ctx.pack.items, itemTiers, t, tenureKey),
      ]),
    ) as Record<ProfilingTier, number>;
    const estimates = defaultEstimates(ctx.kind, counts);
    return PROFILING_TIERS.map((tier) => ({ tier, ...estimates[tier] }));
  }

  private async changeFrom(
    workerId: string,
    ctx: TierFormContext,
    current: WorkerProfilingTier,
    tier: ProfilingTier,
    requestCtx: RequestContext | undefined,
    now: Date,
  ): Promise<ChooseTierResponse> {
    if (current.tier === tier) return { tier, previous_tier: current.tier, change: "unchanged" };
    if (profilingTierRank(tier) < profilingTierRank(current.tier)) {
      throw new ConflictException(
        `profiling tier is ${current.tier} and cannot be lowered to ${tier}`,
      );
    }
    const updated = await this.repo.upgrade({
      workerId,
      from: current.tier,
      to: tier,
      formKind: ctx.kind,
      chatSessionId: ctx.sessionId,
      at: now,
    });
    if (updated === null) {
      // The guard missed: another request changed the tier in between. Re-read and answer against
      // what is stored now, so a stale request can never lower what a newer one raised.
      const fresh = await this.repo.findForWorker(workerId);
      if (fresh && fresh.tier === tier)
        return { tier, previous_tier: current.tier, change: "unchanged" };
      throw new ConflictException("profiling tier changed concurrently; fetch it and retry");
    }
    await this.emitQuietly(
      {
        event_name: "profile.tier_upgraded",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: {
          worker_id: workerId,
          form_kind: ctx.kind,
          pack_id: ctx.pack.pack_id,
          from_tier: current.tier,
          to_tier: tier,
        },
        idempotencyKey: `profile.tier_upgraded:${workerId}:${current.tier}:${tier}`,
        correlationId: requestCtx?.correlationId,
        requestId: requestCtx?.requestId,
      },
      "tier upgrade",
    );
    return { tier, previous_tier: current.tier, change: "upgraded" };
  }

  /** `packIsTagged`, warning once per pack version when it is not (the seed has not run). */
  private tagged(pack: QuestionPack, itemTiers: ItemTierMap): boolean {
    if (packIsTagged(itemTiers)) return true;
    const key = `${pack.pack_id}@${pack.version}`;
    if (!this.warnedUntagged.has(key)) {
      this.warnedUntagged.add(key);
      this.logger.warn(
        `${key} carries no min_tier tags in the database — tiers are OFF for this form until ` +
          `\`pnpm --filter @badabhai/db db:seed:packs --apply\` writes them`,
      );
    }
    return false;
  }

  /**
   * Telemetry never fails the worker's action — the `recordFormHandoff` / `recordCompletion`
   * posture. The row is already durable when this runs; the log line is the fallback record.
   */
  private async emitQuietly(
    params: Parameters<EventsService["emit"]>[0],
    what: string,
  ): Promise<void> {
    try {
      await this.events.emit(params);
    } catch (error) {
      this.logger.error(`the ${what} event was not recorded: ${(error as Error).message}`);
    }
  }
}
