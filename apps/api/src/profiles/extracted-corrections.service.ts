import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";

import { ChatRepository } from "../chat/chat.repository";
import { type RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { WorkerSkillsService } from "../match/worker-skills.service";
import {
  CORRECTION_CAP_REACHED,
  MAX_CORRECTIONS_PER_PROFILE,
  UNPINNED_ROAD_DEFERRED,
} from "./extracted-corrections.contract";
import type { CorrectionsAppliedResponse, FieldCorrectionDto } from "./extracted-corrections.dto";
import { ProfileCorrectionsRepository } from "./profile-corrections.repository";
import { ProfilesRepository } from "./profiles.repository";
import { ProfileSkillsRepository } from "./profile-skills.repository";
import { WorkerQualificationsService } from "./worker-qualifications.service";

/**
 * Applies a worker's corrections to their EXTRACTED profile (#1311 backend half).
 *
 * See `extracted-corrections.contract.ts` for the full contract (field→writer mapping,
 * gates, caps, events, corrected-wins). This service is the mechanical execution of
 * it: ownership, pin, cap, then per-field delegate → audit row → event.
 *
 * DEPENDENCIES ARE ALL PRE-EXISTING EDGES: ChatRepository (forwardRef ChatModule),
 * @Global EventsService, @Global WorkerSkillsService, and the qualifications writer
 * already provided in this module. No ProfilingModule import (that module imports
 * this one) — the pin check reads `ChatRepository.findPackPin`, never the
 * orchestrator, so `persistPin`/`viewSettled` semantics are not even reachable here.
 */
@Injectable()
export class ExtractedCorrectionsService {
  private readonly logger = new Logger(ExtractedCorrectionsService.name);

  constructor(
    private readonly profiles: ProfilesRepository,
    private readonly corrections: ProfileCorrectionsRepository,
    private readonly profileSkills: ProfileSkillsRepository,
    private readonly qualifications: WorkerQualificationsService,
    private readonly workerSkills: WorkerSkillsService,
    private readonly chat: ChatRepository,
    private readonly events: EventsService,
  ) {}

  async correctExtracted(
    input: {
      worker_id: string;
      profile_id: string;
      session_id: string;
      corrections: FieldCorrectionDto[];
    },
    ctx: RequestContext,
  ): Promise<CorrectionsAppliedResponse> {
    const { worker_id: workerId, profile_id: profileId, session_id: sessionId } = input;

    const profile = await this.profiles.findById(profileId);
    // Ownership BOTH sides, 404 for every miss (no existence oracle for another
    // worker's profile or session — the sibling confirm route's posture).
    if (!profile || profile.workerId !== workerId) {
      throw new NotFoundException(`Profile ${profileId} not found`);
    }
    const session = await this.chat.findSession(sessionId);
    if (!session || session.workerId !== workerId) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }

    // Interview provenance, not a guess: the session must carry a durable pack pin
    // (occupation pins and close-pinned universal pointers alike). Unpinned sessions —
    // in-progress, abandoned, form-road, pre-pin rows — are deferred with a stable
    // reason, never corrected against an inferred pack.
    const pin = await this.chat.findPackPin(sessionId);
    if (!pin) {
      throw new ConflictException(
        `Session ${sessionId} has no pack pin: extracted-profile corrections anchor ` +
          `to a pinned interview (universal sessions pin at close). In-progress, ` +
          `abandoned and form-road sessions are deferred — see ` +
          `extracted-corrections.contract.ts (${UNPINNED_ROAD_DEFERRED}).`,
      );
    }

    const used = await this.corrections.countByProfile(profileId);
    if (used + input.corrections.length > MAX_CORRECTIONS_PER_PROFILE) {
      throw new ConflictException(
        `Profile ${profileId} reached the extracted-correction cap ` +
          `(${MAX_CORRECTIONS_PER_PROFILE} lifetime corrections, ${CORRECTION_CAP_REACHED}).`,
      );
    }

    let applied = 0;
    for (const correction of input.corrections) {
      const row = await this.corrections.insertCorrection({
        profileId,
        sessionId,
        field: correction.field,
      });
      await this.applyField(workerId, profileId, correction, row.id, ctx);
      await this.events.emit({
        event_name: "resume.edited",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "profile", subject_id: profileId },
        payload: {
          worker_id: workerId,
          profile_id: profileId,
          correction_id: row.id,
          session_id: sessionId,
          field: correction.field,
        },
        idempotencyKey: `resume.edited:${row.id}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
      applied += 1;
    }

    // Counts only — never the corrected values, the sibling PUT discipline.
    this.logger.log(
      `extracted corrections applied for worker ${workerId}: ${applied} field(s) on ` +
        `profile ${profileId} (total ${used + applied})`,
    );
    return {
      profile_id: profileId,
      corrections_applied: applied,
      correction_count: used + applied,
    };
  }

  /**
   * One field to its stores, per the contract mapping. Delegation, not duplication:
   * education/certificates run the existing qualifications writer (encryption, counts
   * event and re-render included); skills/machines/experience patch the profile
   * columns + raw profile verbatim, with skills additionally landing the authored
   * rows and a quiet match rebuild.
   */
  private async applyField(
    workerId: string,
    profileId: string,
    correction: FieldCorrectionDto,
    correctionId: string,
    ctx: RequestContext,
  ): Promise<void> {
    switch (correction.field) {
      case "skills":
        await this.profileSkills.replaceForProfile(profileId, correction.skill_ids, correctionId);
        await this.profiles.setSkillLists(profileId, correction.skill_ids);
        await this.workerSkills.rebuildQuietly(workerId, ctx);
        return;
      case "machines":
        await this.profiles.setMachineLists(profileId, correction.machine_ids);
        return;
      case "experience":
        await this.profiles.setExperienceTotal(profileId, correction.total_years);
        return;
      case "education":
        await this.qualifications.replaceForWorker(
          workerId,
          { educations: correction.educations },
          ctx,
        );
        return;
      case "certificates":
        await this.qualifications.replaceForWorker(
          workerId,
          { certificates: correction.certificates },
          ctx,
        );
        return;
    }
  }
}
