import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import {
  type Database,
  matchingCatalog,
  type MatchingCatalogRow,
  type NewMatchingCatalogRow,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** A validated catalog revision to publish. Validation happens ABOVE this layer. */
export interface PublishMatchingCatalogInput {
  readonly catalog: NewMatchingCatalogRow["catalog"];
  readonly updatedBy: string;
}

/**
 * Data access for `matching_catalog` (migration 0099) — a deliberate clone of
 * {@link ../pricing/pricing.repository.ts PricingRepository}, because
 * `matching_catalog` is a deliberate clone of `pricing_catalog`.
 *
 * This layer is dumb on purpose: it does no validation. The publish-time gate lives in
 * {@link ./matching-catalog.service.ts MatchingCatalogService}, which is what makes the
 * P1 invariant a single auditable line rather than a property spread across two files.
 */
@Injectable()
export class MatchingCatalogRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The single active catalog row, or **null** when none is active.
   *
   * !! THE NULL IS LOAD-BEARING. DO NOT ADD A FALLBACK HERE. !!
   *
   * A fresh database has ZERO active catalogs, and that is a correct, expected state
   * — rulings R1-R4 are open, so there is no real taxonomy to publish yet. The only
   * row a seeder writes is the synthetic FIXTURE, and it ships `is_active = false`
   * precisely so that it can never be reached through this method.
   *
   * If this ever fell back to `FIXTURE_CATALOG`, P2's tier resolver would run against
   * `role_placeholder_a` / `dom_placeholder_b` and return confident, structurally valid
   * matches over ids that mean nothing. Nothing would throw, no alert would fire, and
   * the failure would surface weeks later as "matching seems off". A null that a caller
   * must handle is the whole defence.
   *
   * Returns `null` rather than `undefined` — unlike its `pricing`/`match_config`
   * siblings — because `undefined` is what an accidental `rows[0]` on an empty array
   * yields anyway, and is therefore indistinguishable from "I forgot to check".
   */
  async getActive(): Promise<MatchingCatalogRow | null> {
    const rows = await this.db
      .select()
      .from(matchingCatalog)
      .where(eq(matchingCatalog.isActive, true))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Read one revision by number, active or not. For audit and diffing. */
  async getByRevision(revision: number): Promise<MatchingCatalogRow | null> {
    const rows = await this.db
      .select()
      .from(matchingCatalog)
      .where(eq(matchingCatalog.revision, revision))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Publish a new active revision atomically: deactivate the current active row, then
   * insert the new one. ONE transaction, so the partial unique index
   * (`matching_catalog_active_uq`) never sees two active rows, and a failed insert
   * never leaves the catalog with a deactivated row and nothing to replace it.
   *
   * The revision number is computed HERE as `MAX(revision) + 1` rather than taken from
   * the caller. Two concurrent publishes therefore collide on
   * `matching_catalog_revision_uq` and one fails loudly, instead of a client-supplied
   * number silently overwriting the meaning of "revision 7" in a signed RVM packet.
   */
  async publish(input: PublishMatchingCatalogInput): Promise<MatchingCatalogRow> {
    return this.db.transaction(async (tx) => {
      await tx
        .update(matchingCatalog)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(matchingCatalog.isActive, true));

      const [{ next } = { next: 1 }] = await tx
        .select({ next: sql<number>`COALESCE(MAX(${matchingCatalog.revision}), 0) + 1` })
        .from(matchingCatalog);

      const inserted = await tx
        .insert(matchingCatalog)
        .values({
          catalog: input.catalog,
          revision: Number(next),
          isActive: true,
          updatedBy: input.updatedBy,
        })
        .returning();

      const row = inserted[0];
      if (!row) throw new Error("Failed to publish matching catalog");
      return row;
    });
  }

  /**
   * Insert an INACTIVE revision. The seeder's only entry point — there is deliberately
   * no way to seed an active catalog, so the fixture cannot become the live taxonomy
   * through a seeding path either.
   */
  async insertInactive(input: PublishMatchingCatalogInput): Promise<MatchingCatalogRow> {
    return this.db.transaction(async (tx) => {
      const [{ next } = { next: 1 }] = await tx
        .select({ next: sql<number>`COALESCE(MAX(${matchingCatalog.revision}), 0) + 1` })
        .from(matchingCatalog);

      const inserted = await tx
        .insert(matchingCatalog)
        .values({
          catalog: input.catalog,
          revision: Number(next),
          isActive: false,
          updatedBy: input.updatedBy,
        })
        .returning();

      const row = inserted[0];
      if (!row) throw new Error("Failed to insert matching catalog revision");
      return row;
    });
  }
}
