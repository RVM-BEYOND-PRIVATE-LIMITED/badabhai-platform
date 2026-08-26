import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  MACHINE_WRITABLE_STATUSES,
  TERMINAL_STATUSES,
  assertProvenanceIntact,
  candidateAliasTexts,
  canTransition,
  reviewTierFrom,
  statusForDecision,
  validateCandidate,
} from "@badabhai/db";
import type {
  CandidateMatch,
  CandidateProblemCode,
  CandidateSource,
  ClassifierRule,
  Database,
  MatchRelation,
  PhraseClass,
  SkillCandidateRecord,
  SkillCandidateSourceType,
  SkillCandidateStatus,
} from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { ADMIN_ACTION_CODES, type AdminActionCode } from "./admin-actions.service";
import type { AdminCountBucket } from "./admin-dashboard.dto";
import { decodeEntityCursor, encodeEntityCursor } from "./admin-entities.cursor";
import { AdminSkillDiscoveryRepository } from "./admin-skill-discovery.repository";
import type {
  AdminSkillCandidateDetailRow,
  AdminSkillCandidateMatchFacts,
  AdminSkillDiscoveryFilter,
  AdminSkillDiscoveryQueueRow,
  AdminSkillPhraseClassTierFacts,
} from "./admin-skill-discovery.repository";
import {
  SKILL_CANDIDATE_ACTIONS,
  SKILL_CANDIDATE_CONFIDENCE_BANDS,
  SKILL_CANDIDATE_SOURCE_TYPES,
  SKILL_CANDIDATE_STATUSES,
  SKILL_DECISION_EFFECT_RECORDED_ONLY,
  SKILL_DECISION_NEXT_STEP_OFFLINE_CORPUS_CHAIN,
  SKILL_DECISION_TO_LIBRARY_DECISION,
  SKILL_MATCH_RELATION_LABELS,
  SKILL_MATCH_STRENGTH_LABELS,
  SKILL_PHRASE_CLASS_LABELS,
  SKILL_TIER_DERIVED_NOT_STORED,
  SkillCorpusSkillId,
} from "./admin-skill-discovery.dto";
import type {
  AdminSkillCandidateMatchRow,
  AdminSkillCandidateProvenance,
  AdminSkillCandidateSource,
  AdminSkillCandidateTierFacts,
  AdminSkillDecisionConflict,
  AdminSkillDecisionConflictBody,
  AdminSkillDecisionDto,
  AdminSkillDecisionResult,
  AdminSkillDiscoveryDetail,
  AdminSkillDiscoveryListItem,
  AdminSkillDiscoveryMetrics,
  AdminSkillDiscoveryMetricsQueryDto,
  AdminSkillDiscoveryPage,
  AdminSkillDiscoveryQueryDto,
  AdminSkillDiscoveryRow,
  AdminSkillMatchRelation,
  AdminSkillMatchStrength,
  AdminSkillPhraseClass,
  AdminSkillRelatedSkill,
  AdminSkillReviewTier,
  AdminSkillSourceTypeBuckets,
} from "./admin-skill-discovery.dto";

/**
 * The admin SKILL DISCOVERY REVIEW surface's business logic: three faceless reads over what a
 * discovery run found (migration 0093), and THE ONE WRITE — a named human's recorded decision.
 *
 * ── WHAT THIS SERVICE DOES NOT DO, AND CANNOT ───────────────────────────────────────────
 * IT DOES NOT WRITE THE TAXONOMY. No path through this file creates a `skill`, a `skill_alias`
 * or a `job_domain_skill` row, and that is STRUCTURAL rather than promised: its only database
 * collaborator is {@link AdminSkillDiscoveryRepository}, whose entire write surface is
 * `advanceToNeedsReview` and `recordDecision` — two guarded UPDATEs against ONE table,
 * `skill_candidate`. There is no other method to call. An `approved_create` decision RECORDS
 * that a human said yes and stops; the corpus write stays in the offline guarded chain that
 * already has a human in it:
 *
 *     approvedCandidateToCorpusSkill  (packages/db/src/skill-discovery-candidate.ts:542)
 *       -> validateTaxonomyCorpus     (structural)
 *       -> taxonomyQualityVerdict     (semantic)
 *       -> a human commit
 *       -> db:seed:domain-skills      (seeds as provisional)
 *       -> db:promote:skills          (C1..C5, RESOLVABLE_ABOVE_FLOOR, NO_REGRESSION,
 *                                      EVAL_COVERED, MATCH_VOCABULARY)
 *
 * That is why a `create` decision writes NO `resulting_skill_id` — the column stays NULL until
 * that chain actually mints the skill and somebody backfills it, which is what makes it the
 * honest answer to "did this approval ever ship?". Filling it in at decision time would convert
 * an honest answer into a lie in the one place nobody re-reads. `approved_job_domain_ids` is the
 * same promise kept honestly: the reviewer's judgement RECORDED on the candidate row, never an
 * edge written into the corpus. And the RESULT says so out loud, in literal types a client
 * cannot widen — `corpus_effect` and `next_step`.
 *
 * ── WHY THE BUSINESS LOGIC IS HERE AND NOT IN THE REPOSITORY OR THE CONTROLLER ──────────
 * The controller is HTTP (CLAUDE.md §4) and the repository is database access. What is left is
 * the DECISION LADDER: which transitions are legal, what a decision must name, which target ids
 * are refusable, when a re-submit is a retry and when it is a disagreement, and the fact that the
 * SoR write and its audit event commit together or not at all. Every one of those is a rule THE
 * DATABASE DOES NOT ENFORCE. Migration 0093 puts eleven CHECK constraints on `skill_candidate`
 * and not one of them stops an `approved_map` row being UPDATEd back to `needs_review`;
 * `canTransition` is the only thing that does, which makes this service the enforcement point
 * rather than a convenience wrapper over one.
 *
 * ── THE SEVEN INVARIANTS THIS FILE IS ACCOUNTABLE FOR ──────────────────────────────────
 *   1. NO CORPUS WRITE. See above.
 *   2. THE MATCH-SKILL WALL. `mskill_*` is a closed, 18-member, CEO-ratified vocabulary the
 *      deterministic match engine consumes; nothing discovered may ever join it. Refused here
 *      twice: by re-running {@link SkillCorpusSkillId} (prefix + skill_mskill_ + `MATCH_SKILLS`
 *      membership) on the body value, and by refusing a target whose `skill.kind` is
 *      `match_skill` — the check that still catches a match skill renamed out of the prefix
 *      convention and out of the `MATCH_SKILLS` list.
 *   3. NO NUMBER MOVES A STATUS. No threshold, score, band or confidence is read on the decision
 *      path. The only inputs to a status change are the row's current status and one decision
 *      word, and the status itself is `statusForDecision`'s answer, never ours. The similarity
 *      SCORE is read by the repository and dropped by the projection here: it never reaches a
 *      response, because a 0..1 number on a review screen is a de-facto approval floor with no
 *      owner behind it.
 *   4. A DECISION NAMES THE HUMAN, THE MOMENT AND THE REASON — all three, in the one guarded
 *      UPDATE, or `skill_candidate_reviewed_chk` refuses the row. The reviewer is the session
 *      admin id the controller passes and the moment is the server clock; neither is in the body,
 *      because an actor a caller can type is not an actor.
 *   5. TERMINAL MEANS TERMINAL. Turned into a 409 here rather than a silent no-op.
 *   6. PROVENANCE IS FROZEN. The record is assembled before and after the write INSIDE the
 *      transaction and `assertProvenanceIntact` must come back empty, or the transaction rolls
 *      back. The stored `provenance_digest` is NEVER recomputed to make a mismatch go away —
 *      that launders the exact lineage lie the digest exists to expose.
 *   7. IDEMPOTENCY WITHOUT AUTHORSHIP THEFT. A retry of the same decision is a `changed:false`
 *      success that does not overwrite the first reviewer's id, timestamp or reason. A DIFFERENT
 *      decision on a decided row is a 409: that is a disagreement between two humans, and
 *      resolving one is not this route's job.
 *
 * ── ATOMICITY (the H3 shape, copied deliberately) ──────────────────────────────────────
 * The SoR UPDATE(s) and the single `admin.action_performed` emit run inside ONE
 * `withTransaction`, and the emit is handed the SAME `tx` — `events` and `skill_candidate` are
 * the same Postgres database, so an emit failure rolls the decision back. Forgetting to pass
 * `tx` compiles, passes unit tests, and writes the event on a separate connection that survives
 * the rollback (events.service.ts:36, events.repository.ts:38); that is the exact failure
 * admin-actions.atomicity.test.ts exists for, and the sibling test pins it here by asserting the
 * emit received the same token the transaction handed out.
 *
 * ── THE READS EMIT NOTHING, AND THAT IS A RULING RATHER THAN AN OVERSIGHT ──────────────
 * `admin.feedback_viewed` exists because a feedback row is one worker's free text and reading it
 * is a DISCLOSURE about a person. A candidate is a normalized vocabulary phrase plus counts, and
 * the disclosure argument cannot be made here even for `original_text`: NONE of the four tables
 * in migration 0093 has a `worker_id` column (deliberately — this must never become a per-worker
 * DSAR surface), `worker_phrase` text is contractually pseudonymized upstream, and the
 * classifier's FORBIDDEN_CHARS check runs FIRST and refuses any phrase carrying a digit, an @
 * or a URL. There is no subject axis on which a "viewed" event could be true, and an event whose
 * subject is invented is worse than no event: it makes a spine query look complete when it is
 * not. A read is not a state change (admin-entities.service.ts:42-45).
 */

