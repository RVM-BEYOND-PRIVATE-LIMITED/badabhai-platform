import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminSkillDiscoveryService } from "./admin-skill-discovery.service";
import {
  AdminSkillDecisionSchema,
  AdminSkillDiscoveryMetricsQuerySchema,
  AdminSkillDiscoveryParamsSchema,
  AdminSkillDiscoveryQuerySchema,
  type AdminSkillDecisionDto,
  type AdminSkillDecisionResult,
  type AdminSkillDiscoveryDetail,
  type AdminSkillDiscoveryMetrics,
  type AdminSkillDiscoveryMetricsQueryDto,
  type AdminSkillDiscoveryPage,
  type AdminSkillDiscoveryParamsDto,
  type AdminSkillDiscoveryQueryDto,
} from "./admin-skill-discovery.dto";

/**
 * HTTP surface for the admin SKILL-CANDIDATE REVIEW screen — three reads and the ONE write by
 * which a named human decides what a discovery run found (migration 0093 + the pure modules in
 * `packages/db/src/skill-discovery-*.ts`). The whole contract is `admin-skill-discovery.dto.ts`;
 * this file validates, delegates and returns, and does nothing else (CLAUDE.md §4).
 *
 *   GET  /admin/skill-discovery                the review QUEUE (keyset page + filters)
 *   GET  /admin/skill-discovery/metrics        the queue tiles
 *   GET  /admin/skill-discovery/:id            one candidate, in full, in plain language
 *   POST /admin/skill-discovery/:id/decision   the recorded human decision
 *
 * ── THE WRITE RECORDS A DECISION; IT DOES NOT WRITE THE TAXONOMY ────────────────────────
 * There is no request path on this controller — none, by construction — that creates a canonical
 * `skill`, a `skill_alias` or a `job_domain_skill` row. An approval moves one `skill_candidate`
 * row and stops. Minting the corpus stays in the offline guarded chain that already has its own
 * human in it (`approvedCandidateToCorpusSkill` → `validateTaxonomyCorpus` →
 * `taxonomyQualityVerdict` → a human commit → `db:seed:domain-skills` → `db:promote:skills`
 * C1..C5). That is why `resulting_skill_id` stays NULL on an `approved_create` until the chain
 * actually ships the skill — which makes the column the honest answer to "did this approval ever
 * land?", and why the decision result carries `corpus_effect` as a LITERAL type a client cannot
 * render as "skill created".
 *
 * ── WHY ITS OWN CONTROLLER ──────────────────────────────────────────────────────────────
 * Not a method on `AdminEntitiesController`: that controller's contract is FACELESS reads of
 * system-of-record entities, pinned field-by-field and enforced by a source scan over its
 * repository. And not a sixth method on `AdminActionsService`/`AdminActionsController`: those
 * routes moderate ENTITIES (a payer, a posting, a worker, an admin) and each is gated on a
 * capability about that entity class. This one authors VOCABULARY. Keeping it separate is what
 * lets it carry its own capability without widening any of theirs — and what stops the faceless
 * promise made on the entity surface from acquiring an exception it never agreed to, since the
 * detail read here deliberately serves `skill_candidate_source.original_text`, the raw wording a
 * phrase was discovered from.
 *
 * ── GUARDS AND CAPABILITIES ─────────────────────────────────────────────────────────────
 * `AdminAuthGuard` then `AdminRolesGuard`, CLASS level, in that order (auth first). The
 * capability is METHOD level and there is exactly ONE per route — never class level. That is not
 * a style rule here, it is the whole safety property of this file: `Reflector.getAllAndOverride`
 * falls back to the class, so a class-level `@RequireAdminRole("read_entities")` would be
 * INHERITED by the decision write, silently gating taxonomy authorship on the read floor that all
 * four roles hold, with nothing wrong on the write's own line — the decorator would simply be
 * missing. `admin-skill-discovery.authz.test.ts` asserts the class declares none.
 *
 * THE THREE READS ARE ON `read_entities`, the ADR-0025 read floor every admin read surface
 * declares. They disclose no identity, no money and no plaintext, and the standing decision is to
 * reuse the floor unless a human has ruled otherwise (admin-feedback.authz.test.ts:63-69,
 * CLAUDE.md §16). Narrowing a read later is one line each.
 *
 * THE WRITE IS ON `review_skill_candidates` (`super_admin` + `ops_admin`), a capability minted for
 * it. Reusing an existing write capability was the tempting move and is the dangerous one,
 * because it WORKS: CI green, button functional, and `GET /admin/me` — which is what the portal
 * renders its controls from (`capabilitiesFor`) — quietly starts telling the console that a holder
 * of, say, `flag_worker` may author the match vocabulary. That is the failure
 * `admin-capabilities.ts` names twice, in the same words, about two different rows: "A capability
 * that has stopped meaning what its row says is worse than no capability at all: it is an
 * authorization table people still trust." Nothing on screen and nothing in CI would ever say it
 * had happened.
 *
 * TWO THINGS ARE STILL OWED ON THAT ROW, and they are owed to a human, not to this file.
 * (1) ADR-0025 §3.1 has no cell for `review_skill_candidates` — the `super_admin` + `ops_admin`
 * allow-set is the backend's reasoned default (the blast radius is one audited queue row plus a
 * recommendation a second human must accept, which is the class of governed queue work
 * `flag_worker` already grants `ops_admin`; a super_admin-only review queue is a queue that
 * stops), and `admin-capabilities.ts` records that it is not a signed cell. (2) `apps/admin-web`'s
 * `ADMIN_CAPABILITIES` + exhaustive `CAPABILITY_LABELS` is Frontend Platform's file (CLAUDE.md
 * §5/§6): until that lands, the console has a capability it cannot label, so the review UI cannot
 * ship even though this route can. That needs a Frontend issue, not a backend edit.
 *
 * ── NO `Cache-Control: no-store`, ON ANY ROUTE ──────────────────────────────────────────
 * That header is a claim about the BODY — "this may contain decrypted PII" — and spraying it makes
 * it decorative, so the next reviewer can no longer read its presence as a signal
 * (admin-ai-traces.controller.ts:73-81; pinned for the faceless entity routes at
 * admin-static-guards.test.ts:829). Note the calibration: `GET /admin/feedback` returns a worker's
 * own prose ATTRIBUTED to a `worker_id` and still carries no `no-store`. This is strictly less than
 * that — there is no `worker_id` column on ANY of the four 0093 tables, so `original_text` is
 * unattributable by construction; it is contractually pseudonymized upstream for the
 * `worker_phrase` source type; and the classifier rejects any phrase carrying a digit, `@` or a
 * URL before it is ever stored (`FORBIDDEN_CHARS`, checked first, before every taxonomy question).
 *
 * ── WHY THE READS TAKE NO ACTOR AND NO `@Ctx()`, AND THE WRITE TAKES BOTH ───────────────
 * The house rule is that `@Ctx()` appears only where the service EMITS, and an actor is threaded
 * only where the service needs one — the ai-trace list takes neither (admin-ai-traces.
 * controller.ts:84), nor do the faceless entity reads. Threading either one "for later" makes the
 * parameter list lie about what the service does with it.
 *
 * The reads emit nothing. The sibling read that DOES emit (`admin.feedback_viewed`) does so
 * because the row it serves is a worker's prose tied to that worker's id, so "who read it" is a
 * privacy fact; here it cannot be, per the paragraph above. An audit row would record the
 * governance fact "an admin looked at candidate Y", which is worth having and is not free — it
 * needs a new event name, and `EVENT_NAMES` is pinned at 168 (event-schema.test.ts:3045). The
 * DECISION is the act that needs the trail, and it gets one: the already-registered value-free
 * `admin.action_performed`, on the same transaction as the row write.
 *
 * A DECIDED-BY FILTER IS ABSENT FROM THE QUERY DTO ON PURPOSE ("which decisions did admin X make
 * last week" is an audit question, and the spine already answers it by actor), so this surface
 * cannot be turned into a per-reviewer performance report by URL.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminSkillDiscoveryController {
  constructor(private readonly service: AdminSkillDiscoveryService) {}

  /**
   * GET /admin/skill-discovery — one keyset page of the review queue.
   *
   * `.strict()` on the query schema is what makes a typo'd filter a 400 instead of an unfiltered
   * page served under a URL that claims a filter. The pipe owns validation; nothing is re-shaped
   * here (asserted for the sibling surface at admin-feedback.controller.test.ts:76-85).
   *
   * ⚠ `sort` MUST BE RESENT ON EVERY PAGE-TURN. `encodeEntityCursor` writes `{c, i}` and no
   * direction (admin-entities.cursor.ts:27-29), so a token minted on a `newest` page and replayed
   * against `sort=oldest` pages the wrong way — silently, with rows that look plausible. The DTO
   * records the owed cursor module; it is repeated here because this is where a client reads the
   * route.
   */
  @Get("skill-discovery")
  @RequireAdminRole("read_entities")
  list(
    @Query(new ZodValidationPipe(AdminSkillDiscoveryQuerySchema))
    query: AdminSkillDiscoveryQueryDto,
  ): Promise<AdminSkillDiscoveryPage> {
    return this.service.list(query);
  }

  /**
   * GET /admin/skill-discovery/metrics — the queue tiles, optionally scoped to one run.
   *
   * DECLARED BEFORE `:id`, AND THAT ORDER IS LOAD-BEARING. Nest matches routes in declaration
   * order, so `skill-discovery/:id` declared first would swallow `/metrics` — and the failure
   * would not even be a 404 but a 400 from `AdminSkillDiscoveryParamsSchema` complaining that
   * "metrics" is not a uuid, which is a confusing way to learn about route ordering. The uuid
   * param means a mis-ordered build fails closed rather than serving something odd, but relying
   * on that would leave the tiles permanently broken.
   *
   * There is no `windowDays` here on purpose: a review queue is a BACKLOG, and a window hides the
   * oldest undecided candidates, which are exactly the rows the tile exists to surface.
   */
  @Get("skill-discovery/metrics")
  @RequireAdminRole("read_entities")
  metrics(
    @Query(new ZodValidationPipe(AdminSkillDiscoveryMetricsQuerySchema))
    query: AdminSkillDiscoveryMetricsQueryDto,
  ): Promise<AdminSkillDiscoveryMetrics> {
    return this.service.metrics(query);
  }

  /**
   * GET /admin/skill-discovery/:id — one candidate, with its sources, its related skills in plain
   * language, and its frozen provenance.
   *
   * THE PATH PARAM IS VALIDATED BY A ZOD PIPE, not `ParseUUIDPipe` and not left unvalidated:
   * `candidate_id` is a `uuid` column, and a non-uuid can only fail at BIND with Postgres 22P02,
   * which arrives as a 500 (the #1014 finding, guarded for cursors at
   * admin-entities.cursor.ts:56). A 400 says what actually happened.
   *
   * The response carries NO similarity score, by contract — `AdminSkillRelatedSkill` has no
   * `score` key even though the repository reads the column. A 0..1 number on a review screen
   * re-imports the threshold thinking this surface exists to keep out: a UI that sorts by it, or
   * an operator who learns "0.9 is fine", has recreated an approval floor with no owner ruling
   * behind it. `rank` is an ORDER, not a measurement, and it is what ships.
   */
  @Get("skill-discovery/:id")
  @RequireAdminRole("read_entities")
  detail(
    @Param(new ZodValidationPipe(AdminSkillDiscoveryParamsSchema))
    params: AdminSkillDiscoveryParamsDto,
  ): Promise<AdminSkillDiscoveryDetail> {
    return this.service.detail(params.id);
  }

  /**
   * POST /admin/skill-discovery/:id/decision — RECORD one human decision on one candidate.
   *
   * `@HttpCode(200)`, not 201: this mutates an existing row and creates no resource, which is the
   * house split (201 appears on exactly one admin route, `@Post("admins")`).
   *
   * ── THE THREE THINGS THE CALLER DOES NOT GET TO SAY ─────────────────────────────────
   * WHO. `reviewer_admin_id` is `@CurrentAdmin().id`, resolved by `AdminAuthGuard` from the
   * session cookie. It is the FIRST parameter by convention and it is never read from the body,
   * the query or the path — an actor a caller can type is not an actor, and this row is the audit
   * trail for a taxonomy decision that will outlive everyone in it. `AdminSkillDecisionSchema` has
   * no field for it on any branch, so an attempt is a 400 from `.strict()` rather than a value
   * that has to be ignored somewhere downstream.
   *
   * WHEN. `reviewed_at` is the server clock, in the service. Same argument.
   *
   * WHICH ROW. The target is the validated uuid PATH param, never a body field. A body-supplied
   * target on a route whose path already names one is two sources of truth for the same fact, and
   * the guard-relevant one is the path.
   *
   * `skill_candidate_reviewed_chk` demands all three of reviewer / reviewed_at / review_reason
   * NOT NULL together for every human-decided status (schema/skill-discovery.ts:394), and
   * `validateCandidate` additionally rejects a whitespace-only reason as
   * DECISION_WITHOUT_REVIEWER — so a blank reason is not a decision even though it satisfies NOT
   * NULL. Hence `review_reason` is mandatory on every branch of the union with a real minimum
   * length; the other two are supplied here, from things a caller cannot forge.
   *
   * ── WHAT THE BODY VALIDATION BUYS AT THE PIPE ───────────────────────────────────────
   * `AdminSkillDecisionSchema` is a discriminated union of five `.strict()` members, so the
   * database's CONDITIONAL CHECKs become unrepresentable states rather than 500s from a
   * constraint name: `create` requires a label and REFUSES `resulting_skill_id`
   * (`skill_candidate_create_label_chk`, and invariant 6 — the id stays NULL until the offline
   * chain mints the skill); `alias`/`merge` require `resulting_skill_id` and refuse a label
   * (`skill_candidate_resolution_chk`); `reject`/`hold` accept neither. The `mskill_*` wall is
   * enforced at this pipe too, by prefix AND by `MATCH_SKILLS` membership — a 400 names the
   * problem, whereas a CHECK violation arrives as a 500 after a transaction was opened,
   * mid-decision.
   *
   * ── WHAT IS STILL THE SERVICE'S JOB, SO THIS HANDLER'S THINNESS IS NOT MISREAD ──────
   * `canTransition` (the DB does NOT enforce the ladder — e.g. `pending → approved_map` skips
   * human review and no CHECK catches it), the `pending → needs_review → deferred` two-step for a
   * `hold` on a pending row, the guarded UPDATE whose WHERE carries `expected_status` as the
   * optimistic-concurrency token, `assertProvenanceIntact`, the idempotent re-submit
   * (`changed: false` + `already_decided: true`, and the first reviewer's authorship never
   * overwritten), the 409 for a DIFFERENT decision on a terminal row, and the one value-free
   * `admin.action_performed` emit on the SAME transaction. `@Ctx()` is last because that emit
   * needs the correlation and request ids.
   */
  @Post("skill-discovery/:id/decision")
  @HttpCode(200)
  @RequireAdminRole("review_skill_candidates")
  decide(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminSkillDiscoveryParamsSchema))
    params: AdminSkillDiscoveryParamsDto,
    @Body(new ZodValidationPipe(AdminSkillDecisionSchema)) body: AdminSkillDecisionDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminSkillDecisionResult> {
    return this.service.decide(admin.id, params.id, body, ctx);
  }
}
