import { Inject, Injectable, Logger } from "@nestjs/common";
import type { FeatureRolloutMode, ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { FeaturePilotRepository } from "./feature-pilot.repository";
import { FEATURE_ROLLOUT_CONFIG, type FeatureRolloutKey } from "./feature-rollout.keys";

/**
 * THE rollout question (#2746 item 1): is a feature on, and is it on for this company?
 *
 * The only reader of the `*_ROLLOUT` switches (a static test pins that), so every gate answers the
 * same way. A company is identified by its TENANT key (`PayerTenantScopeService.resolve`), so a team
 * member inherits the company's pilot place; never pass a raw id from a body or a path.
 *
 * FAIL CLOSED: in `pilot`, a pilot-list read that throws answers "not enabled" and logs ids only.
 * A database blip then hides a pilot feature for a request; it never opens one to everybody.
 */
@Injectable()
export class FeatureRolloutService {
  private readonly logger = new Logger(FeatureRolloutService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly pilots: FeaturePilotRepository,
  ) {}

  /** The switch as configured. */
  mode(feature: FeatureRolloutKey): FeatureRolloutMode {
    return this.config[FEATURE_ROLLOUT_CONFIG[feature]];
  }

  /**
   * Is the feature live for anyone (`pilot` or `on`)? For gates with no company in hand, such as
   * Campus's service routes: off answers 404 there as everywhere.
   */
  isLiveAnywhere(feature: FeatureRolloutKey): boolean {
    return this.mode(feature) !== "off";
  }

  /** Is the feature on for this company? `off` no, `on` yes, `pilot` only when listed. */
  async isEnabledFor(feature: FeatureRolloutKey, tenantKey: TenantKey): Promise<boolean> {
    const mode = this.mode(feature);
    if (mode === "off") return false;
    if (mode === "on") return true;
    try {
      return await this.pilots.isListed(feature, tenantKey);
    } catch {
      this.logger.warn(
        `feature rollout: pilot list read failed (feature=${feature} tenant=${tenantKey}); treated as off`,
      );
      return false;
    }
  }
}
