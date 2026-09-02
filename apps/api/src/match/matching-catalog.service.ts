import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import {
  describeIssues,
  validateMatchingCatalog,
  type MatchingCatalog,
} from "@badabhai/matching-catalog";
import { MatchingCatalogRepository } from "./matching-catalog.repository";
import type { PublishCatalogDto } from "./matching-catalog.dto";

/** What the read endpoint returns when no catalog is active. */
export interface NoActiveCatalog {
  readonly active: false;
}

/** What the read endpoint returns when a catalog is active and validates. */
export interface ActiveCatalog {
  readonly active: true;
  readonly revision: number;
  readonly updatedAt: Date;
  readonly catalog: MatchingCatalog;
}

export type ReadCatalogResult = ActiveCatalog | NoActiveCatalog;

/**
 * The matching-catalog publish path.
 *
 * ============================================================================
 * P1 INVARIANT — AN INVALID CATALOG CAN NEVER BECOME THE ACTIVE ONE.
 * ============================================================================
 * Enforced at ONE place, `publish()` below: `validateMatchingCatalog` runs and a
 * failure throws BEFORE the repository is called, so no invalid blob ever reaches an
 * INSERT, let alone an active row.
 *
 * Two more layers sit under it, deliberately, because a single application-code check
 * is only as good as the one code path that runs it:
 *   - `mc_active_shape_chk` (migration 0099) refuses to let Postgres mark a
 *     structurally malformed row active, even via a hand-written UPDATE that never
 *     touches this service.
 *   - `matching_catalog_active_uq` keeps "active" single-valued, so there is exactly
 *     one row this invariant has to hold for.
 *
 * The rejection names the offending PATH. RVM publishes a blob with roughly two
 * thousand cells in it; "invalid catalog" is not an error anyone can act on, and an
 * unactionable error is how a publisher ends up hand-editing the table instead.
 */
@Injectable()
export class MatchingCatalogService {
  private readonly logger = new Logger(MatchingCatalogService.name);

  constructor(private readonly repo: MatchingCatalogRepository) {}

  /**
   * The active catalog, validated on read.
   *
   * Read-side validation is not redundant with the publish gate: a row can be edited
   * directly in the database, and `mc_active_shape_chk` only pins the top-level
   * container types. A stored row that no longer satisfies the full contract is
   * reported as `active: false` rather than served — fail closed. The alternative,
   * serving a half-valid taxonomy, silently corrupts every match built on it.
   */
  async getActiveCatalog(): Promise<ReadCatalogResult> {
    const row = await this.repo.getActive();
    // No active catalog is a legitimate state while R1-R4 are open. It is NEVER
    // backfilled with the fixture — see MatchingCatalogRepository.getActive().
    if (!row) return { active: false };

    const result = validateMatchingCatalog(row.catalog);
    if (!result.ok) {
      this.logger.error(
        `active matching_catalog revision ${row.revision} FAILED validation on read; ` +
          `serving nothing. ${describeIssues(result.issues)}`,
      );
      return { active: false };
    }

    return {
      active: true,
      revision: row.revision,
      updatedAt: row.updatedAt,
      catalog: result.catalog,
    };
  }

  /**
   * Validate, then publish as the new active revision.
   *
   * THIS IS THE INVARIANT'S ENFORCEMENT POINT. The validate call and the throw are
   * adjacent and unconditional; there is no branch in which an invalid catalog reaches
   * `repo.publish`.
   */
  async publish(dto: PublishCatalogDto): Promise<{ revision: number; updatedAt: Date }> {
    const result = validateMatchingCatalog(dto.catalog);
    if (!result.ok) {
      // 400 with every offending path, not just the first — a publisher fixing one
      // cell per round-trip across a 22-role taxonomy is a bad afternoon.
      throw new BadRequestException({
        message: "matching catalog rejected",
        issues: result.issues,
      });
    }

    const row = await this.repo.publish({
      catalog: result.catalog,
      updatedBy: dto.updated_by,
    });

    this.logger.log(`published matching_catalog revision ${row.revision}`);
    return { revision: row.revision, updatedAt: row.updatedAt };
  }
}
