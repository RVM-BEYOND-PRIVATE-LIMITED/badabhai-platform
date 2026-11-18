import { Injectable, Logger, Optional } from "@nestjs/common";
import { RVM_INSTITUTE_CODE } from "@badabhai/db";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import { EffectiveFactsService } from "../profiles/effective-facts.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import {
  applicantSourceOf,
  EMPTY_PRE_PAY_FACTS,
  toPrePayFacts,
  type ApplicantSource,
  type PrePayFacts,
  type PrePayInstituteLink,
} from "./pre-pay-facts";
import { PrePayFactsRepository } from "./pre-pay-facts.repository";
import { WorkerActivityService } from "../worker-activity/worker-activity.service";

/** What every labelled row gains: always the source; the facts only while the switch is on. */
export type WithPrePayFacts<R> = R & { source: ApplicantSource } & Partial<PrePayFacts> & {
    notRecentlyActive?: boolean;
  };

/**
 * The company-facing card's #2747 additions, for the applicant lists and the search card.
 *
 *  - `source` (item 1) is on EVERY row, whatever the switch says: a label, not a disclosure. A row
 *    that already carries `instituteCode` (the V1 applicant row, read in the list's own statement)
 *    is labelled from it, so the label and the code on one row cannot disagree.
 *  - The pre-pay facts (item 4) are added only while `applicant_facts` is on for the company
 *    (`FeatureRolloutService`, item 9). Off, not one of their keys is sent and none of the facts
 *    reads runs (only the active-link read, for the label of a row that has no `instituteCode`),
 *    so the response is exactly today's plus `source`. The switch gates what is SHOWN; it never
 *    changes who is listed.
 *  - CONSENT: a worker without live `employer_sharing` (and without an active RVM link, which the
 *    institute rule decides) gets every fact as "not given", whatever the switch says.
 *
 * PLAINTEXT DISCIPLINE. The first name is decrypted here, per page, from `workers.full_name`, cut
 * to its first word by the pure mapper, and dropped with the page: never cached, never logged,
 * never put in an event. A name that fails to decrypt is "not given", and the log line carries
 * the worker id only.
 *
 * #2753 — LAST ACTIVE, ONE DEFINITION. While `WORKER_ACTIVITY_ENABLED` is on, the page's last-active
 * days are read ONCE (`WorkerActivityService.lastActiveDays`, one statement) and give two things:
 *  - `notRecentlyActive` on EVERY row (item 7): more than `NOT_RECENTLY_ACTIVE_DAYS` since his last
 *    active day. Like `source` it is an activity mark, not a profile fact, so neither the
 *    `applicant_facts` switch nor his consent gates it. A mark only: nobody is hidden or re-sorted
 *    (owner question 3), so this still decorates and never filters.
 *  - the pre-pay fact `lastActiveOn` (item 4), from the same day, for the workers the facts are
 *    shown for at all.
 * Off, no row carries `notRecentlyActive`, `lastActiveOn` is his newest device sighting as before,
 * and `worker_activity` is never read.
 */
@Injectable()
export class PrePayFactsService {
  private readonly logger = new Logger(PrePayFactsService.name);

  constructor(
    private readonly repo: PrePayFactsRepository,
    private readonly rollout: FeatureRolloutService,
    private readonly pii: PiiCryptoService,
    // ADR-0062 §3.2 — the live admin corrections (city, trade, role, salary). Optional so a
    // hand-built unit instance compiles; Nest injects it (WorkersModule is @Global).
    @Optional() private readonly corrections?: EffectiveFactsService,
    // #2753 — the one last-active read. Optional so a hand-built unit instance compiles; MatchModule
    // imports WorkerActivityModule, so Nest always injects it (worker-activity.module.test.ts).
    @Optional() private readonly activity?: WorkerActivityService,
  ) {}

  /** Is `applicant_facts` on for this company? Fails closed (the rollout service's rule). */
  factsEnabledFor(tenantKey: TenantKey): Promise<boolean> {
    return this.rollout.isEnabledFor("applicant_facts", tenantKey);
  }

