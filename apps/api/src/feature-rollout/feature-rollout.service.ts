import { Inject, Injectable, Logger } from "@nestjs/common";
import type { FeatureRolloutMode, ServerConfig } from "@badabhai/config";
import { sqlStateOf } from "../common/db-error";
import { SERVER_CONFIG } from "../config/config.module";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { FeaturePilotRepository } from "./feature-pilot.repository";
import { FEATURE_ROLLOUT_CONFIG, type FeatureRolloutKey } from "./feature-rollout.keys";

/**
 * THE rollout question (#2746 item 1): is a feature on, and is it on for this company?
 *
 * The only reader of the `*_ROLLOUT` switches (a static test pins that), so every gate answers the
 * same way. A company is identified by its TENANT key (`PayerTenantScopeService.resolve`); never
 * pass a raw id from a body or a path. With `PAYER_ORG_TENANCY_MODE=on` that key is the company's
 * anchor, so a team member inherits its pilot place; in `off` / `shadow` the key is the login
 * itself, so each login that should see the pilot needs its own `feature_pilot_payers` row.
 *
 * A SWITCH GATES CAPABILITIES, NEVER STORED RESTRICTIONS. It decides whether new input is accepted,
 * a route is mounted or a row may be created. It never decides whether stored state is honoured:
 * the worker-path audience filter, the RVM review gate and (from #2749) a payment check always run,
 * whatever the switch says, so turning a switch back to `off` — the rollback lever — can never
 * expose an RVM-only job to BadaBhai workers or skip a charge.
 *
 * FAIL CLOSED: an unknown feature reads as `off`, and in `pilot` a pilot-list read that throws
 * answers "not enabled" and logs ids only. A database blip hides a pilot feature for a request; it
 * never opens one to everybody.
 */
@Injectable()
export class FeatureRolloutService {
  private readonly logger = new Logger(FeatureRolloutService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly pilots: FeaturePilotRepository,
  ) {}

  /** Is the feature on for this company? `off` no, `on` yes, `pilot` only when listed. */
  async isEnabledFor(feature: FeatureRolloutKey, tenantKey: TenantKey): Promise<boolean> {
    switch (this.mode(feature)) {
      case "on":
        return true;
      case "pilot":
        try {
          return await this.pilots.isListed(feature, tenantKey);
        } catch (err) {
          // The SQLSTATE tells a missing table (42P01: `pilot` armed before migration 0162) from
          // a dropped connection. Ids and the code only; never the error text.
          this.logger.warn(
            `feature rollout: pilot list read failed (feature=${feature} tenant=${tenantKey} sqlstate=${sqlStateOf(err) ?? "none"}); treated as off`,
          );
          return false;
        }
      default:
        return false;
    }
  }

  /**
   * Is the feature live (`pilot` or `on`) for a SERVICE caller that acts for no company — Campus's
   * service routes, which answer 404 while a feature is off. NOT a company check: in `pilot` it is
   * true for every company, so a payer path that used it would skip the pilot list. Every call
   * site is on an allow-list in `feature-rollout.service.test.ts`; adding one is a reviewed edit.
   */
  isLiveForServiceCaller(feature: FeatureRolloutKey): boolean {
    const mode = this.mode(feature);
    return mode === "pilot" || mode === "on";
  }

  /** The switch as configured; an unknown key (a cast, a prototype name) reads as `off`. */
  private mode(feature: FeatureRolloutKey): FeatureRolloutMode {
    if (!Object.hasOwn(FEATURE_ROLLOUT_CONFIG, feature)) return "off";
    return this.config[FEATURE_ROLLOUT_CONFIG[feature]];
  }
}