/**
 * Decision -> audited action CODE, keyed by the STATUS the decision produces.
 *
 * THE CODES ARE NAMED FOR THE STATUS, NOT THE BUTTON (`alias` -> `skill_candidate_approved_map`).
 * That is `ADMIN_ACTION_CODES`' own choice and it is worth keeping: the code is then a total
 * function of `statusForDecision`, so an auditor reconciling the spine against a
 * `skill_candidate` row needs no translation table and a mismatch between the two is visible
 * rather than arguable. The sibling test asserts exactly that — every code equals
 * `skill_candidate_` + the status — so the pair cannot drift apart silently.
 *
 * FIVE CODES AND NOT ONE, because the spine is VALUE-FREE: which way a reviewer decided IS the
 * value, and `action_code` is the only free-form string an `admin.action_performed` carries.
 * Collapsing them would either lose the decision from the audit trail or smuggle it back as a
 * payload key that `.strict()` rejects.
 *
 * TYPED OVER THE WHOLE STATUS UNION rather than as a `Partial`: the two MACHINE-writable statuses
 * map to `null` because no human decision produces them, and spelling that out is what makes the
 * unreachability a CHECKED claim instead of a comment — a seventh status added to the ladder
 * fails this object rather than falling through it.
 */
const SKILL_DECISION_ACTION_CODE: Readonly<Record<SkillCandidateStatus, AdminActionCode | null>> = {
  approved_create: ADMIN_ACTION_CODES.skill_candidate_approved_create,
  approved_map: ADMIN_ACTION_CODES.skill_candidate_approved_map,
  approved_merge: ADMIN_ACTION_CODES.skill_candidate_approved_merge,
  rejected: ADMIN_ACTION_CODES.skill_candidate_rejected,
  deferred: ADMIN_ACTION_CODES.skill_candidate_deferred,
  pending: null,
  needs_review: null,
};

/**
 * The event subject. `skill_candidate` is a REGISTERED subject type
 * (packages/event-schema/src/enums.ts) — without that entry the emit fails at
 * `stage:"envelope"` inside `createEvent`, before any insert and INSIDE the transaction, which
 * rolls the decision back. That is why the sibling test rebuilds the captured event through the
 * real `createEvent` instead of trusting the shape.
 *
 * The subject is the CANDIDATE, not the admin's session: pivoting the spine on the reviewer
 * answers "what did this admin do" but not "what happened to this candidate", and the second
 * question is the one a taxonomy decision has to survive being asked years later.
 */
const SKILL_CANDIDATE_SUBJECT_TYPE = "skill_candidate" as const;

/** The two statuses the queue calls "awaiting a decision" — `MACHINE_WRITABLE_STATUSES`, exactly. */
const AWAITING_STATUSES: readonly SkillCandidateStatus[] = MACHINE_WRITABLE_STATUSES;

/** Human sentences for the three conflict codes. See {@link AdminSkillDiscoveryService.conflict}. */
const CONFLICT_MESSAGES: Readonly<Record<AdminSkillDecisionConflict, string>> = {
  stale_expected_status:
    "This candidate moved since you loaded it. Reload it and look again — the other decision may be the right one.",
  already_decided:
    "This candidate already carries a decision. A decision is recorded against a specific corpus fingerprint and cannot be re-scoped; re-deciding means a new candidate in a new run.",
  illegal_transition:
    "That decision is not reachable from this candidate's current status. See canTransition in packages/db/src/skill-discovery-candidate.ts.",
};

/**
 * The `validateCandidate` problem codes a DECISION BODY can cause, and which therefore earn a
 * 400 rather than a 500 when the post-write validation finds one.
 *
 * The split matters because both branches roll the transaction back and the caller has to know
 * whether to fix their request or page somebody. `PROPOSED_LABEL_IS_MATCH_SKILL` is a label the
 * reviewer typed that canonicalizes onto the closed match vocabulary — the one wall check that
 * needs `taxonomySkillIdFor` and so cannot live in the DTO — while a `PROVENANCE_DIGEST_MISMATCH`
 * appearing after our own UPDATE is our bug, not theirs.
 */
const BODY_CAUSED_PROBLEMS: ReadonlySet<CandidateProblemCode> = new Set<CandidateProblemCode>([
  "PROPOSED_LABEL_IS_MATCH_SKILL",
  "RESULTING_IS_MATCH_SKILL",
  "CREATE_WITHOUT_LABEL",
  "RESOLUTION_WITHOUT_SKILL",
]);

