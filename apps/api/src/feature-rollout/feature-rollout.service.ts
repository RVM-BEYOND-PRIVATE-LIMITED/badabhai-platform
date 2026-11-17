import { ForbiddenException, Inject, Injectable, Logger } from "@nestjs/common";
import type { FeatureRolloutMode, ServerConfig } from "@badabhai/config";
import { sqlStateOf } from "../common/db-error";
import { SERVER_CONFIG } from "../config/config.module";
import type { PayerTenantScope, TenantKey } from "../payers/payer-tenant-scope";
import { FeaturePilotSubjectsRepository } from "./feature-pilot-subjects.repository";
import { FeaturePilotRepository } from "./feature-pilot.repository";
import { FEATURE_ROLLOUT_CONFIG, type FeatureRolloutKey } from "./feature-rollout.keys";
import { isSealedRolloutCaller, type RolloutCaller } from "./rollout-caller";

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
  async isEnabledFor(feature: FeatureRolloutKey, tenantKey: TenantKey): Promise<boolean> {
    return (await this.stateFor(feature, tenantKey)) === "on";
  }

  /**
   * {@link isEnabledFor} with the read failure kept apart (#2747): `unavailable` when the switch is
   * `pilot` and the pilot list could not be read. For a caller where "off" is not the safe answer —
   * the unlock path, where reading a pilot company as off would charge it again for a contact it
   * already holds — and which must refuse instead. Everyone else uses {@link isEnabledFor}.
   */
  async stateFor(
    feature: FeatureRolloutKey,
    tenantKey: TenantKey,
  ): Promise<"on" | "off" | "unavailable"> {
    switch (this.mode(feature)) {
      case "on":
        return "on";
      case "pilot":
        try {
          return (await this.pilots.isListed(feature, tenantKey)) ? "on" : "off";
        } catch (err) {
          // The SQLSTATE tells a missing table (42P01: `pilot` armed before migration 0162) from
          // a dropped connection. Ids and the code only; never the error text.
          this.logger.warn(
            `feature rollout: pilot list read failed (feature=${feature} tenant=${tenantKey} sqlstate=${sqlStateOf(err) ?? "none"}); answered unavailable (read as off, except where a caller must refuse)`,
          );
          return "unavailable";
        }
      default:
        return "off";
    }
  }

  /**
   * {@link stateFor} for a company login, with the tenancy resolution LAZY (#2749, the #2819 M1
   * shape): `off` and `on` answer WITHOUT calling `resolveScope`, so a closed or fully open switch
   * costs no membership read and no shadow-evidence line; only `pilot` resolves the tenant key and
   * reads `feature_pilot_payers`. A list read that fails is `unavailable`, as in {@link stateFor}.
   *
   * A resolver that THROWS is not caught: the caller's route answers what that resolution always
   * answered (the tenancy 403 under `PAYER_ORG_TENANCY_MODE=on`). `resolveScope` is
   * `() => this.<tenancy>.resolve(<the payer id the route acts for>)`, never a raw id as a key.
   * Not for the theme: that question has its own methods (pinned by a static test).
   */
  async stateForPayer(
    feature: FeatureRolloutKey,
    resolveScope: () => Promise<Pick<PayerTenantScope, "tenantKey">>,
  ): Promise<"on" | "off" | "unavailable"> {
    const mode = this.mode(feature);
    if (mode !== "pilot") return mode === "on" ? "on" : "off";
    const { tenantKey } = await resolveScope();
    return this.stateFor(feature, tenantKey);
  }

  /**
   * #2820 — may this login use a theme other than the app's default? THE theme question for every
   * app; the switch is `THEME_ROLLOUT`. `off` no, `on` yes (neither reads a list), `pilot` only
   * when listed: a company in `feature_pilot_payers` by its tenant key, a worker or an admin in
   * `feature_pilot_subjects` by its id. NEVER THROWS, so a route asking it cannot 500: a failed
   * read, a missing table (42P01) included, answers false, and so does a caller `rolloutCaller` did
   * not build (`null`, a non-object, a hand-made or a spread copy), whatever the switch says.
   */
  async isThemeOpenFor(caller: RolloutCaller): Promise<boolean> {
    if (!isSealedRolloutCaller(caller)) {
      this.logger.warn(
        "feature rollout: no sealed caller (feature=theme caller=unsealed); treated as off",
      );
      return false;
    }
    return this.isEnabledForCaller("theme", caller);
  }

  /**
   * #2819 (review M1) — {@link isThemeOpenFor} for a COMPANY OR AGENCY LOGIN on a route that must
   * never 403 (its display preference), with the tenancy resolution LAZY. `off` and `on` answer
   * WITHOUT calling `resolveScope`, so a closed or fully open switch costs no membership read, no
   * shadow-evidence line, no solo-org heal and no repeated denial log on every portal load. Only
   * `pilot` resolves, then probes `feature_pilot_payers` by the tenant key (a team member inherits
   * the company's place under `PAYER_ORG_TENANCY_MODE=on`). NEVER THROWS: a resolver that throws
   * (a tenancy refusal is the resolver's neutral 403, already logged there) or answers no scope is
   * false, and so is a failed list read.
   *
   * `resolveScope` is `() => this.<tenancy>.resolve(<the @CurrentPayer() login>.id)` and nothing
   * else: `rollout-caller-arguments.static.test.ts` pins every call site to that shape.
   */
  async isThemeOpenForPayer(
    resolveScope: () => Promise<Pick<PayerTenantScope, "tenantKey"> | null>,
  ): Promise<boolean> {
    const mode = this.mode("theme");
    if (mode !== "pilot") return mode === "on";
    let tenantKey: TenantKey;
    try {
      const scope = await resolveScope();
      if (typeof scope?.tenantKey !== "string") return false;
      tenantKey = scope.tenantKey;
    } catch (err) {
      if (!(err instanceof ForbiddenException)) {
        this.logger.warn(
          `feature rollout: tenancy resolve failed (feature=theme sqlstate=${sqlStateOf(err) ?? "none"}); treated as off`,
        );
      }
      return false;
    }
    // The company path every other company answer takes (#2747's `stateFor`).
    return (await this.stateFor("theme", tenantKey)) === "on";
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
        // Unreachable behind the seal check; a caller of no known kind is nobody's pilot.
        return Promise.resolve(false);
    }
  }

  /**
   * A worker's or an admin's answer (a company goes through {@link stateFor}): `off` no and `on`
   * yes, without a read; `pilot` asks `listed`. A read that throws is "not listed", logged with
   * `who` (ids) and the SQLSTATE only.
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
          // The SQLSTATE tells a missing table (42P01: `pilot` armed before migration 0164) from a
          // dropped connection. Ids and the code only; never the error text.
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
