import { Inject, Injectable } from "@nestjs/common";
import { workerOrigins, type Database, type WorkerOriginKind } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** The two origins a referral code can record (#2753 item 12). */
export type ReferralOriginKind = Extract<WorkerOriginKind, "partner" | "referrer">;

/**
 * #2753 item 12 — the came-from row (`worker_origins`, #2752 item 11) for a profile that arrived
 * through a code: `referrer` for a worker's invite (`invites`), `partner` for an agency's invite
 * (`agency_invites`). `ref` is the code itself, as the table's doc comment asks ("the code that
 * brought him"); its CHECK admits only code characters, and an accepted invite is spent, so the
 * stored code can attribute nobody else.
 *
 * FIRST TOUCH WINS, per the table: an origin already recorded (the Campus link's `institute`, an
 * earlier code) is never overwritten. One statement, `ON CONFLICT DO NOTHING` on the primary key,
 * so two concurrent attributions for one worker leave exactly one row.
 */
@Injectable()
export class WorkerOriginRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** True when this call wrote the row; false when he already had an origin. */
  async recordFirst(workerId: string, kind: ReferralOriginKind, ref: string): Promise<boolean> {
    const rows = await this.db
      .insert(workerOrigins)
      .values({ workerId, kind, ref })
      .onConflictDoNothing({ target: workerOrigins.workerId })
      .returning({ workerId: workerOrigins.workerId });
    return rows.length > 0;
  }
}
