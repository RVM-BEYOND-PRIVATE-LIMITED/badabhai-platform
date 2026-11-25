import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { appReleasePolicy, type AppReleasePolicyRow, type Database } from "@badabhai/db";

import { DATABASE } from "../database/database.module";
import type { AppName, AppPlatform } from "./app-version.constants";

/** The editable half of one row. */
export interface AppReleasePolicyWrite {
  readonly minSupportedBuild: number;
  readonly latestBuild: number;
  readonly storeUrl: string | null;
  readonly messageKey: string;
}

/**
 * #3048 — data access for the minimum supported app build (`app_release_policy`).
 *
 * One row per app and platform, seeded by the migration; a row is never inserted or deleted here,
 * only updated in place. `updated_by` is the `admin_users.id` that made the change (null for the
 * seed).
 */
@Injectable()
export class AppVersionRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /** Every row (at most four). */
  async all(executor: Database = this.db): Promise<AppReleasePolicyRow[]> {
    return executor.select().from(appReleasePolicy);
  }

  /** One row, locked for the write that follows; null when the seed is missing. */
  async findForUpdate(
    tx: Database,
    app: AppName,
    platform: AppPlatform,
  ): Promise<AppReleasePolicyRow | null> {
    const rows = await tx
      .select()
      .from(appReleasePolicy)
      .where(and(eq(appReleasePolicy.app, app), eq(appReleasePolicy.platform, platform)))
      .for("update");
    return rows[0] ?? null;
  }

  /** Update one row in place. Returns the row after the write. */
  async update(
    tx: Database,
    app: AppName,
    platform: AppPlatform,
    input: AppReleasePolicyWrite & { readonly updatedBy: string },
  ): Promise<AppReleasePolicyRow> {
    const rows = await tx
      .update(appReleasePolicy)
      .set({
        minSupportedBuild: input.minSupportedBuild,
        latestBuild: input.latestBuild,
        storeUrl: input.storeUrl,
        messageKey: input.messageKey,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      })
      .where(and(eq(appReleasePolicy.app, app), eq(appReleasePolicy.platform, platform)))
      .returning();
    const row = rows[0];
    if (!row) throw new Error("app_release_policy: the update wrote no row");
    return row;
  }
}