  /**
   * Label each row and, when the switch is on for `tenantKey`, add the pre-pay facts. Count in ==
   * count out and the order is kept: this decorates, it never filters or sorts.
   */
  async decorate<R extends { workerId: string; instituteCode?: string | null }>(
    rows: readonly R[],
    tenantKey: TenantKey,
    now: Date = new Date(),
  ): Promise<WithPrePayFacts<R>[]> {
    if (rows.length === 0) return [];
    const on = await this.factsEnabledFor(tenantKey);
    const ids = [...new Set(rows.map((r) => r.workerId))];
    const needLinks = on || rows.some((r) => !("instituteCode" in r));
    const [links, days] = await Promise.all([
      needLinks ? this.activeLinks(ids) : Promise.resolve(new Map<string, PrePayInstituteLink>()),
      // #2753 — null, and no query, while WORKER_ACTIVITY_ENABLED is off.
      this.activity ? this.activity.lastActiveDays(ids, now) : Promise.resolve(null),
    ]);
    const sourceOf = (row: R): ApplicantSource =>
      applicantSourceOf(
        "instituteCode" in row
          ? row.instituteCode
          : (links.get(row.workerId.toLowerCase())?.instituteCode ?? null),
      );
    // #2753 item 7 — the mark rides with `source`: on every row while the switch is on, and the key
    // is absent (today's shape) while it is off.
    const markOf = (row: R): { notRecentlyActive?: boolean } =>
      days === null || !this.activity
        ? {}
        : { notRecentlyActive: this.activity.notRecentlyActive(days, row.workerId, now) };
    if (!on) return rows.map((row) => ({ ...row, source: sourceOf(row), ...markOf(row) }));

    const facts = await this.factsFor(ids, links, now, days);
    return rows.map((row) => ({
      ...row,
      source: sourceOf(row),
      ...(facts.get(row.workerId.toLowerCase()) ?? EMPTY_PRE_PAY_FACTS),
      ...markOf(row),
    }));
  }

  private async activeLinks(ids: readonly string[]): Promise<Map<string, PrePayInstituteLink>> {
    const rows = await this.repo.listActiveInstituteLinks(ids);
    return new Map(
      rows.map((r) => [
        r.workerId.toLowerCase(),
        { instituteCode: r.instituteCode, course: r.course, branch: r.branch },
      ]),
    );
  }

  /**
   * `days` is the page's #2753 last-active map while WORKER_ACTIVITY_ENABLED is on (then it is the
   * `lastActiveOn` fact), or null while it is off (then the fact is the device sighting, as before).
   */
  private async factsFor(
    ids: readonly string[],
    links: ReadonlyMap<string, PrePayInstituteLink>,
    now: Date,
    days: ReadonlyMap<string, string> | null,
  ): Promise<Map<string, PrePayFacts>> {
    const [raw, overrides] = await Promise.all([
      this.repo.listForWorkers(ids),
      this.corrections ? this.corrections.resolveMany(ids) : Promise.resolve(new Map()),
    ]);
    const out = new Map<string, PrePayFacts>();
    for (const row of raw) {
      const key = row.workerId.toLowerCase();
      const link = links.get(key);
      // CONSENT, the same rule as everything else a company can see of him. An actively linked
      // RVM student is decided by the institute rule (#2752: the tag rule wins while the link is
      // active; he is on this list because he applied, or because the company holds his search
      // grant); every other worker by his own LATEST consent row's `employer_sharing`. Without it
      // — he used the "stop employer contact" exit, or an under-18 declaration withdrew his
      // consent — the card says "not given" for every fact, and his name is never decrypted.
      // #2747 §3.8 — and only on a notice that describes facts before paying: a worker whose
      // latest consent is on the 2026-11-04 notice was told his name is not shown before an unlock.
      const consented =
        link?.instituteCode === RVM_INSTITUTE_CODE || (row.employerSharing && row.onBriefNotice);
      if (!consented) {
        out.set(key, EMPTY_PRE_PAY_FACTS);
        continue;
      }
      const facts = toPrePayFacts(
        {
          workerId: row.workerId,
          fullName: this.decryptName(row.workerId, row.fullNameEnc),
          workersCity: row.workersCity,
          canonicalTradeId: row.canonicalTradeId,
          canonicalRoleId: row.canonicalRoleId,
          machineIds: row.machineIds,
          salaryContainer: row.salaryContainer,
          salaryExpectedMin: row.salaryExpectedMin,
          salaryExpectedMax: row.salaryExpectedMax,
          salaryPeriod: row.salaryPeriod,
          lastSeenAt: row.lastSeenAt,
          institute: link ?? null,
          overrides: overridesFor(overrides, row.workerId),
        },
        now,
      );
      // #2753 — one definition of last active: the unified day replaces the device-only one.
      out.set(key, days === null ? facts : { ...facts, lastActiveOn: days.get(key) ?? null });
    }
    return out;
  }

  private decryptName(workerId: string, token: string | null): string | null {
    if (token === null) return null;
    try {
      return this.pii.decrypt(token);
    } catch {
      this.logger.warn(
        `pre-pay facts: full_name did not decrypt (worker=${workerId}); first name not given`,
      );
      return null;
    }
  }
}

function overridesFor(
  all: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
  workerId: string,
): ReadonlyMap<string, unknown> {
  const direct = all.get(workerId);
  if (direct) return direct;
  const lower = workerId.toLowerCase();
  for (const [id, map] of all) if (id.toLowerCase() === lower) return map;
  return new Map();
}
