import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { featurePilotSubjects, type Database, type FeaturePilotSubjectKind } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { FeatureRolloutKey } from "./feature-rollout.keys";

/**
 * The pilot list for workers and admins (`feature_pilot_subjects`, migration 0164, #2820).
 * READ-ONLY here, as the company list: rows are added by the owner (SQL, with `added_by` and
 * `reason`) or a later admin route, never by the login itself. A database without the table
 * (0164 not applied yet) throws 42P01 here, and the service answers "not listed".
 */
@Injectable()
export class FeaturePilotSubjectsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Is this worker or admin (the id from its auth guard) on the pilot list? One PK probe. */
  async isListed(
    feature: FeatureRolloutKey,
    kind: FeaturePilotSubjectKind,
    subjectId: string,
  ): Promise<boolean> {
    const rows = await this.db
      .select({ feature: featurePilotSubjects.feature })
      .from(featurePilotSubjects)
      .where(
        and(
          eq(featurePilotSubjects.feature, feature),
          eq(featurePilotSubjects.subjectKind, kind),
          eq(featurePilotSubjects.subjectId, subjectId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
