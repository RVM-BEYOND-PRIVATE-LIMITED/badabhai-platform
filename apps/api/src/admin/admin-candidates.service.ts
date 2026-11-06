import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { e164PhoneSchema } from "@badabhai/validators";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { can } from "./admin-capabilities";
import { AdminCandidatesSearchCapService } from "./admin-candidates-search-cap.service";
import { AdminIdentityService } from "./admin-identity.service";
import { NameTokenService } from "./candidate-index/name-token.service";
import { foldSearchToken } from "./candidate-index/candidate-index.projector";
import { AdminCandidatesRepository } from "./admin-candidates.repository";
import type {
  AdminCandidateRow,
  AdminCandidateSearchDto,
  AdminCandidateSearchResponse,
} from "./admin-candidates.dto";

/**
 * The Candidates data-bank search (B5, #2559 — ADR-0062 §3.6). One box over
 * every field: partial label match (`search_doc`), exact full phone, and
 * whole-word exact name tokens — OR-ed in a single statement so the exact
 * total and the facets describe the same rows.
 *
 * ── q CLASSIFICATION (never logged — the term travels in the POST body only) ──
 * - PHONE-shaped (10+ digits after stripping, or a leading `+`): normalised to
 *   E.164 (bare 10-digit → `+91`), validated, hashed with the UNCHANGED
 *   `hashPhone`, matched against the copied `phone_hash`. Requires
 *   `read_identity` — without it the whole request 403s and serves NOTHING
 *   (never a faceless degradation that would confirm "no such number").
 * - NAME branch: whole-word tokens of the term, matched with `@>` (ALL words).
 *   Runs only for `read_identity` holders with a provisioned keyring; analysts
 *   and keyring-less boxes search labels only.
 * - TEXT branch: folded `ILIKE` over `search_doc`. Runs for every role.
 * - `q_type` reports which identity branches RAN (`name`, `phone`, both, null)
 *   — never the term.
 *
 * ── GATES ──
 * Every term search consumes the per-admin SEARCH cap first (fail-closed 429 +
 * PII-free breach event). A name/phone lookup then emits `admin.identity_searched`
 * AFTER the match and BEFORE any result leaves — awaited and fail-closed (a
 * failed emit returns an EMPTY page, never partial rows). Names on the page go
 * through the Candidates identity surface (100-name bound, own budget, audit).
 */
@Injectable()
export class AdminCandidatesService {
  private readonly logger = new Logger(AdminCandidatesService.name);

  constructor(
    private readonly repo: AdminCandidatesRepository,
    private readonly identity: AdminIdentityService,
    private readonly searchCap: AdminCandidatesSearchCapService,
    private readonly pii: PiiCryptoService,
    private readonly nameTokens: NameTokenService,
    private readonly events: EventsService,
  ) {}

