import { Inject, Injectable } from "@nestjs/common";
import { readCampusJobRoleCounts, readRvmStudentGroups, type Database } from "@badabhai/db";
import {
  heldCampusRoles,
  heldRvmCourses,
  type HeldCampusRole,
  type HeldRvmCourse,
} from "@badabhai/taxonomy";
import { DATABASE } from "../../database/database.module";
import { TradeReleaseService } from "../../trade-release/trade-release.service";

/** `GET admin/campus-roles/held`: names and counts only. */
export interface CampusHeldRolesResponse {
  /** Held Campus role names, most common first (the #3023 screen's contract). */
  roles: HeldCampusRole[];
  /** Additive: held RVM course names, most common first. */
  courses: HeldRvmCourse[];
}

/**
 * #3014 step 5 — the Campus held list: every distinct Campus role name (on a Campus-made job or an
 * RVM student) that the one Campus table does not name, or whose new trade is switched off, with
 * how many carry it. It is the list sent for a ruling (pack 7.2, #2995 point 3) and the admin
 * screen's panel (#3023).
 *
 * NAMES AND COUNTS ONLY: both reads group in SQL; no worker, company or phone leaves the database.
 * The release switch is read through {@link TradeReleaseService} (fail closed: a failed read holds
 * every new trade, which only lengthens the list).
 */
@Injectable()
export class AdminCampusHeldRolesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly releases: TradeReleaseService,
  ) {}

  async held(): Promise<CampusHeldRolesResponse> {
    const [jobs, students, released] = await Promise.all([
      readCampusJobRoleCounts(this.db),
      readRvmStudentGroups(this.db),
      this.releases.postingEnabledKinds(),
    ]);
    return {
      roles: heldCampusRoles(jobs, students, released),
      courses: heldRvmCourses(students, released),
    };
  }
}
