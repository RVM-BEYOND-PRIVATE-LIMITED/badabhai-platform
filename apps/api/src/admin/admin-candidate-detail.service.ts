import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { CandidateSearchRepository } from "../candidates/candidate-search.repository";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { WorkerAttributesRepository } from "../profiles/worker-attributes.repository";
import { WorkerLanguagesRepository } from "../profiles/worker-languages.repository";
import { WorkerOccupationsRepository } from "../profiles/worker-occupations.repository";
import { WorkerQualificationsRepository } from "../profiles/worker-qualifications.repository";
import { WorkersRepository } from "../workers/workers.repository";
import { EffectiveFactsService } from "../profiles/effective-facts.service";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminEntitiesRepository } from "./admin-entities.repository";
import { AdminIdentityService } from "./admin-identity.service";
import { AdminCandidateDetailRepository } from "./admin-candidate-detail.repository";
import { toCandidateDetail } from "./admin-candidate-detail.mapper";
import {
  ADMIN_CANDIDATE_RECENT_APPLICATIONS,
  ADMIN_CANDIDATE_RESUME_VERSIONS_MAX,
  AdminCandidateDetailSchema,
  type AdminCandidateDetail,
} from "./admin-candidate-detail.dto";

/**
 * `GET /admin/candidates/:id` — one candidate's full record (ADR-0062 §2/§3.8/§3.9, #2560).
 *
 * ── THE ORDER, AND WHY ──────────────────────────────────────────────────────────────────────
 *  1. The faceless worker core — the 404. An unknown id reads nothing else, emits nothing and
 *     charges no name budget (the stream is not an enumeration oracle).
 *  2. `admin.candidate_viewed`, AWAITED and FAIL-CLOSED — before any profile value is read and
 *     before any name is decrypted, exactly where `admin.worker_journey_viewed` sits. A failed
 *     emit propagates: no record leaves for a look the spine does not hold.
 *  3. The name through `AdminIdentityService` (the `workers` surface: `read_identity`, the
 *     existing budget, `admin.identity_viewed` before its own decrypt) BESIDE the data reads.
 *     No `read_identity`, or no budget → `null`, and the record is served faceless.
 *  4. The data reads — through the repositories the employer-facing reads already use wherever one
 *     exists (`WorkersRepository.latestProfile`, `WorkerAttributesRepository.loadTradeSheet`, the
 *     credential/language/occupation loaders, the payer search's own statement, the stated-rung
 *     read, the admin application list), and this surface's own select-only repository for the
 *     rest. A fixed set of statements per request, all in one parallel wave — never one per row.
 *  5. The pure mapper, then a `.strict()` parse of the whole response: a field the contract does
 *     not name fails the request closed rather than leaving.
 *
 * ANY READ FAILURE PROPAGATES (a 5xx) — never a partial record.
 */
@Injectable()
export class AdminCandidateDetailService {
  constructor(
    private readonly repo: AdminCandidateDetailRepository,
    private readonly workers: WorkersRepository,
    private readonly attributes: WorkerAttributesRepository,
    private readonly qualifications: WorkerQualificationsRepository,
    private readonly languages: WorkerLanguagesRepository,
    private readonly occupations: WorkerOccupationsRepository,
    private readonly candidateSearch: CandidateSearchRepository,
    private readonly workerSkills: WorkerSkillsRepository,
    private readonly entities: AdminEntitiesRepository,
    private readonly identity: AdminIdentityService,
    private readonly events: EventsService,
    // #2561 — the live admin corrections, applied above the display precedence (ADR-0062 §3.2).
    @Optional() private readonly effectiveFacts?: EffectiveFactsService,
  ) {}

  async getCandidate(
    admin: AuthenticatedAdmin,
    workerId: string,
    ctx: RequestContext,
  ): Promise<AdminCandidateDetail> {
    const core = await this.repo.findCore(workerId);
    if (!core) throw new NotFoundException("Worker not found");

    // AUDIT BEFORE THE READ AND BEFORE ANY DECRYPT — see the class header.
    await this.auditView(admin.id, workerId, ctx);

    const [
      names,
      profile,
      jobDomain,
      tradeSheet,
      provenance,
      qualifications,
      languages,
      occupations,
      employment,
      matchSkills,
      tenure,
      cardRow,
      wantedRoles,
      tradeLevels,
      resumes,
      account,
      recentApplications,
    ] = await Promise.all([
      this.identity.resolve(admin, "workers", [workerId], workerId, ctx),
      this.workers.latestProfile(workerId),
      this.repo.currentJobDomain(workerId),
      this.attributes.loadTradeSheet(workerId),
      this.repo.attributeProvenance(workerId),
      this.qualifications.loadForResume(workerId),
      this.languages.loadForResume(workerId),
      this.occupations.loadForWorker(workerId),
      this.repo.employment(workerId),
      this.repo.matchSkills(workerId),
      this.repo.industryTenure(workerId),
      this.candidateSearch.findCardRow(workerId),
      this.candidateSearch.listWantedRoles([workerId]),
      this.workerSkills.listStatedTradeLevels([workerId]),
      this.repo.resumeVersions(workerId, ADMIN_CANDIDATE_RESUME_VERSIONS_MAX),
      this.repo.account(workerId),
      this.entities.listApplications(
        { workerId, action: "applied" },
        null,
        ADMIN_CANDIDATE_RECENT_APPLICATIONS,
      ),
    ]);

    const corrections = this.effectiveFacts
      ? await this.effectiveFacts.liveFor(workerId)
      : [];
    const detail = toCandidateDetail({
      workerId,
      corrections,
      core,
      name:
        names === null
          ? { disclosed: false, value: null }
          : { disclosed: true, value: names.get(workerId) ?? null },
      profile,
      jobDomain,
      tradeSheet,
      provenance,
      qualifications,
      languages,
      occupations,
      employment,
      matchSkills,
      tenure,
      card: { row: cardRow, wantedRoles, tradeLevels },
      resumes,
      account,
      recentApplications,
    });
    // The contract is the boundary: anything it does not name fails closed here.
    return AdminCandidateDetailSchema.parse(detail);
  }

  /**
   * Record that `adminId` opened `workerId`'s record. AWAITED; a failure PROPAGATES. The payload
   * is the two opaque ids and nothing else (`.strict()` on the schema); the ACTOR is the session
   * admin the guard resolved, the SUBJECT the worker from the validated path.
   */
  private async auditView(adminId: string, workerId: string, ctx: RequestContext): Promise<void> {
    await this.events.emit({
      event_name: "admin.candidate_viewed",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: {
        admin_id: adminId,
        worker_id: workerId,
      } satisfies PayloadInputOf<"admin.candidate_viewed">,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }
}
