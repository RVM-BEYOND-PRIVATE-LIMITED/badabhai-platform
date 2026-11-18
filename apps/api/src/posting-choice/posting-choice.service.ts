import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { areRealPaymentsEnabled, type ServerConfig } from "@badabhai/config";
import { formatInr } from "@badabhai/pricing";
import type { PaymentOrderOrigin, PostingChoice, PostingSurface } from "@badabhai/types";
import { sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { CreditRulesService } from "../credit-rules/credit-rules.service";
import { EventsService } from "../events/events.service";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import type { PayerTenantScope, TenantKey } from "../payers/payer-tenant-scope";
import { creditPackSale, findCreditPackTier } from "../pricing/credit-pack-sale";
import { PricingService } from "../pricing/pricing.service";
import { PostingChoiceRepository } from "./posting-choice.repository";

/**
 * The pack the paid button offers (owner ruling 2026-11-18, #2751): the brief's Starter, and only
 * it. Until the go-live catalogue puts `pack_starter` on sale (docs/runbooks/
 * 2749-publish-brief-credit-packs.md), the paid button is not offered; no other pack stands in.
 */
export const POSTING_CHOICE_PACK_CODE = "pack_starter";

/** The name the paid button gives {@link POSTING_CHOICE_PACK_CODE} (brief 4B.7). */
const POSTING_CHOICE_PACK_NAME = "Starter";

/**
 * Where a checkout started from the paid button says it started (#2751 item 3). An existing
 * `PAYMENT_ORDER_ORIGINS` value: the `payment_orders_origin_chk` CHECK (migration 0176) admits it,
 * so no change to that table is needed. The job itself rides as `origin_job_posting_id`.
 */
export const POSTING_CHOICE_CHECKOUT_ORIGIN: PaymentOrderOrigin = "posting_flow";

/** The paid pack as the button offers it: list price before GST, the GST-inclusive total. */
export interface PostingChoicePackDto {
  code: string;
  /** Whole rupees before GST: what the label shows and `expected_price_inr` confirms. */
  price_inr: number;
  /** Paise, GST included: what the checkout charges. */
  total_paise: number;
  credits: number;
}

/** `GET /payer/job-postings/posting-options` (#2751 item 1). Every text decided here. */
export interface PostingOptionsDto {
  free: {
    choice: "free";
    offered: true;
    /** "Post free (5 contacts)" before the company's welcome grant, else "Post free". */
    label: string;
    /** The welcome credits the label counts, or null when it counts none. */
    welcome_credits: number | null;
  };
  free_plus_pack: {
    choice: "free_plus_pack";
    /** False while the Starter pack is not on sale or real payments are not live. */
    offered: boolean;
    /** "Post free + Starter ₹999 (20 contacts)" when offered, else null. */
    label: string | null;
    pack: PostingChoicePackDto | null;
    /** The `origin` a checkout from this button sends (with the job as `origin_job_posting_id`). */
    checkout_origin: PaymentOrderOrigin;
  };
}

/**
 * The body a client sends to `POST /payer/credits/order` after a paid publish (#2751 item 3): the
 * pack, the confirmed list price, and the job as the purchase origin.
 */
export interface PostingChoiceCheckoutDto {
  pack_code: string;
  expected_price_inr: number;
  origin: PaymentOrderOrigin;
  origin_job_posting_id: string;
}

/** The additive `posting_choice` block on the publish answer, present only when it applied. */
export interface PostingChoiceOutcomeDto {
  choice: PostingChoice;
  surface: PostingSurface;
  /** True when THIS publish stored the choice; false when it could not (logged) or one existed. */
  recorded: boolean;
  /** For `free_plus_pack` while the paid button is offered, else null. */
  checkout: PostingChoiceCheckoutDto | null;
}

/** What the publish passes in: the posting just published and the tap. */
export interface PostingChoiceRecordInput {
  readonly scope: PayerTenantScope;
  readonly jobPostingId: string;
  readonly choice: PostingChoice;
  readonly surface: PostingSurface;
}

/**
 * #2751 items 1 to 3 (brief 4B.7) — THE POSTING CHOICE. A company publishes a job with one of two
 * buttons, "Post free" or "Post free + Starter"; the job goes live either way. This service decides
 * what each button offers this company, records which one it tapped, once per posting, and hands
 * the paid tap the checkout body that carries the job as its origin.
 *
 * BEHIND THE `posting_choice` SWITCH, per company (`POSTING_CHOICE_ROLLOUT`). Off, the options route
 * answers the house neutral 404 and {@link recordAfterPublish} returns null without reading or
 * writing anything, so `job_posting_choices` is never named before migration 0187 is applied.
 *
 * NEVER FAILS THE PUBLISH. {@link recordAfterPublish} runs after the publish committed and catches
 * every error (logged with ids and the SQLSTATE only): a missing table, a dropped connection or a
 * catalogue read failure leaves the job live and answers `recorded: false`.
 *
 * THE SERVER DECIDES EVERY TEXT (no app release to change one). The free button counts the welcome
 * credits (#2750 item 4) only while the `credit_rules` switch is on for the company and it has never
 * been given them (owner ruling 2026-11-18: "count until granted"). The paid button names
 * `pack_starter` only, priced from the live catalogue, and is offered only while that pack is on
 * sale AND real payments are live: with them off, the purchase routes are a mock that takes no
 * money, and a paid button must never lead there.
 */
@Injectable()
export class PostingChoiceService {
  private readonly logger = new Logger(PostingChoiceService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly repo: PostingChoiceRepository,
    private readonly rollout: FeatureRolloutService,
    private readonly rules: CreditRulesService,
    private readonly pricing: PricingService,
    private readonly events: EventsService,
  ) {}

  /** Is the posting choice on for this company? A pilot-list read failure answers no. */
  isOnFor(tenant: TenantKey): Promise<boolean> {
    return this.rollout.isEnabledFor("posting_choice", tenant);
  }

  /** `GET /payer/job-postings/posting-options`, or the neutral 404 while the switch is off. */
  async optionsFor(scope: PayerTenantScope): Promise<PostingOptionsDto> {
    if (!(await this.isOnFor(scope.tenantKey))) throw new NotFoundException();
    const [welcome, pack] = await Promise.all([
      this.welcomeCount(scope.tenantKey),
      this.paidPack(scope.tenantKey),
    ]);
    return {
      free: {
        choice: "free",
        offered: true,
        label: welcome === null ? "Post free" : `Post free (${welcome} contacts)`,
        welcome_credits: welcome,
      },
      free_plus_pack: {
        choice: "free_plus_pack",
        offered: pack !== null,
        label:
          pack === null
            ? null
            : `Post free + ${POSTING_CHOICE_PACK_NAME} ${formatInr(pack.price_inr)} (${pack.credits} contacts)`,
        pack,
        checkout_origin: POSTING_CHOICE_CHECKOUT_ORIGIN,
      },
    };
  }

  /**
   * After a publish committed: record the tap once and, for a paid tap while the paid button is
   * offered, return the checkout body. Null while the switch is off for the company (the publish
   * answer then carries no `posting_choice` block, exactly as before this existed). Never throws.
   */
  async recordAfterPublish(
    input: PostingChoiceRecordInput,
    ctx: RequestContext,
  ): Promise<PostingChoiceOutcomeDto | null> {
    const tenant = input.scope.tenantKey;
    try {
      if (!(await this.isOnFor(tenant))) return null;
    } catch (err) {
      // `isEnabledFor` already answers a pilot-list failure as off; this is belt and braces.
      this.logFailure("switch read", input.jobPostingId, tenant, err);
      return null;
    }

    let recorded = false;
    try {
      recorded = await this.repo.recordOnce(
        {
          jobPostingId: input.jobPostingId,
          tenant,
          choice: input.choice,
          surface: input.surface,
        },
        (tx) =>
          this.events
            .emit({
              event_name: "job_posting.posting_choice_recorded",
              actor: { actor_type: "payer", actor_id: input.scope.actorPayerId },
              subject: { subject_type: "job_posting", subject_id: input.jobPostingId },
              payload: {
                job_posting_id: input.jobPostingId,
                choice: input.choice,
                surface: input.surface,
              },
              correlationId: ctx.correlationId,
              requestId: ctx.requestId,
              idempotencyKey: `job_posting.posting_choice_recorded:${input.jobPostingId}`,
              tx,
            })
            .then(() => undefined),
      );
    } catch (err) {
      this.logFailure("record", input.jobPostingId, tenant, err);
    }

    let checkout: PostingChoiceCheckoutDto | null = null;
    if (input.choice === "free_plus_pack") {
      const pack = await this.paidPack(tenant);
      if (pack !== null) {
        checkout = {
          pack_code: pack.code,
          expected_price_inr: pack.price_inr,
          origin: POSTING_CHOICE_CHECKOUT_ORIGIN,
          origin_job_posting_id: input.jobPostingId,
        };
      }
    }
    return { choice: input.choice, surface: input.surface, recorded, checkout };
  }

  /**
   * The welcome credits the free button counts, or null: the `credit_rules` switch is on for the
   * company, the rules grant some, and the company has never been given them. Any read failure is
   * null — the label then promises nothing.
   */
  private async welcomeCount(tenant: TenantKey): Promise<number | null> {
    try {
      if (!(await this.rollout.isEnabledFor("credit_rules", tenant))) return null;
      const { welcomeCredits } = await this.rules.get();
      if (welcomeCredits <= 0) return null;
      return (await this.repo.hasWelcomeLot(tenant)) ? null : welcomeCredits;
    } catch (err) {
      this.logFailure("welcome read", null, tenant, err);
      return null;
    }
  }

  /**
   * The Starter pack as the paid button offers it, or null: real payments are not live, the pack is
   * not on sale in the live catalogue (the same `creditPackSale` answer the checkout charges from),
   * or the catalogue could not be read.
   */
  private async paidPack(tenant: TenantKey): Promise<PostingChoicePackDto | null> {
    if (!areRealPaymentsEnabled(this.config)) return null;
    try {
      const active = await this.pricing.getActiveCatalog();
      const tier = findCreditPackTier(active.catalog, POSTING_CHOICE_PACK_CODE);
      if (!tier) return null;
      const sale = creditPackSale(active, tier, new Date());
      if (!sale.sellable) return null;
      return {
        code: POSTING_CHOICE_PACK_CODE,
        price_inr: sale.pack.quote.finalInr,
        total_paise: sale.pack.priceLine.totalPaise,
        credits: sale.pack.credits,
      };
    } catch (err) {
      this.logFailure("catalogue read", null, tenant, err);
      return null;
    }
  }

  private logFailure(
    step: string,
    jobPostingId: string | null,
    tenant: TenantKey,
    err: unknown,
  ): void {
    // Ids and the SQLSTATE only; never the error text.
    this.logger.warn(
      `posting choice: ${step} failed (posting=${jobPostingId ?? "none"} tenant=${tenant} sqlstate=${sqlStateOf(err) ?? "none"}); the publish stands`,
    );
  }
}
