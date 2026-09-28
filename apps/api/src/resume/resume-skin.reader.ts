import { Inject, Injectable, Logger } from "@nestjs/common";

import type { ServerConfig } from "@badabhai/config";
import { DEFAULT_RESUME_SKIN, isResumeSkin, type ResumeSkin } from "@badabhai/types";

import { SERVER_CONFIG } from "../config/config.module";
import { ResumeSkinRepository } from "./resume-skin.repository";

/**
 * Reads the skin a worker's `bb_trade` sheet prints in (#1801) — the READ half of résumé skins,
 * shared by the render worker and `ResumeSkinService` so the two can never disagree about what a
 * missing or unrecognised row means.
 *
 * A SEPARATE CLASS FROM THE SERVICE, AND THAT IS LOAD-BEARING. The render processor may hold no
 * event surface (its TD5 security test asserts it), and the service emits `resume.skin_changed`.
 * This reader reaches `ResumeSkinRepository` (the @Global DATABASE only) and SERVER_CONFIG —
 * nothing else — which is the `ResumeTierScopeReader` shape.
 *
 * NULL WHILE `RESUME_SKINS_ENABLED` IS OFF, and nothing is queried: the sheet then prints from its
 * template exactly as shipped, and migration 0128 need not be applied. On, a worker with no row
 * prints in Neela (`DEFAULT_RESUME_SKIN`), the house style.
 *
 * MAY THROW (a database failure); the render worker degrades that to the template as shipped on
 * its one-load-one-section rule.
 */
@Injectable()
export class ResumeSkinReader {
  private readonly logger = new Logger(ResumeSkinReader.name);

  constructor(
    private readonly repo: ResumeSkinRepository,
    @Inject(SERVER_CONFIG)
    private readonly config: Pick<ServerConfig, "RESUME_SKINS_ENABLED">,
  ) {}

  /** `RESUME_SKINS_ENABLED`. Only `true` turns skins on; unset is off. */
  get enabled(): boolean {
    return this.config.RESUME_SKINS_ENABLED === true;
  }

  /** The skin their sheet prints in; null while skins are off (no query). */
  async forWorker(workerId: string): Promise<ResumeSkin | null> {
    if (!this.enabled) return null;
    return this.known(await this.repo.findSkin(workerId)) ?? DEFAULT_RESUME_SKIN;
  }

  /**
   * A stored value narrowed to the vocabulary this build knows. `wrs_skin_chk` keeps the column
   * inside `RESUME_SKINS`, so an unknown value means the database is AHEAD of this build (a skin
   * added by a later migration, then the code rolled back). It is read as "no choice" and is never
   * handed to the renderer or the event, both of which would refuse it.
   */
  known(stored: string | null): ResumeSkin | null {
    if (stored === null) return null;
    if (isResumeSkin(stored)) return stored;
    this.logger.warn(
      "worker_resume_skin holds a skin this build does not know; reading it as none",
    );
    return null;
  }
}