  async search(
    admin: AuthenticatedAdmin,
    dto: AdminCandidateSearchDto,
    ctx: RequestContext,
  ): Promise<AdminCandidateSearchResponse> {
    const permitted = can(admin.role, "read_identity");
    const q = dto.q?.trim() ? dto.q.trim() : null;

    // --- 1. Classify the term (no I/O, no logging of the value).
    // A term containing letters is NEVER a phone lookup (no guessing a number
    // out of "Mumbai 400001"); a pure phone-shaped term is ONLY a phone lookup
    // (digits match no label — running the text/name branches would smear the
    // operator's number across branches that cannot meaningfully match it).
    const hasLetters = q !== null && /\p{L}/u.test(q);
    const phoneE164 = q === null || hasLetters ? null : normalizePhoneToE164(q);
    if (phoneE164 !== null && !permitted) {
      // A phone lookup without the identity capability: 403 and NOTHING served.
      throw new ForbiddenException("Phone search requires the identity capability");
    }
    const phoneHash = phoneE164 === null ? null : this.pii.hashPhone(phoneE164);
    const termTokens =
      q !== null && permitted && phoneE164 === null ? this.nameTokens.termTokens(q) : null;
    const nameHashes = termTokens?.hashes ?? null;
    const textLike = q === null || phoneE164 !== null ? null : `%${escapeLike(foldSearchToken(q))}%`;
    const qType =
      phoneHash !== null ? ("phone" as const) : nameHashes !== null ? ("name" as const) : null;

    // --- 2. SEARCH cap on every term search (fail-closed 429 + breach event).
    if (q !== null) {
      const cap = await this.searchCap.consume(admin.id);
      if (!cap.ok) {
        try {
          await this.events.emit({
            event_name: "admin.candidates_search_cap_exceeded",
            actor: { actor_type: "admin", actor_id: admin.id },
            subject: { subject_type: "admin_session", subject_id: admin.id },
            payload: { admin_id: admin.id, window: cap.window },
            correlationId: ctx.correlationId,
            requestId: ctx.requestId,
          });
        } catch (err) {
          this.logger.error(
            `could not record admin.candidates_search_cap_exceeded admin_id=${admin.id.slice(0, 8)}…`,
          );
          void err;
        }
        throw new HttpException(
          "Too many searches; try again later",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    // --- 3. The single statement: page + exact total + identity count + facets.
    const limit = dto.page_size;
    const offset = (dto.page - 1) * dto.page_size;
    const result = await this.repo.search({
      filters: dto.filters ?? {},
      textLike,
      phoneHash,
      nameHashes,
      sort: dto.sort,
      dir: dto.dir,
      limit,
      offset,
    });

    // --- 4. AUDIT-BEFORE-RESULTS for name/phone lookups. Awaited, fail-closed:
    // a failed emit returns an EMPTY page — never partial rows, never the term.
    if (qType !== null) {
      try {
        await this.events.emit({
          event_name: "admin.identity_searched",
          actor: { actor_type: "admin", actor_id: admin.id },
          subject: { subject_type: "admin_session", subject_id: admin.id },
          payload: {
            admin_id: admin.id,
            search_kind: qType === "phone" ? "phone" : "name",
            match_count: result.identityMatches,
          },
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
        });
      } catch {
        return emptyResponse(dto, qType);
      }
    }

    // --- 5. Names under the identity rules (Candidates surface, 100-bound).
    // `null` map = undisclosed (no capability, capped, over bound) → the field
    // stays ABSENT; a disclosed null = no name on record.
    const ids = result.rows.map((r) => r.workerId);
    const names = await this.identity.resolve(admin, "candidates", ids, null, ctx);

    const candidates: AdminCandidateRow[] = result.rows.map((r) => {
      const row: AdminCandidateRow = {
        worker_id: r.workerId,
        status: r.status,
        flagged: r.flagged,
        is_test_account: r.isTestAccount,
        deletion_scheduled_at: r.deletionScheduledAt?.toISOString() ?? null,
        employer_sharing_consent: r.employerSharingConsent,
        current_city: r.currentCity,
        current_state: r.currentState,
        canonical_trade_id: r.canonicalTradeId,
        canonical_role_id: r.canonicalRoleId,
        job_domain_id: r.jobDomainId,
        trade_label: r.tradeLabel,
        role_label: r.roleLabel,
        domain_label: r.domainLabel,
        total_experience_years: r.totalExperienceYears,
        role_experience_months: r.roleExperienceMonths,
        salary_min_inr: r.salaryMinInr,
        salary_max_inr: r.salaryMaxInr,
        salary_period: r.salaryPeriod,
        availability_status: r.availabilityStatus,
        shift_preference: r.shiftPreference,
        form_level: r.formLevel,
        skills: [...r.skills],
        languages: [...r.languages],
        education_level: r.educationLevel,
        resume_count: r.resumeCount,
        latest_resume_status: r.latestResumeStatus,
        latest_resume_version: r.latestResumeVersion,
        profile_status: r.profileStatus,
        profile_source: r.profileSource,
        app_version: r.appVersion,
        last_active_at: r.lastActiveAt?.toISOString() ?? null,
        created_at: r.createdAt.toISOString(),
        updated_at: r.updatedAt.toISOString(),
        ai_cost_inr: r.aiCostInr,
        referral_source: r.referralSource,
      };
      const name = names?.get(r.workerId);
      if (name !== undefined) row.name = name;
      return row;
    });

    return {
      candidates,
      page: dto.page,
      page_size: dto.page_size,
      total: result.total,
      total_pages: Math.ceil(result.total / dto.page_size),
      counts: {
        by_status: result.byStatus.map(({ value, count }) => ({ value, count })),
        by_trade: result.byTrade.map(({ value, count }) => ({ value, count })),
        by_city: result.byCity.map(({ value, count }) => ({ value, count })),
        by_profile_status: result.byProfileStatus.map(({ value, count }) => ({ value, count })),
      },
      q_type: qType,
    };
  }
}

/**
 * Normalise a typed term to strict E.164 for exact phone lookup, or `null`
 * when the term is not phone-shaped. A bare 10-digit Indian number defaults to
 * `+91` (ADR-0062 §3.6); anything failing `e164PhoneSchema` is not a phone.
 * Pure — the term is never logged here or by callers.
 */
export function normalizePhoneToE164(term: string): string | null {
  const trimmed = term.trim();
  if (trimmed === "") return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return null;
  // A bare 10-digit Indian number defaults to `+91` (ADR-0062 §3.6). Any other
  // digit run WITHOUT a `+` is ambiguous (pincodes, codes, partial numbers) and
  // is never guessed — the text branch still serves it as labels.
  const e164 = trimmed.startsWith("+") ? `+${digits}` : digits.length === 10 ? `+91${digits}` : null;
  if (e164 === null) return null;
  const parsed = e164PhoneSchema.safeParse(e164);
  return parsed.success ? parsed.data : null;
}

/** Escape LIKE wildcards so the text branch matches literally. */
function escapeLike(folded: string): string {
  return folded.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function emptyResponse(
  dto: AdminCandidateSearchDto,
  qType: NonNullable<AdminCandidateSearchResponse["q_type"]>,
): AdminCandidateSearchResponse {
  return {
    candidates: [],
    page: dto.page,
    page_size: dto.page_size,
    total: 0,
    total_pages: 0,
    counts: { by_status: [], by_trade: [], by_city: [], by_profile_status: [] },
    q_type: qType,
  };
}