/** `deferred` is deliberately NOT terminal — a held candidate is re-openable. */
function isTerminal(status: SkillCandidateStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

@Injectable()
export class AdminSkillDiscoveryService {
  private readonly logger = new Logger(AdminSkillDiscoveryService.name);

  constructor(
    private readonly repo: AdminSkillDiscoveryRepository,
    private readonly events: EventsService,
  ) {}

  // ═════════════════════════════════════════════════════════════════════════════════════
  // GET /admin/skill-discovery — the queue
  // ═════════════════════════════════════════════════════════════════════════════════════

  /**
   * One keyset page of the review queue, plus the three DERIVED fields the repository is
   * deliberately unable to return.
   *
   * OVER-FETCH BY ONE. `limit + 1` goes to the repository so `nextCursor` is honest; deriving
   * "there is more" from `rows.length === limit` invents a phantom page on every exact multiple.
   *
   * THE MATCH FACTS ARE FETCHED FOR THE PAGE, NOT FOR THE PEEK. The peeked row is sliced off
   * before the second query, so this surface never does work for a row the caller will not see
   * (the same rule that keeps name resolution off the peeked row, admin-entities.service.ts:47-49).
   *
   * A CANDIDATE WITH NO MATCHES PRODUCES NO FACT ROW. That is the common case — most phrases
   * compete with nothing — so an absent entry MUST read as `{has_strong_match:false, count:0}`.
   * Treating it as missing data would make "nothing looks like this phrase" indistinguishable
   * from "we failed to ask".
   */
  async list(dto: AdminSkillDiscoveryQueryDto): Promise<AdminSkillDiscoveryPage> {
    // A malformed or tampered cursor decodes to null and is served as the FIRST page, never as a
    // 500 and never as a 400: the token is opaque, so a caller cannot be asked to fix one
    // (admin-entities.cursor.ts:32-36).
    const cursor = decodeEntityCursor(dto.cursor);
    const rows = await this.repo.list(
      AdminSkillDiscoveryService.filterFor(dto),
      dto.sort,
      cursor,
      dto.limit + 1,
    );
    const page = AdminSkillDiscoveryService.page(rows, dto.limit);
    const facts = await this.repo.matchFactsFor(page.items.map((r) => r.row.id));
    const byId = new Map<string, AdminSkillCandidateMatchFacts>(
      facts.map((f) => [f.candidate_id, f]),
    );
    return {
      items: page.items.map((queueRow) =>
        AdminSkillDiscoveryService.listItem(queueRow.row, byId.get(queueRow.row.id)),
      ),
      nextCursor: page.nextCursor,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // GET /admin/skill-discovery/:id — one candidate, in full
  // ═════════════════════════════════════════════════════════════════════════════════════

  /**
   * ONE CANDIDATE, ASSEMBLED — the review screen.
   *
   * The two child reads are issued together because they are independent projections of one
   * aggregate; there is no cross-read invariant to protect, and a detail screen costing three
   * sequential round trips is the kind of latency somebody eventually "fixes" with a cache.
   *
   * The assembled `SkillCandidateRecord` is what makes the packages/db safety layer usable from
   * here — `reviewTier`, `approvedCandidateToCorpusSkill` for the alias preview, and (on the
   * decision path) `validateCandidate` and `assertProvenanceIntact` — instead of restated in this
   * file.
   */
  async detail(candidateId: string): Promise<AdminSkillDiscoveryDetail> {
    const row = await this.repo.findCandidate(candidateId);
    if (!row) throw new NotFoundException("Skill candidate not found");
    const [sources, matches] = await Promise.all([
      this.repo.listSources(candidateId),
      this.repo.listMatches(candidateId),
    ]);
    return AdminSkillDiscoveryService.detailOf(row, sources, matches);
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // GET /admin/skill-discovery/metrics — the tiles
  // ═════════════════════════════════════════════════════════════════════════════════════

  /**
   * THE QUEUE'S TILES. Densified here rather than in SQL, because a `GROUP BY` cannot emit a
   * bucket for a value that has no rows — and an absent bucket and a zero bucket are the same
   * JSON with different meanings to a reader (admin-dashboard.dto.ts:482-487).
   *
   * NO `other` BUCKET, which is a deliberate departure from the dashboard: `status`,
   * `confidence_band` and `proposed_action` are ALL CHECK-backed here, so an `other` row could
   * never be non-zero, and a permanently-zero bucket that looks like a corruption detector is
   * worse than no detector because it will be trusted.
   *
   * `total` IS SUMMED FROM `by_status` so the headline cannot disagree with its own breakdown,
   * and `by_tier` goes through the SAME `reviewTier` the row-level derivation uses.
   */
  async metrics(dto: AdminSkillDiscoveryMetricsQueryDto): Promise<AdminSkillDiscoveryMetrics> {
    const facts = await this.repo.metricFacts({
      ...(dto.runId !== undefined ? { runId: dto.runId } : {}),
      awaitingStatuses: AWAITING_STATUSES,
    });
    const byStatus = AdminSkillDiscoveryService.densify(SKILL_CANDIDATE_STATUSES, facts.by_status);
    const countOf = (status: SkillCandidateStatus): number =>
      byStatus.find((b) => b.key === status)?.count ?? 0;
    return {
      run_id: dto.runId ?? null,
      total: byStatus.reduce((sum, b) => sum + b.count, 0),
      awaiting_decision: AWAITING_STATUSES.reduce((sum, s) => sum + countOf(s), 0),
      // Its own tile, never folded into `awaiting_decision`: "somebody looked and could not
      // decide" is a different fact from "nobody has opened it", and merging the two is how "we
      // have 400 to review" becomes unfalsifiable.
      deferred: countOf("deferred"),
      by_status: byStatus,
      by_band: AdminSkillDiscoveryService.densify(SKILL_CANDIDATE_CONFIDENCE_BANDS, facts.by_band),
      by_proposed_action: AdminSkillDiscoveryService.densify(
        SKILL_CANDIDATE_ACTIONS,
        facts.by_proposed_action,
      ),
      by_tier: AdminSkillDiscoveryService.tierBuckets(facts.by_phrase_class),
      oldest_awaiting_created_at: facts.oldest_awaiting_created_at,
      tier_basis: SKILL_TIER_DERIVED_NOT_STORED,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // POST /admin/skill-discovery/:id/decision — the one write
  // ═════════════════════════════════════════════════════════════════════════════════════

  /**
   * RECORD A HUMAN DECISION about one discovered candidate.
   *
   * THE ORDER OF THE CHECKS BELOW IS LOAD-BEARING, and one pair of them is a bug waiting to be
   * reintroduced by anyone who "tidies" this method:
   *
   *   1. the reason, and the target id     — pure, free, and a 400 the caller can fix
   *   2. does the candidate exist          — 404 before anything else
   *   3. IS THIS THE SAME DECISION AGAIN   — before the `expected_status` comparison
   *   4. is the row already decided        — 409, terminal means terminal
   *   5. is `expected_status` still true   — 409, somebody else moved it
   *   6. is the transition legal           — 409, `canTransition` is the only enforcement
   *   7. does the mapping target exist, live and outside the match vocabulary — 400
   *   8. then, and only then, a transaction
   *
   * WHY 3 MUST PRECEDE 5. A retried request carries the SAME `expected_status` it was built
   * with — which the first, successful attempt has by definition made stale. Comparing
   * `expected_status` first would answer every network-level retry with a 409
   * `stale_expected_status`: it would tell a reviewer their decision failed at the exact moment
   * it had succeeded, and the natural recovery (reload, decide again) is then blocked by the
   * terminal rule. Asking "is the row already exactly what I asked for" first turns that into the
   * `changed:false` no-op it actually is.
   *
   * NOTHING HERE READS A SCORE, A BAND OR A CONFIDENCE.
   */
  async decide(
    adminId: string,
    candidateId: string,
    dto: AdminSkillDecisionDto,
    ctx: RequestContext,
  ): Promise<AdminSkillDecisionResult> {
    // ── 1. the reason ───────────────────────────────────────────────────────────────────
    // The pipe already enforces a 12-character floor, and this is not distrust of the pipe: it is
    // the invariant restated where it is enforced. `skill_candidate_reviewed_chk` accepts an
    // empty string (it only demands NOT NULL) while `validateCandidate` calls the same row
    // DECISION_WITHOUT_REVIEWER — so a blank reason produces a row the database keeps and the
    // corpus layer refuses, discovered weeks later with nobody left to ask. A future internal
    // caller that never installs a ZodValidationPipe must still hit this.
    const reviewReason = dto.review_reason.trim();
    if (reviewReason.length === 0) {
      throw new BadRequestException(
        "A decision must record WHY. A blank reason is not a decision — see DECISION_WITHOUT_REVIEWER.",
      );
    }

    const nextStatus = statusForDecision(SKILL_DECISION_TO_LIBRARY_DECISION[dto.decision]);

    // ── 1b. the match-skill wall, at the earliest possible point ────────────────────────
    // Re-running the DTO's own schema rather than restating its three refusals: ONE definition of
    // "this id may not be a match skill", exercised whether or not the caller came through the
    // pipe, and refused before a transaction is opened. A CHECK violation would instead arrive as
    // a 500 naming a constraint, mid-decision.
    const targetSkillId =
      dto.decision === "alias" || dto.decision === "merge"
        ? AdminSkillDiscoveryService.assertCorpusSkillId(dto.resulting_skill_id)
        : undefined;

    // ── 2. the row ─────────────────────────────────────────────────────────────────────
    const state = await this.repo.findStatus(candidateId);
    if (!state) throw new NotFoundException("Skill candidate not found");

    // ── 3. the same decision again ─────────────────────────────────────────────────────
    if (state.status === nextStatus) {
      // A mapping resubmitted onto a DIFFERENT skill is not a retry, it is a second opinion about
      // the same phrase. The wider read happens only on this rare branch.
      if (targetSkillId !== undefined) {
        const decided = await this.repo.findCandidate(candidateId);
        if (decided && decided.resulting_skill_id !== targetSkillId) {
          throw AdminSkillDiscoveryService.conflict(
            candidateId,
            "already_decided",
            state.status,
            dto.expected_status,
          );
        }
      }
      // No write, no event, and — the point — no touch of `reviewer_admin_id`, `reviewed_at` or
      // `review_reason`. A retry must never silently reassign authorship of a decision.
      return AdminSkillDiscoveryService.result(
        candidateId,
        false,
        state.status,
        isTerminal(state.status),
      );
    }

    // ── 4. terminal means terminal ─────────────────────────────────────────────────────
    // Answered here rather than left to `canTransition` so the caller learns WHY: the decision on
    // this row was recorded against a specific `corpus_fingerprint`, and re-opening it in place
    // would silently re-scope it to a corpus the human never saw.
    if (isTerminal(state.status)) {
      throw AdminSkillDiscoveryService.conflict(
        candidateId,
        "already_decided",
        state.status,
        dto.expected_status,
      );
    }

    // ── 5. optimistic concurrency ──────────────────────────────────────────────────────
    // `status` is a COMPLETE token for this ladder: every legal transition changes it and there
    // is no legal self-transition, so "the status the reviewer was looking at" is enough to
    // detect that somebody moved first. An `updated_at`/ETag token is a measured trap on this
    // stack — Postgres keeps microseconds, `Date` keeps milliseconds (migration 0083, reproduced
    // at admin-keyset-params.test.ts:227-257), so it would either never match or match by luck.
    if (state.status !== dto.expected_status) {
      throw AdminSkillDiscoveryService.conflict(
        candidateId,
        "stale_expected_status",
        state.status,
        dto.expected_status,
      );
    }

    // ── 6. the ladder, BEFORE any write ────────────────────────────────────────────────
    const path = AdminSkillDiscoveryService.transitionPath(state.status, nextStatus);
    if (path === null) {
      throw AdminSkillDiscoveryService.conflict(
        candidateId,
        "illegal_transition",
        state.status,
        dto.expected_status,
      );
    }

    // ── 7. the mapping target ──────────────────────────────────────────────────────────
    if (targetSkillId !== undefined) await this.assertMappableTarget(targetSkillId);

    // ── 8. the transaction ─────────────────────────────────────────────────────────────
    const write = AdminSkillDiscoveryService.writeFor(
      candidateId,
      dto,
      nextStatus,
      adminId,
      reviewReason,
      targetSkillId,
    );

    let changed = false;
    let finalStatus: SkillCandidateStatus = state.status;
    let alreadyDecided = false;

    await this.repo.withTransaction(async (tx) => {
      // The BEFORE snapshot for the provenance assertion, assembled ON THE TRANSACTION so it is
      // the same row the UPDATE is about to touch.
      const before = await this.record(candidateId, tx);
      if (!before) {
        // Deleted between step 2 and here (0093 cascades on the RUN, so this needs a run
        // deletion). Nothing was written; say so rather than inventing a status.
        throw new NotFoundException("Skill candidate not found");
      }

      // The pending -> needs_review -> deferred two-step. Both rungs were checked against
      // `canTransition` in `transitionPath`; running them here means they commit or roll back
      // together, so the row is never observably parked on the intermediate rung — and the first
      // rung must carry NO reviewer, because `skill_candidate_machine_status_chk` forbids one on
      // `needs_review`.
      let expectedStatus = write.expectedStatus;
      if (path.length === 2) {
        const bounced = await this.repo.advanceToNeedsReview(candidateId, tx);
        if (!bounced) {
          await this.settleLostRace(candidateId, dto, nextStatus, targetSkillId, tx);
          alreadyDecided = isTerminal(nextStatus);
          finalStatus = nextStatus;
          return;
        }
        expectedStatus = "needs_review";
      }

      const decided = await this.repo.recordDecision({ ...write, expectedStatus }, tx);
      if (!decided) {
        await this.settleLostRace(candidateId, dto, nextStatus, targetSkillId, tx);
        alreadyDecided = isTerminal(nextStatus);
        finalStatus = nextStatus;
        return;
      }

      // ── the frozen fields ───────────────────────────────────────────────────────────
      const after = await this.record(candidateId, tx);
      if (!after) {
        throw new InternalServerErrorException("The decided candidate could not be re-read");
      }
      const moved = assertProvenanceIntact(before, after);
      if (moved.length > 0) {
        // Throwing rolls the decision back. The alternative — recomputing the digest so the row
        // "validates" — is the one thing that must never happen: it launders the lineage lie the
        // digest exists to expose. Field NAMES are safe to log; no value is.
        this.logger.error(
          `Decision on candidate ${candidateId} moved frozen provenance fields: ${moved.join(", ")}. Rolled back.`,
        );
        throw new InternalServerErrorException(
          `A decision may never move provenance. Refused and rolled back (${moved.join(", ")}).`,
        );
      }

      // ── the corpus layer's own post-condition ──────────────────────────────────────
      // Only NEWLY introduced problem CODES are refused. A row the pipeline wrote with, say, a
      // SOURCE_COUNT_MISMATCH is not this reviewer's fault, and blocking their decision on it
      // would make a bad run un-reviewable. Introducing a problem is the opposite: the row we
      // just wrote is one the offline chain will refuse, and a rolled-back request now beats an
      // approval that dies silently in `db:promote:skills` weeks later. This is also where
      // PROPOSED_LABEL_IS_MATCH_SKILL is caught — the one wall check that needs
      // `taxonomySkillIdFor` and therefore cannot live in the DTO.
      const introduced = AdminSkillDiscoveryService.introducedProblems(before, after);
      if (introduced.length > 0) {
        const codes = introduced.join(", ");
        if (introduced.some((code) => BODY_CAUSED_PROBLEMS.has(code))) {
          throw new BadRequestException(
            `This decision would produce a candidate the corpus layer refuses (${codes}).`,
          );
        }
        this.logger.error(`Decision on candidate ${candidateId} introduced ${codes}. Rolled back.`);
        throw new InternalServerErrorException(
          `This decision would produce a candidate the corpus layer refuses (${codes}).`,
        );
      }

      changed = true;
      // The row's own answer, never ours.
      finalStatus = decided.status;

      await this.emitDecision(adminId, candidateId, decided.status, ctx, tx);
    });

    return AdminSkillDiscoveryService.result(candidateId, changed, finalStatus, alreadyDecided);
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // Decision helpers
  // ═════════════════════════════════════════════════════════════════════════════════════

  /**
   * Re-run the DTO's corpus-id schema and turn a failure into a 400 that names the wall.
   *
   * Its three refusals are three different guarantees and all three are kept: the mskill_ PREFIX
   * mirrors `skill_candidate_not_match_skill_chk`; membership of `MATCH_SKILLS` mirrors what
   * `validateCandidate` tests (RESULTING_IS_MATCH_SKILL) and would still catch a match skill
   * renamed out of the prefix convention; and skill_mskill_ is the shape `taxonomySkillIdFor`
   * produces from a match-skill LABEL.
   */
  private static assertCorpusSkillId(value: string): string {
    const parsed = SkillCorpusSkillId.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? "That is not a usable corpus skill id.",
      );
    }
    return parsed.data;
  }

  /**
   * The mapping target must EXIST, be LIVE, and be outside the match vocabulary.
   *
   * All three are 400s and not 404s: the resource this route addresses is the CANDIDATE (which
   * exists, or step 2 would have answered), so a bad target is a value in the body.
   *
   *   * MISSING — the FK would catch it, but only from inside an open transaction, and a
   *     well-formed id for a skill that does not exist then reads as a constraint name rather
   *     than a fix. `skill_id` is a `text` PK, so no shape rule can catch this one.
   *   * DEPRECATED — a withdrawn skill is one the pickers no longer offer. Aliasing a live phrase
   *     onto it hides the phrase behind a concept the taxonomy has already retired, and
   *     `db:promote:skills`' NO_REGRESSION gate is not looking for that.
   *   * `kind === "match_skill"` — THE FOURTH AND LAST WALL, and the only one that still holds if
   *     a match skill is renamed out of the mskill_ prefix AND out of `MATCH_SKILLS`. `kind` is
   *     the fact the prefix is only a proxy for.
   */
  private async assertMappableTarget(skillId: string): Promise<void> {
    const skill = await this.repo.findCorpusSkill(skillId);
    if (!skill) {
      throw new BadRequestException(
        "That mapping target is not a skill in the corpus. Pick one of the candidate's related skills.",
      );
    }
    if (skill.status === "deprecated") {
      throw new BadRequestException(
        "That skill is deprecated. Mapping a live phrase onto a withdrawn concept hides the phrase.",
      );
    }
    if (skill.kind === "match_skill") {
      throw new BadRequestException(
        "That skill belongs to the closed match vocabulary (kind=match_skill), which nothing discovered may join.",
      );
    }
  }

  /**
   * The rungs this decision has to climb, or `null` when there is no legal route.
   *
   * `canTransition` IS THE ONLY ENFORCEMENT of the ladder — no CHECK in migration 0093 stops
   * `approved_map -> needs_review` — so this is the single place a status change is authorised.
   *
   * THE ONE COMPOSITE, and only this one: a hold on a `pending` candidate. Both rungs are checked
   * against `canTransition`, so the composite is not a shortcut around it. Every other
   * unreachable move stays unreachable, because a general "find me any path" would quietly turn
   * pending -> approved_map — which skips the human-review rung entirely — into a legal decision.
   */
  private static transitionPath(
    from: SkillCandidateStatus,
    to: SkillCandidateStatus,
  ): SkillCandidateStatus[] | null {
    if (canTransition(from, to)) return [to];
    if (
      to === "deferred" &&
      canTransition(from, "needs_review") &&
      canTransition("needs_review", to)
    ) {
      return ["needs_review", to];
    }
    return null;
  }

  /**
   * Build the guarded UPDATE. A `switch` over the discriminant rather than a spread of the body,
   * so every column this route can write is NAMED IN THIS FILE — the same discipline the response
   * mappers follow, and the reason `resulting_skill_id` cannot appear on a `create`.
   */
  private static writeFor(
    candidateId: string,
    dto: AdminSkillDecisionDto,
    nextStatus: SkillCandidateStatus,
    adminId: string,
    reviewReason: string,
    targetSkillId: string | undefined,
  ): Parameters<AdminSkillDiscoveryRepository["recordDecision"]>[0] {
    const base = {
      candidateId,
      expectedStatus: dto.expected_status,
      nextStatus,
      reviewerAdminId: adminId,
      // The SERVER clock. A caller-supplied moment on an audit row is not a moment.
      reviewedAt: new Date(),
      reviewReason,
    };
    switch (dto.decision) {
      case "create":
        // NOTE THE ABSENCE of `resultingSkillId`. It stays NULL until the offline corpus chain
        // mints the skill and somebody backfills it. `approvedJobDomainIds` is recorded as the
        // reviewer's JUDGEMENT — `job_domain_skill` edges are `db:seed:domain-skills`' to write,
        // from the corpus, after `validateTaxonomyCorpus` and a human commit.
        return {
          ...base,
          proposedSkillName: dto.proposed_skill_name,
          approvedJobDomainIds: [...dto.approved_job_domain_ids],
          approvedRequirement: dto.approved_requirement,
          ...(dto.proposed_description !== undefined
            ? { proposedDescription: dto.proposed_description }
            : {}),
        };
      case "alias":
      case "merge":
        return {
          ...base,
          ...(targetSkillId !== undefined ? { resultingSkillId: targetSkillId } : {}),
        };
      case "reject":
      case "hold":
        // Neither a target nor a label: a rejection that names a resulting skill is not a
        // rejection, and the row would fail `validateCandidate` on the next pass.
        return base;
    }
  }

  /**
   * Somebody else moved the row between the pre-read and the guarded UPDATE.
   *
   * The TOCTOU the WHERE-guard exists to close, answered honestly. Re-reading ON THE TRANSACTION
   * tells the two cases apart, and they are genuinely different:
   *
   *   * the racer recorded THE SAME decision (two clicks, or a retry that beat us) — the end
   *     state is what this caller asked for, so it is the `changed:false` no-op the result
   *     contract describes, with no event and no second reviewer stamped on the row.
   *   * the racer recorded a DIFFERENT one — reporting `changed:false` would tell the second
   *     reviewer their decision was recorded when somebody else's was. That is a 409.
   */
  private async settleLostRace(
    candidateId: string,
    dto: AdminSkillDecisionDto,
    nextStatus: SkillCandidateStatus,
    targetSkillId: string | undefined,
    tx: Database,
  ): Promise<void> {
    const now = await this.repo.findStatus(candidateId, tx);
    let sameOutcome = now !== undefined && now.status === nextStatus;
    if (sameOutcome && targetSkillId !== undefined) {
      const decided = await this.repo.findCandidate(candidateId);
      sameOutcome = decided?.resulting_skill_id === targetSkillId;
    }
    if (sameOutcome) return;
    throw AdminSkillDiscoveryService.conflict(
      candidateId,
      now === undefined ? "stale_expected_status" : "already_decided",
      now?.status ?? dto.expected_status,
      dto.expected_status,
    );
  }

  /** Problem CODES this write introduced that the row did not already carry. */
  private static introducedProblems(
    before: SkillCandidateRecord,
    after: SkillCandidateRecord,
  ): CandidateProblemCode[] {
    const had = new Set(validateCandidate(before).map((p) => p.code));
    const now = new Set(validateCandidate(after).map((p) => p.code));
    return [...now].filter((code) => !had.has(code));
  }

  /**
   * The single emit chokepoint — the action CODE plus two opaque ids, on the caller's `tx`.
   *
   * IT TAKES THE STATUS, NOT THE DECISION WORD, so the audited code is derived from what the
   * database actually wrote rather than from what the request asked for. The two agree today;
   * deriving from the row is what keeps them agreeing.
   *
   * `tx` IS WHAT MAKES IT ATOMIC and omitting it is silent: `EmitParams.tx` is optional and
   * `EventsRepository.insert`'s executor defaults to the injected db, so a missing `tx` compiles,
   * passes unit tests, and writes the event on a connection that survives the rollback.
   */
  private emitDecision(
    adminId: string,
    candidateId: string,
    status: SkillCandidateStatus,
    ctx: RequestContext,
    tx: Database,
  ): Promise<unknown> {
    const actionCode = SKILL_DECISION_ACTION_CODE[status];
    if (actionCode === null) {
      // Unreachable from `statusForDecision`, which only ever returns a human-decided status.
      // Fail closed rather than emit an event that cannot describe what happened.
      throw new InternalServerErrorException(
        `No audited action code exists for status ${status} — refusing to record an undescribable decision.`,
      );
    }
    const payload: PayloadInputOf<"admin.action_performed"> = {
      admin_id: adminId,
      action_code: actionCode,
      target_type: SKILL_CANDIDATE_SUBJECT_TYPE,
      target_id: candidateId,
    };
    return this.events.emit({
      event_name: "admin.action_performed",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: SKILL_CANDIDATE_SUBJECT_TYPE, subject_id: candidateId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `admin_action:${actionCode}:${adminId}:${candidateId}:${ctx.requestId}`,
      tx,
    });
  }

  /**
   * The 409 body. Carries the CURRENT status so the console can re-render without a second
   * request, and no reason text: the first decision's words belong to the reviewer who wrote
   * them, and the loser of a race does not need them to recover.
   *
   * `message` rides ALONGSIDE the four documented fields because `AllExceptionsFilter` passes an
   * object payload straight through as `error`, and `apps/admin-web`'s error reader looks for
   * `error.message` — a structured-only body would render in the console as a generic failure.
   */
  private static conflict(
    candidateId: string,
    conflict: AdminSkillDecisionConflict,
    currentStatus: SkillCandidateStatus,
    expectedStatus: SkillCandidateStatus,
  ): ConflictException {
    const body: AdminSkillDecisionConflictBody = {
      candidate_id: candidateId,
      conflict,
      current_status: currentStatus,
      expected_status: expectedStatus,
    };
    return new ConflictException({ message: CONFLICT_MESSAGES[conflict], ...body });
  }

  /**
   * The result. `corpus_effect` and `next_step` are the DTO's LITERALS, so a client that wants to
   * claim "skill created" has to fight the type system to do it.
   */
  private static result(
    candidateId: string,
    changed: boolean,
    status: SkillCandidateStatus,
    alreadyDecided: boolean,
  ): AdminSkillDecisionResult {
    return {
      target_id: candidateId,
      changed,
      status,
      already_decided: alreadyDecided,
      corpus_effect: SKILL_DECISION_EFFECT_RECORDED_ONLY,
      next_step: SKILL_DECISION_NEXT_STEP_OFFLINE_CORPUS_CHAIN,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════════════════
  // Read helpers — assembly, derivation, projection
  // ═════════════════════════════════════════════════════════════════════════════════════

  /**
   * THE ROW -> `SkillCandidateRecord` ASSEMBLER — the one genuinely new piece of logic this
   * surface needed, and the seam that makes every packages/db guard usable from an API.
   *
   * `created_at` IS THE STORED STRING, taken from `created_at_iso` and never from the `Date`.
   * `provenanceDigest` hashes `JSON.stringify` of 19 fields in a declared order and `created_at`
   * is one of them; round-tripping it through a `Date` and re-serializing changes the
   * fractional-second precision, and then EVERY digest check fails for a reason that looks
   * nothing like its cause.
   *
   * THE CASTS ARE HONEST, NOT LAZY. `phrase_class`, `classifier_rule` and match `relation` are
   * `text` with NO DB CHECK (schema/skill-discovery.ts:285/287/519) — their vocabularies are
   * closed in TypeScript only — so the row types carry `string` (a precise type over an imprecise
   * column is a claim the data cannot honour) while the record type carries the unions. The cast
   * is the boundary where that mismatch is acknowledged. Nothing downstream breaks on an
   * out-of-vocabulary value: `reviewTier` falls through to `derived`, and no `validateCandidate`
   * rule reads either field, so a bad value degrades a TIER rather than a decision.
   */
  private static assemble(
    row: AdminSkillCandidateDetailRow,
    sources: readonly AdminSkillCandidateSource[],
    matches: readonly AdminSkillCandidateMatchRow[],
  ): SkillCandidateRecord {
    return {
      candidate_id: row.id,
      run_id: row.run_id,
      cluster_key: row.cluster_key,
      normalized_phrase: row.normalized_phrase,
      proposed_skill_name: row.proposed_skill_name,
      proposed_description: row.proposed_description,
      phrase_class: row.phrase_class as PhraseClass,
      classifier_rule: row.classifier_rule as ClassifierRule,
      occupation_heads: row.occupation_heads,
      evidence_tokens: row.evidence_tokens,
      trade_family: row.trade_family,
      source_alias_count: row.source_alias_count,
      source_domain_count: row.source_domain_count,
      proposed_action: row.proposed_action,
      confidence_band: row.confidence_band,
      confidence: row.confidence,
      status: row.status,
      reviewer_admin_id: row.reviewer_admin_id,
      // Outside `PROVENANCE_FIELDS`, so its precision is nobody's digest.
      reviewed_at: row.reviewed_at ? row.reviewed_at.toISOString() : null,
      review_reason: row.review_reason,
      resulting_skill_id: row.resulting_skill_id,
      // The reviewer's trade judgement, RECORDED. Outside `PROVENANCE_FIELDS` for the same reason
      // the proposed label is: it is the part of the proposal a human is invited to correct. It
      // is also not an edge — `job_domain_skill` rows are the offline seeder's to write.
      approved_job_domain_ids: row.approved_job_domain_ids,
      approved_requirement: row.approved_requirement,
      embedding_status: row.embedding_status,
      model: row.model,
      prompt_version: row.prompt_version,
      corpus_fingerprint: row.corpus_fingerprint,
      provenance_digest: row.provenance_digest,
      created_at: row.created_at_iso,
      sources: sources.map(
        (s): CandidateSource => ({
          source_type: s.source_type,
          source_id: s.source_id,
          original_text: s.original_text,
          normalized_text: s.normalized_text,
          job_domain_id: s.job_domain_id,
        }),
      ),
      matches: matches.map(
        (m): CandidateMatch => ({
          skill_id: m.skill_id,
          relation: m.relation as MatchRelation | "vector_cosine",
          score: m.score,
          strength: m.strength,
          rank: m.rank,
          evidence_detail: m.evidence_detail,
        }),
      ),
    };
  }

  /** Assemble the record for one candidate on a given executor, or `null` when it is gone. */
  private async record(candidateId: string, tx: Database): Promise<SkillCandidateRecord | null> {
    const row = await this.repo.findCandidate(candidateId, tx);
    if (!row) return null;
    const [sources, matches] = await Promise.all([
      this.repo.listSources(candidateId, tx),
      this.repo.listMatches(candidateId, tx),
    ]);
    return AdminSkillDiscoveryService.assemble(row, sources, matches);
  }

  /**
   * The tier, through `reviewTierFrom` and through nothing else.
   *
   * The rule reads exactly TWO facts — `phrase_class`, and whether any match is strong — which is
   * why the dto names that pair as {@link AdminSkillCandidateTierFacts} and why packages/db
   * exposes the rule over exactly that pair. So this method is a rename, not a derivation: there
   * is no `if (phrase_class === "ACTIVITY_PHRASE")` anywhere in this file, because that would be a
   * second definition of a question packages/db has already answered, and the two would drift the
   * first time the rule gained a phrase class.
   *
   * ⚠ IT USED TO GO THROUGH `reviewTier(record)` VIA A DOUBLE CAST — a fabricated
   * `{ phrase_class, matches: [{ strength: "strong" }] }` forced through
   * `as unknown as SkillCandidateRecord`. That reached the right answer and was the wrong shape:
   * a queue page HAS no match rows (the strong-match fact is an `exists` subquery precisely so a
   * join cannot multiply the page), so the cast asserted a record this layer can never hold, and
   * the compiler stopped being able to check the one call that mattered. `reviewTierFrom` takes
   * the two facts as themselves; `reviewTier` now delegates to it, so the pipeline and this
   * surface share ONE implementation instead of one implementation and one cast.
   */
  private static tierFor(facts: AdminSkillCandidateTierFacts): AdminSkillReviewTier {
    return reviewTierFrom(facts.phrase_class, facts.has_strong_match);
  }

  /** The filter half of the queue query, named field by field so a new filter is a visible edit. */
  private static filterFor(dto: AdminSkillDiscoveryQueryDto): AdminSkillDiscoveryFilter {
    return {
      ...(dto.status !== undefined ? { status: [...dto.status] } : {}),
      ...(dto.tier !== undefined ? { tier: dto.tier } : {}),
      ...(dto.band !== undefined ? { band: dto.band } : {}),
      ...(dto.proposedAction !== undefined ? { proposedAction: dto.proposedAction } : {}),
      ...(dto.tradeFamily !== undefined ? { tradeFamily: dto.tradeFamily } : {}),
      ...(dto.sourceType !== undefined ? { sourceType: dto.sourceType } : {}),
      ...(dto.runId !== undefined ? { runId: dto.runId } : {}),
      ...(dto.clusterKey !== undefined ? { clusterKey: dto.clusterKey } : {}),
      ...(dto.phrase !== undefined ? { phrase: dto.phrase } : {}),
      ...(dto.createdFrom !== undefined ? { createdFrom: dto.createdFrom } : {}),
      ...(dto.createdTo !== undefined ? { createdTo: dto.createdTo } : {}),
    };
  }

  /**
   * Keyset paging over the over-fetched rows.
   *
   * THE CURSOR CARRIES THE REPOSITORY'S `sortKey`, NOT `created_at.toISOString()`. The sort key is
   * rendered by Postgres at MICROSECOND precision; a `Date` keeps milliseconds, so a cursor minted
   * from one sits strictly below the row it describes and every other row inside that millisecond
   * fails BOTH keyset terms — the id tie-breaker cannot save it. Measured: six rows seeded inside
   * one millisecond, page size 2 -> 2 returned, 4 skipped (migration 0083 /
   * admin-keyset-params.test.ts:227-257).
   *
   * DELIBERATELY DUPLICATED rather than hoisted out of the five sibling services
   * (admin-feedback.service.ts:145-148): the envelopes differ, and a shared version would be a
   * generic over the envelope for eight lines of slicing.
   */
  private static page(
    rows: AdminSkillDiscoveryQueueRow[],
    limit: number,
  ): { items: AdminSkillDiscoveryQueueRow[]; nextCursor: string | null } {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last ? encodeEntityCursor({ createdAt: last.sortKey, id: last.row.id }) : null,
    };
  }

  /**
   * One queue row + its three derived fields.
   *
   * An ABSENT fact row means "this candidate has no matches", which is the common case — not
   * missing data.
   */
  private static listItem(
    row: AdminSkillDiscoveryRow,
    facts: AdminSkillCandidateMatchFacts | undefined,
  ): AdminSkillDiscoveryListItem {
    const hasStrongMatch = facts?.has_strong_match ?? false;
    return {
      ...row,
      review_tier: AdminSkillDiscoveryService.tierFor({
        candidate_id: row.id,
        phrase_class: row.phrase_class,
        has_strong_match: hasStrongMatch,
      }),
      has_strong_match: hasStrongMatch,
      related_skill_count: facts?.related_skill_count ?? 0,
    };
  }

  /**
   * The detail projection.
   *
   * EVERY FIELD IS NAMED. `AdminSkillCandidateMatchRow` carries `score` and the wire type does
   * not, and TypeScript does NOT excess-property-check a spread — `{ ...matchRow }` would put the
   * similarity score on the response and compile. Projecting explicitly is the whole mechanism by
   * which that number stays off the screen.
   */
  private static detailOf(
    row: AdminSkillCandidateDetailRow,
    sources: readonly AdminSkillCandidateSource[],
    matches: readonly AdminSkillCandidateMatchRow[],
  ): AdminSkillDiscoveryDetail {
    const record = AdminSkillDiscoveryService.assemble(row, sources, matches);
    const hasStrongMatch = matches.some((m) => m.strength === "strong");
    const provenance: AdminSkillCandidateProvenance = {
      run_id: row.run_id,
      cluster_key: row.cluster_key,
      classifier_rule: row.classifier_rule,
      phrase_class: row.phrase_class,
      occupation_heads: row.occupation_heads,
      evidence_tokens: row.evidence_tokens,
      embedding_status: row.embedding_status,
      model: row.model,
      prompt_version: row.prompt_version,
      corpus_fingerprint: row.corpus_fingerprint,
      provenance_digest: row.provenance_digest,
    };
    return {
      ...AdminSkillDiscoveryService.listItem(row, {
        candidate_id: row.id,
        has_strong_match: hasStrongMatch,
        related_skill_count: matches.length,
      }),
      phrase_class_label:
        SKILL_PHRASE_CLASS_LABELS[row.phrase_class as AdminSkillPhraseClass] ?? row.phrase_class,
      proposed_description: row.proposed_description,
      rationale: AdminSkillDiscoveryService.rationaleFor(row),
      sources: sources.map((s) => ({ ...s })),
      source_type_counts: AdminSkillDiscoveryService.sourceTypeCounts(sources),
      related_skills: matches.map((m) => AdminSkillDiscoveryService.relatedSkill(m)),
      suggested_aliases: AdminSkillDiscoveryService.suggestedAliases(record),
      review_reason: row.review_reason,
      provenance,
    };
  }

  /**
   * One related skill, TRANSLATED — four things a reviewer can act on, and not one of them is a
   * number.
   *
   * An UNRECOGNISED relation renders its own raw code rather than a guessed sentence: an invented
   * explanation of evidence somebody is about to act on is worse than an unfamiliar code, which
   * at least reads as "ask somebody".
   *
   * `evidence` is NEVER null on the wire. When the run recorded no line, the relation's own
   * sentence IS the reason — whereas a blank cell reads as "no reason was found", a strictly
   * stronger and false claim.
   */
  private static relatedSkill(m: AdminSkillCandidateMatchRow): AdminSkillRelatedSkill {
    const relationLabel =
      SKILL_MATCH_RELATION_LABELS[m.relation as AdminSkillMatchRelation] ?? m.relation;
    return {
      skill_id: m.skill_id,
      skill_label: m.skill_label,
      relation: m.relation,
      relation_label: relationLabel,
      strength: m.strength,
      strength_label: SKILL_MATCH_STRENGTH_LABELS[m.strength as AdminSkillMatchStrength],
      evidence: m.evidence_detail ?? relationLabel,
      rank: m.rank,
    };
  }

  /**
   * THE ALIASES A `create` APPROVAL WOULD ACTUALLY MINT — through `candidateAliasTexts`, which is
   * the SAME function `approvedCandidateToCorpusSkill` mints them with, not a re-statement of it.
   *
   * Re-implementing "trim, dedupe case-insensitively, exclude the canonical label" here is how a
   * reviewer ends up approving an alias set they were never shown: the copy drifts, the preview
   * and the mint disagree, and the disagreement is invisible because each side looks right on its
   * own. The exclusion in particular is not cosmetic — including the label produces
   * ALIAS_DUPLICATE_WITHIN_SKILL downstream, which surfaces as a corpus validation failure long
   * after the decision, with nobody left to ask.
   *
   * ⚠ IT USED TO CALL `approvedCandidateToCorpusSkill` DIRECTLY, on a COPY of the record with
   * `status` forced to `approved_create`. Two things were wrong with that and only one of them
   * was style.
   *
   * The first: that function's ONLY job is to refuse anything a human has not approved — it opens
   * by throwing on exactly that status check. Handing it a forged status to get past its own gate
   * puts a "pretend this was approved" on a READ path, which is the shape of the shortcut this
   * whole surface exists to refuse, and it would read as precedent.
   *
   * The second is a real wrong answer. The forged copy fell back to `normalized_phrase` when no
   * label had been proposed, and the function EXCLUDES the label from its own alias list — so a
   * candidate with no proposed label had its normalized phrase silently dropped from the preview,
   * i.e. the screen hid one of the aliases the approval would actually create. `candidateAliasTexts`
   * takes the label as `string | null` and excludes nothing when it is absent, which is the honest
   * answer: every source phrase is currently an alias, and the moment the reviewer types a label
   * the matching one drops out.
   */
  private static suggestedAliases(record: SkillCandidateRecord): string[] {
    return candidateAliasTexts(record.proposed_skill_name, record.sources);
  }

  /**
   * WHY THIS CANDIDATE LOOKS THE WAY IT DOES, composed from STORED COLUMNS and nothing else.
   *
   * There is no `rationale` column in migration 0093 — the run does not persist
   * `PhraseVerdict.rationale` — so this is a rendering of `classifier_rule`, `phrase_class`,
   * `occupation_heads`, `evidence_tokens`, the two attestation counts and the family. It is a
   * RESTATEMENT of provenance, not a new fact, which is exactly why it is safe to put in front of
   * a reviewer who is about to act on it. An LLM sentence here would be a machine explaining a
   * decision it is not allowed to make (CLAUDE.md §3).
   */
  private static rationaleFor(row: AdminSkillCandidateDetailRow): string {
    const parts: string[] = [`Classified ${row.phrase_class} by rule ${row.classifier_rule}.`];
    if (row.occupation_heads.length > 0) {
      parts.push(`Occupation heads: ${row.occupation_heads.join(", ")}.`);
    }
    if (row.evidence_tokens.length > 0) {
      parts.push(`Evidence tokens: ${row.evidence_tokens.join(", ")}.`);
    }
    const phrases = row.source_alias_count === 1 ? "1 phrase" : `${row.source_alias_count} phrases`;
    const trades = row.source_domain_count === 1 ? "1 trade" : `${row.source_domain_count} trades`;
    parts.push(`Attested by ${phrases} across ${trades}.`);
    if (row.trade_family) parts.push(`Trade family: ${row.trade_family}.`);
    return parts.join(" ");
  }

  /**
   * Densified source-type counts — every one of the six emitted, zeros included.
   *
   * NO `other` BUCKET: `skill_candidate_source_type_chk` makes one permanently zero, and a
   * permanently-zero bucket that looks like a corruption detector is worse than none, because it
   * will be trusted.
   */
  private static sourceTypeCounts(
    sources: readonly AdminSkillCandidateSource[],
  ): AdminSkillSourceTypeBuckets {
    const counts = new Map<SkillCandidateSourceType, number>();
    for (const s of sources) counts.set(s.source_type, (counts.get(s.source_type) ?? 0) + 1);
    return SKILL_CANDIDATE_SOURCE_TYPES.map((key) => ({ key, count: counts.get(key) ?? 0 }));
  }

  /** Emit every enum member, zeros included, in the vocabulary's own declared order. */
  private static densify<K extends string>(
    vocabulary: readonly K[],
    buckets: readonly AdminCountBucket<K>[],
  ): AdminCountBucket<K>[] {
    const counts = new Map<K, number>(buckets.map((b) => [b.key, b.count]));
    return vocabulary.map((key) => ({ key, count: counts.get(key) ?? 0 }));
  }

  /**
   * The tier breakdown, summed through the SAME `reviewTier` the row-level derivation uses.
   *
   * The repository returns per-`phrase_class` counts SPLIT by strong match — the two facts that
   * function reads — so each row contributes twice: once as "with a strong match", once as
   * "without". A `GROUP BY <tier expression>` in SQL would have been a third copy of the rule, in
   * the layer least able to be tested against the other two.
   *
   * An unrecognised `phrase_class` lands in `derived`, which is `reviewTier`'s own final
   * fallback. That is a real blind spot — a bad value inflates a tier rather than showing up as an
   * anomaly — and it is the dto's stated behaviour rather than an accident here.
   */
  private static tierBuckets(
    facts: readonly AdminSkillPhraseClassTierFacts[],
  ): AdminCountBucket<AdminSkillReviewTier>[] {
    const totals: Record<AdminSkillReviewTier, number> = { direct: 0, derived: 0, ambiguous: 0 };
    for (const f of facts) {
      if (f.with_strong_match > 0) {
        totals[
          AdminSkillDiscoveryService.tierFor({
            candidate_id: "",
            phrase_class: f.phrase_class,
            has_strong_match: true,
          })
        ] += f.with_strong_match;
      }
      if (f.without_strong_match > 0) {
        totals[
          AdminSkillDiscoveryService.tierFor({
            candidate_id: "",
            phrase_class: f.phrase_class,
            has_strong_match: false,
          })
        ] += f.without_strong_match;
      }
    }
    return (Object.keys(totals) as AdminSkillReviewTier[]).map((key) => ({
      key,
      count: totals[key],
    }));
  }
}
