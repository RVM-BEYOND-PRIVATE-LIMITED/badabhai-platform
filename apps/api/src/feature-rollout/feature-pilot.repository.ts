import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { featurePilotPayers, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { TenantKey } from "../payers/payer-tenant-scope";
import type { FeatureRolloutKey } from "./feature-rollout.keys";

/**
 * The pilot list (`feature_pilot_payers`, migration 0162). READ-ONLY here: rows are added by the
 * owner (SQL, with `added_by` and `reason`) or a later admin route, never by a company.
 */
@Injectable()
export class FeaturePilotRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Is this company (its tenant key) on the pilot list for this feature? One PK probe. */
  async isListed(feature: FeatureRolloutKey, tenantKey: TenantKey): Promise<boolean> {
    const rows = await this.db
      .select({ feature: featurePilotPayers.feature })
      .from(featurePilotPayers)
      .where(
        and(eq(featurePilotPayers.feature, feature), eq(featurePilotPayers.payerId, tenantKey)),
      )
      .limit(1);
    return rows.length > 0;
  }
}
