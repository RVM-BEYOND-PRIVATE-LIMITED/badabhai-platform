import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { type Database, matchConfig, type MatchConfig as MatchConfigRow } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * Data access for the single active `match_config` row (migration 0057) — a deliberate
 * clone of {@link ../pricing/pricing.repository.ts PricingRepository}, because
 * `match_config` is a deliberate clone of `pricing_catalog`.
 *
 * Read-only here. There is NO publish/update method: V1 ships with the row seeded by
 * `db:seed:match:vocabulary` (D1) and edited by ops directly. An API write surface for
 * the rank rule's knobs is a change-control decision (spec Policy 23/25: a rank-key or
 * bucket change needs a new `engine_version`, CEO sign-off and an ADR), not something a
 * backend change should quietly hand to an unauthenticated route.
 */
@Injectable()
export class MatchConfigRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The single active config row, or undefined if D1 has not seeded one yet. */
  async getActive(): Promise<MatchConfigRow | undefined> {
    const rows = await this.db
      .select()
      .from(matchConfig)
      .where(eq(matchConfig.isActive, true))
      .limit(1);
    return rows[0];
  }
}
