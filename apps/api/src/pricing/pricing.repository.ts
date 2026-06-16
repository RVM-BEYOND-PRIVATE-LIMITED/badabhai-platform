import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import {
  type Database,
  pricingCatalog,
  type PricingCatalogRow,
  type NewPricingCatalogRow,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** A new catalog revision to publish. */
export interface PublishCatalogInput {
  readonly catalog: NewPricingCatalogRow["catalog"];
  readonly revision: number;
  readonly updatedBy: string;
}

@Injectable()
export class PricingRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The single active catalog row, or undefined if none has been seeded yet. */
  async getActive(): Promise<PricingCatalogRow | undefined> {
    const rows = await this.db
      .select()
      .from(pricingCatalog)
      .where(eq(pricingCatalog.isActive, true))
      .limit(1);
    return rows[0];
  }

  /**
   * Publish a new active revision atomically: deactivate the current active row,
   * then insert the new one. Done in ONE transaction so the partial unique index
   * (`pricing_catalog_active_uq`, one active row) never sees two active rows, and a
   * failed insert never leaves the catalog with zero active rows.
   */
  async publish(input: PublishCatalogInput): Promise<PricingCatalogRow> {
    return this.db.transaction(async (tx) => {
      await tx
        .update(pricingCatalog)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(pricingCatalog.isActive, true));
      const inserted = await tx
        .insert(pricingCatalog)
        .values({
          catalog: input.catalog,
          revision: input.revision,
          isActive: true,
          updatedBy: input.updatedBy,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("Failed to publish pricing catalog");
      return row;
    });
  }
}
