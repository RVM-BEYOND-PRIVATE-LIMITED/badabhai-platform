import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { WorkerProfile } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
// VALUE import: a constructor parameter, resolved by Nest from the emitted `design:paramtypes`.
import { ResumeService } from "../resume/resume.service";
import {
  currentResumeFacts,
  resumeDownloadOf,
  resumeStateOf,
  type CompanionResumeDownload,
} from "./companion-facts";

/**
 * WHETHER THE WORKER'S RÉSUMÉ CAN BE HANDED OVER NOW (ADR-0055, #2275) — the one read behind the Bada
 * Bhai chat's answer to "resume download karna hai".
 *
 * THE RECAP'S OWN RULE, NOT A SECOND ONE. The current résumé is mapped by `currentResumeFacts` and
 * judged by `resumeStateOf` with the same grace the recap uses
 * (`RESUME_UPDATE_PENDING_TIMEOUT_SECONDS`), so the recap and this answer cannot disagree about what
 * the worker has; `resumeDownloadOf` then asks only the one extra question a download needs — is the
 * PDF drawn.
 *
 * READ-ONLY AND FAIL SAFE. `ResumeService.history` is the Resume tab's own read (no event, no write).
 * A read that throws is `unavailable` — no chip, no promise — and a PII-free warn with ids only.
 */
@Injectable()
export class CompanionResumeStatus {
  private readonly logger = new Logger(CompanionResumeStatus.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly resumes: ResumeService,
  ) {}

  async downloadOf(
    workerId: string,
    profile: WorkerProfile,
    now: Date,
  ): Promise<CompanionResumeDownload> {
    let history: Awaited<ReturnType<ResumeService["history"]>> | undefined;
    try {
      history = await this.resumes.history(workerId, now);
    } catch (err) {
      this.logger.warn(
        `companion résumé status unreadable for worker ${workerId}; no download is offered (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      history = undefined;
    }
    const resume = currentResumeFacts(history?.items[0]);
    const state = resumeStateOf({
      resume,
      unavailable: history === undefined,
      confirmedAt: profile.confirmedAt,
      now,
      graceMs: this.config.RESUME_UPDATE_PENDING_TIMEOUT_SECONDS * 1_000,
    });
    return resumeDownloadOf(state, resume);
  }
}
