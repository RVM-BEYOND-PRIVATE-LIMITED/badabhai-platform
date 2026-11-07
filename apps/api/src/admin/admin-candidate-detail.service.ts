import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { Database, WorkerAdminOverrideFactKey } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { DATABASE } from "../database/database.module";
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
import { can } from "./admin-capabilities";
import { AdminEntitiesRepository } from "./admin-entities.repository";
import { AdminIdentityService } from "./admin-identity.service";
import { AdminCandidateDetailRepository } from "./admin-candidate-detail.repository";
import { AdminCorrectionFactsService } from "./corrections/admin-correction-facts.service";
import { toCandidateDetail } from "./admin-candidate-detail.mapper";
import {
  ADMIN_CANDIDATE_RECENT_APPLICATIONS,
  ADMIN_CANDIDATE_RESUME_VERSIONS_MAX,
  AdminCandidateDetailSchema,
  type AdminCandidateDetail,
  type EffectiveCandidateCorrectionValues,
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
 *     For an `edit_candidates` holder, one more member of that wave loads the eight structured
 *     facts through `AdminCorrectionFactsService.readPrevious` — the correction prefill, and the
 *     deliberate capability-gated decrypt site described in the DTO header.
 *  5. The pure mapper, then a `.strict()` parse of the whole response: a field the contract does
 *     not name fails the request closed rather than leaving.
 *
 * ANY READ FAILURE PROPAGATES (a 5xx) — never a partial record. The one exception is a worker
 * with no profile yet: there are no skills to prefill, so that read answers `[]` rather than
 * refusing the record for the very role allowed to correct it.
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
    // #2728 — the correction prefill. `readPrevious` supplies each structured fact's stored value
    // (and decrypts the employer name / licence number for it), and `liveFor` above supplies the
    // live override the mapper overlays. Both are optional so a hand-built service still serves
    // the record; when either is absent an editor gets `correction_values: null`.
    @Optional() @Inject(DATABASE) private readonly db?: Database,
    @Optional() private readonly correctionFacts?: AdminCorrectionFactsService,
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

    // #2728 — the correction prefill is a capability-gated decrypt site. An analyst (or any role
    // without `edit_candidates`) never triggers those reads, and gets `null` below.
    const wantsCorrectionValues =
      can(admin.role, "edit_candidates") &&
      this.correctionFacts !== undefined &&
      this.db !== undefined;

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
      correctionValues,
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
      // The eight structured facts, read in ONE parallel wave beside the record (never per row).
      wantsCorrectionValues ? this.loadCorrectionValues(workerId) : Promise.resolve(null),
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
      correctionValues,
    });
    // The contract is the boundary: anything it does not name fails closed here.
    return AdminCandidateDetailSchema.parse(detail);
  }

  /**
   * #2728 — the eight structured facts' STORED values, in the correction API's own shapes.
   *
   * Every read reuses {@link AdminCorrectionFactsService.readPrevious}, which is also what a
   * correction write stores as `previous`: it decrypts the employer name and the certificate
   * licence number, and it is the ONE place that knows each fact's stored shape. This is the
   * deliberate `edit_candidates`-gated decrypt site described at the top of the DTO.
   *
   * ALL EIGHT RUN IN PARALLEL. Each is a fixed read of the worker's own rows/tables; none of them
   * loops over a list to issue another statement.
   */
  private async loadCorrectionValues(
    workerId: string,
  ): Promise<EffectiveCandidateCorrectionValues> {
    const read = (factKey: WorkerAdminOverrideFactKey) => this.correctionFact(workerId, factKey);
    const [
      skills,
      work_history,
      education,
      certifications,
      training,
      languages,
      work_types,
      documents_ready,
    ] = await Promise.all([
      // A worker with no profile yet has no skills to prefill. That is an empty value, not a
      // reason to refuse the whole record for the only role allowed to correct it.
      read("skills").catch((error: unknown) => {
        if (error instanceof BadRequestException) return [];
        throw error;
      }),
      read("work_history"),
      read("education"),
      read("certifications"),
      read("training"),
      read("languages"),
      read("work_types"),
      read("documents_ready"),
    ]);
    return {
      skills,
      work_history,
      education,
      certifications,
      training,
      languages,
      work_types,
      documents_ready,
    } as EffectiveCandidateCorrectionValues;
  }

  /** The cross-transaction read seam, kept in one place so the static allow-list can see it. */
  private correctionFact(workerId: string, factKey: WorkerAdminOverrideFactKey): Promise<unknown> {
    if (this.correctionFacts === undefined || this.db === undefined) {
      return Promise.reject(new Error("correction prefill is not configured"));
    }
    return this.correctionFacts.readPrevious(this.db, workerId, factKey);
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
