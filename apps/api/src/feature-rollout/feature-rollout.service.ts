import { Inject, Injectable, Logger } from "@nestjs/common";
import type { FeatureRolloutMode, ServerConfig } from "@badabhai/config";
import { sqlStateOf } from "../common/db-error";
import { SERVER_CONFIG } from "../config/config.module";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { FeaturePilotSubjectsRepository } from "./feature-pilot-subjects.repository";
import { FeaturePilotRepository } from "./feature-pilot.repository";
import { FEATURE_ROLLOUT_CONFIG, type FeatureRolloutKey } from "./feature-rollout.keys";
import type { RolloutCaller } from "./rollout-caller";

/**
 * THE rollout question (#2746 item 1): is a feature on, and is it on for this company? And, for
 * the theme (#2820), is it open for this login: a worker, a company or an admin?
 *
 * The only reader of the `*_ROLLOUT` switches (a static test pins that), so every gate answers the
 * same way. A company is identified by its TENANT key (`PayerTenantScopeService.resolve`); never
 * pass a raw id from a body or a path. With `PAYER_ORG_TENANCY_MODE=on` that key is the company's
 * anchor, so a team member inherits its pilot place; in `off` / `shadow` the key is the login
 * itself, so each login that should see the pilot needs its own `feature_pilot_payers` row. A
 * worker or an admin is identified by the id its auth guard attached, through a sealed
 * {@link RolloutCaller}, and listed in `feature_pilot_subjects`.
 *
 * A SWITCH GATES CAPABILITIES, NEVER STORED RESTRICTIONS. It decides whether new input is accepted,
 * a route is mounted or a row may be created. It never decides whether stored state is honoured:
 * the worker-path audience filter, the RVM review gate and (from #2749) a payment check always run,
 * whatever the switch says, so turning a switch back to `off` — the rollback lever — can never
 * expose an RVM-only job to BadaBhai workers or skip a charge. (A stored theme is a preference, not
 * a restriction: closed, the app gets its default and the stored choice waits.)
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
    private readonly subjects: FeaturePilotSubjectsRepository,
  ) {}

  /** Is the feature on for this company? `off` no, `on` yes, `pilot` only when listed. */
  isEnabledFor(feature: FeatureRolloutKey, tenantKey: TenantKey): Promise<boolean> {
    return this.decide(feature, `tenant=${tenantKey}`, () =>
      this.pilots.isListed(feature, tenantKey),
    );
  }

  /**
   * #2820 — may this login use a theme other than the app's default? THE theme question for every
   * app; the switch is `THEME_ROLLOUT`. `off` no, `on` yes (neither reads a list), `pilot` only
   * when listed: a company in `feature_pilot_payers` by its tenant key, a worker or an admin in
   * `feature_pilot_subjects` by its id. NEVER THROWS: a failed read, a missing table (42P01)
   * included, answers false.
   */
  isThemeOpenFor(caller: RolloutCaller): Promise<boolean> {
    return this.isEnabledForCaller("theme", caller);
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

  /** One login's answer: a company through its tenant key, a worker or an admin through its id. */
  private isEnabledForCaller(feature: FeatureRolloutKey, caller: RolloutCaller): Promise<boolean> {
    switch (caller.kind) {
      case "payer":
        return this.isEnabledFor(feature, caller.tenantKey);
      case "worker":
        return this.decide(feature, `worker=${caller.workerId}`, () =>
          this.subjects.isListed(feature, "worker", caller.workerId),
        );
      case "admin":
        return this.decide(feature, `admin=${caller.adminId}`, () =>
          this.subjects.isListed(feature, "admin", caller.adminId),
        );
      default:
        // Unreachable while the union is sealed; a caller of no known kind is nobody's pilot.
        return Promise.resolve(false);
    }
  }

  /**
   * `off` no and `on` yes, without a read; `pilot` asks `listed`. A read that throws is "not
   * listed", logged with `who` (ids) and the SQLSTATE only.
   */
  private async decide(
    feature: FeatureRolloutKey,
    who: string,
    listed: () => Promise<boolean>,
  ): Promise<boolean> {
    switch (this.mode(feature)) {
      case "on":
        return true;
      case "pilot":
        try {
          return await listed();
        } catch (err) {
          // The SQLSTATE tells a missing table (42P01: `pilot` armed before migration 0162 for a
          // company, 0164 for a worker or an admin) from a dropped connection. Ids and the code
          // only; never the error text.
          this.logger.warn(
            `feature rollout: pilot list read failed (feature=${feature} ${who} sqlstate=${sqlStateOf(err) ?? "none"}); treated as off`,
          );
          return false;
        }
      default:
        return false;
    }
  }

  /** The switch as configured; an unknown key (a cast, a prototype name) reads as `off`. */
  private mode(feature: FeatureRolloutKey): FeatureRolloutMode {
    if (!Object.hasOwn(FEATURE_ROLLOUT_CONFIG, feature)) return "off";
    return this.config[FEATURE_ROLLOUT_CONFIG[feature]];
  }
}
