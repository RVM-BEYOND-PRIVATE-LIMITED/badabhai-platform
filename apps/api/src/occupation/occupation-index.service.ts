/**
 * Owns the in-process occupation snapshot: builds it, refreshes it, and — the part that
 * matters most — refuses to pretend it has one when it does not.
 *
 * "NOT READY" AND "NO MATCH" ARE DIFFERENT ANSWERS AND THIS CLASS KEEPS THEM APART.
 * An empty index answers every query with "nothing matched", which is indistinguishable
 * downstream from a worker naming a trade the catalogue has never heard of. The engine
 * would record their real, common trade as an unresolved phrase, drop them to the
 * universal pack, and log nothing unusual — a total retrieval outage that looks exactly
 * like normal operation on a hard day. So `snapshot()` returns `null` until a build has
 * succeeded, and callers must decide what to do about it rather than reading a zero.
 *
 * BOOT DOES NOT BLOCK ON THE DATABASE. `onModuleInit` kicks off the first build and does
 * not await it. The API serves other traffic while it runs, and a database that is slow or
 * down at boot delays occupation retrieval instead of preventing the process from starting.
 *
 * REFRESH IS A REPLACEMENT, NEVER AN EDIT. A rebuild assembles a complete new snapshot and
 * then assigns it in one statement. Turns in flight keep reading the old one to completion.
 *
 * PRIVACY: holds public reference data only. No worker text enters this class.
 */
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { OccupationRepository } from "./occupation.repository";
import { FAMILY_CHIP_LABELS } from "./family-chip-labels";
import { buildOccupationSnapshot, type OccupationSnapshot } from "./occupation-index";

/**
 * 15 minutes, from the plan's caching table.
 *
 * The catalogue changes on a seeding cadence measured in days, so this is not about
 * freshness — it is the upper bound on how long a hand-edited row or an ops-added alias
 * stays invisible. Every conversation pins `catalogVersion` at the moment the occupation
 * is identified, so a refresh landing mid-interview cannot change that worker's answers.
 */
export const REFRESH_INTERVAL_MS = 900_000;

@Injectable()
export class OccupationIndexService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OccupationIndexService.name);
  private current: OccupationSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Guards against a slow refresh overlapping the next tick. */
  private building = false;

  constructor(private readonly repo: OccupationRepository) {}

  onModuleInit(): void {
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, REFRESH_INTERVAL_MS);
    // Node keeps the process alive for a pending timer. Nothing about a periodic index
    // rebuild should stop a container from exiting, so this one does not vote.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The current snapshot, or `null` if no build has ever succeeded. */
  snapshot(): OccupationSnapshot | null {
    return this.current;
  }

  /**
   * Rebuild from the database and swap.
   *
   * A FAILED REFRESH KEEPS THE OLD SNAPSHOT. A transient database error must not degrade a
   * working index into an empty one; stale-but-correct beats absent, and the alternative is
   * that one blip turns every subsequent turn into an unresolved phrase.
   *
   * Returns whether a new snapshot was installed, so a test can await a specific outcome
   * instead of sleeping.
   */
  async refresh(): Promise<boolean> {
    if (this.building) return false;
    this.building = true;
    try {
      // The version is read FIRST. Reading it after the rows would let a write that landed
      // mid-load be stamped with a version that already includes it, so the next refresh
      // would see no change and keep serving a snapshot missing those rows. Reading it
      // first can only under-claim — the next tick picks the change up.
      const catalogVersion = await this.repo.catalogVersion();
      if (this.current !== null && this.current.catalogVersion === catalogVersion) {
        return false;
      }

      const [domains, aliases, bindings, familyLabels] = await Promise.all([
        this.repo.loadDomains(),
        this.repo.loadAliases(),
        this.repo.loadBindings(),
        this.repo.loadFamilyLabels(),
      ]);

      const next = buildOccupationSnapshot({
        catalogVersion,
        domains,
        aliases,
        bindings,
        familyLabels,
      });

      // An empty catalogue is a FAILED build, not a valid one. The only way to reach here
      // with zero domains is an unseeded or unreachable database, and installing that would
      // be installing the silent outage this class exists to prevent.
      if (next.domains.size === 0) {
        this.logger.error(
          `occupation index build returned 0 selectable domains (version ${catalogVersion}); ` +
            `keeping the previous snapshot. The catalogue is empty or unreachable.`,
        );
        return false;
      }

      this.current = next;
      this.warnOnUnlabelledFamilies(familyLabels);
      this.logger.log(
        `occupation index built: ${next.domains.size} domains, ${next.aliasCount} aliases, ` +
          `${next.spans.exact.size} exact keys, ${next.spans.skeleton.size} skeleton keys, ` +
          `version ${catalogVersion}`,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `occupation index refresh failed; ` +
          `${this.current === null ? "NO index is available and retrieval is degraded" : "serving the previous snapshot"}`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    } finally {
      this.building = false;
    }
  }

  /**
   * Say so when the catalogue holds a family this build has no Latin label for.
   *
   * Those families' chips fall back to Devanagari `label_hi` (see `pickChipLabel`), which is
   * correct as a fallback and invisible as a symptom: the chips look fine to anyone who does not
   * read the script rule. It happens when the database is seeded from a newer corpus than the
   * running code, after a rollback, or for a retired family nobody deleted. Family ids only.
   */
  private warnOnUnlabelledFamilies(familyLabels: ReadonlyMap<string, string | null>): void {
    const unlabelled = [...familyLabels.keys()].filter((id) => !Object.hasOwn(FAMILY_CHIP_LABELS, id));
    if (unlabelled.length === 0) return;
    this.logger.warn(
      `${unlabelled.length} catalogue famil${unlabelled.length === 1 ? "y has" : "ies have"} no ` +
        `Latin chip label and will be shown in Devanagari (#1679): ${unlabelled.sort().join(", ")}. ` +
        `Add them to FAMILY_CHIP_LABELS.`,
    );
  }
}
