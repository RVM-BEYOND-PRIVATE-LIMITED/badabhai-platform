import { BadRequestException, Injectable, Logger, Optional } from "@nestjs/common";
import { isSampleWorkerId } from "@badabhai/db";
import { canonicalCity } from "@badabhai/profiling-lexicon";
import {
  INDUSTRIES,
  MATCH_SKILLS,
  matchSkillLabel,
  relatedMatchSkills,
  TRADE_LEVEL_LABELS,
  type TradeLevel,
} from "@badabhai/taxonomy";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { applyEffectiveFacts } from "../profiles/effective-facts";
import { EffectiveFactsService } from "../profiles/effective-facts.service";
import { MatchConfigService } from "../match/match-config.service";
import type { TradeLevelBadge } from "../match/match-candidates.service";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { encodeCandidateCursor, searchFingerprint } from "./candidate-search.cursor";
import {
  CANDIDATE_SEARCH_MAX_ROLES,
  EXPERIENCE_BUCKETS,
  experienceRange,
  type CandidateFiltersDto,
  type CandidateSearchDto,
  type CandidateSearchResponseDto,
  type CandidateSearchRowDto,
  type LabelledIdDto,
} from "./candidate-search.dto";
import {
  CandidateSearchRepository,
  type CandidatePoolRow,
  type CandidateRoleRow,
} from "./candidate-search.repository";

/** How many of his other roles a card names. */
const OTHER_ROLES_ON_CARD = 4;

/**
 * How long the city FACET (`GET /payer/candidates/filters`) reuses one read of the pool's recorded
 * city spellings — a scan of the eligible pool, so a page view never pays for it twice a minute.
 * The city FILTER never uses this cache: a spelling recorded since the last read would otherwise be
 * a wrong "no" for up to a minute. It reads fresh, on a route the per-payer cap already bounds.
 */
export const POOL_CITIES_TTL_MS = 60_000;

/** One stated rung of one worker (the match repository's batched read). */
export interface CandidateTradeLevelRow {
  workerId: string;
  skillId: string;
  tradeLevel: string;
  levelConfirmed: boolean;
}

/**
 * THE PAYER'S ALL-CANDIDATES SEARCH (ADR-0040, phase E2; owner rulings 2026-11-03 — the payer-web
 * "Candidates" tab opens on it, the payer app's Find tab too, company and agency alike).
 *
 * WHAT IT IS: every worker in the eligible pool (membership in `CandidateSearchRepository` —
 * consent, `wants`, not leaving, not suspended), ordered by the payer's filters and then the
 * ADR-0036 rank key, MASKED. Identity stays behind `POST /payer/unlocks`, which already takes a
 * search row's `workerId` with `job_id: null`; this read reveals nothing that route guards.
 *
 * NO TENANT SCOPE, ON PURPOSE: nothing here is owned — the pool is the same for every payer, the
 * rows carry no payer data, and the read writes nothing but its audit event. Ownership questions
 * (an unlock, a résumé, a stage) live on the routes that act, each resolving its own tenant.
 *
 * READS, BOUNDED: one statement for the counts + page (one row past it decides `nextCursor`),
 * then two batched detail reads for the page's workers (their other wanted roles, and their
 * stated rungs through `WorkerSkillsRepository`). A city filter adds one read of the pool's
 * recorded city spellings. Never a per-row read.
 *
 * EVENTS: one `payer.candidate_search_performed` per page — the SHAPE of the search and its
 * counts, never a worker id or a city (see the payload's doc). Emitted after the reads; a failed
 * read emits nothing.
 *
 * FAIL CLOSED: any read error propagates (a 5xx) — never a partial or unfiltered page.
 */
@Injectable()
export class CandidateSearchService {
  private readonly logger = new Logger(CandidateSearchService.name);

  private poolCities: { readAt: number; spellings: Promise<string[]> } | null = null;

  constructor(
    private readonly repo: CandidateSearchRepository,
    private readonly workerSkills: WorkerSkillsRepository,
    private readonly matchConfig: MatchConfigService,
    private readonly events: EventsService,
    // #2561 — the live admin-correction overlay (ADR-0062 §3.2 point 1). Optional so the
    // pre-#2561 unit constructions keep projecting base values.
    @Optional() private readonly effectiveFacts?: EffectiveFactsService,
  ) {}

  async search(
    actorPayerId: string,
    dto: CandidateSearchDto,
    ctx: RequestContext,
  ): Promise<CandidateSearchResponseDto> {
    const cfg = await this.matchConfig.get();
    const skillIds = expandSameLabelRoles(dto.skill_ids);
    const relatedSkillIds = relatedSkillsOf(skillIds);
    // Only a city the gazetteer recognises is a filter. Free text is refused: matching it against
    // the raw recorded value would let a caller probe spellings the card deliberately hides.
    const city = dto.city === null ? null : (canonicalCity(dto.city)?.value ?? null);
    if (dto.city !== null && city === null) {
      throw new BadRequestException("city is not a recognised city");
    }
    const fingerprint = searchFingerprint({
      skillIds,
      relatedSkillIds,
      experience: dto.experience,
      industryId: dto.industry_id,
      industryExperience: dto.industry_experience,
      city,
      strict: dto.strict,
      tierFloorMonths: cfg.tierFloorMonths,
    });
    // A position in one search's order means nothing in another's: refused before any read.
    if (dto.cursor !== null && dto.cursor.fingerprint !== fingerprint) {
      throw new BadRequestException("cursor does not belong to this search");
    }
    const cityFilter = city === null ? null : await this.cityFilterFor(city);

    const { counts, rows } = await this.repo.searchPool({
      skillIds,
      relatedSkillIds,
      experience: dto.experience === null ? null : experienceRange(dto.experience),
      industryId: dto.industry_id,
      industryExperience:
        dto.industry_experience === null ? null : experienceRange(dto.industry_experience),
      city: cityFilter,
      tierFloorMonths: cfg.tierFloorMonths,
      strict: dto.strict,
      after:
        dto.cursor === null ? null : { workerId: dto.cursor.workerId, served: dto.cursor.served },
      // One row past the page says whether there is a next one, without a second COUNT.
      limit: dto.limit + 1,
    });

    const page = rows.slice(0, dto.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > dto.limit && last
        ? encodeCandidateCursor({ fingerprint, workerId: last.workerId, served: last.position })
        : null;

    const workerIds = page.map((r) => r.workerId);
    const [levels, roles] = await Promise.all([
      this.workerSkills.listStatedTradeLevels(workerIds),
      this.repo.listWantedRoles(workerIds),
    ]);
    const levelsOf = groupByWorker(levels);
    const rolesOf = groupByWorker(roles);
    const roleFiltered = skillIds.length > 0;
    // #2561 — one batch read of live corrections for the page (no N+1), then the city overlay.
    const corrections = this.effectiveFacts
      ? await this.effectiveFacts.resolveMany(workerIds)
      : new Map();
    const candidates = page.map((row) => {
      const overrides = corrections.get(row.workerId);
      const effectiveCity = overrides
        ? (applyEffectiveFacts({ workersCity: row.currentCity, attributes: {} }, overrides)
            .workersCity as string | null)
        : row.currentCity;
      return toCandidateRow(
        overrides ? { ...row, currentCity: effectiveCity } : row,
        roleFiltered,
        rolesOf.get(row.workerId) ?? [],
        levelsOf.get(row.workerId) ?? [],
      );
    });

    const filtered =
      roleFiltered ||
      dto.experience !== null ||
      dto.industry_id !== null ||
      dto.industry_experience !== null ||
      dto.city !== null;

    await this.events.emit({
      event_name: "payer.candidate_search_performed",
      actor: { actor_type: "payer", actor_id: actorPayerId },
      subject: { subject_type: "payer", subject_id: actorPayerId },
      payload: {
        skill_ids: [...dto.skill_ids],
        experience_filtered: dto.experience !== null,
        industry_filtered: dto.industry_id !== null,
        industry_experience_filtered: dto.industry_experience !== null,
        city_filtered: dto.city !== null,
        strict: dto.strict,
        first_page: dto.cursor === null,
        result_count: candidates.length,
        matched: counts.matched,
        unrecorded: counts.unrecorded,
        total: counts.total,
        limit: dto.limit,
      },
      correlationId: ctx.correlationId,
    });
    // Counts only — never an id or a filter value in a log line.
    this.logger.log(
      `candidate search: total=${counts.total} matched=${counts.matched} unrecorded=${counts.unrecorded} page=${candidates.length}`,
    );

    return {
      total: counts.total,
      matched: counts.matched,
      unrecorded: counts.unrecorded,
      filtered,
      strict: dto.strict,
      candidates,
      nextCursor,
    };
  }

  /**
   * The options the filter controls offer. Roles, industries and buckets are the closed
   * vocabulary (static); cities are the gazetteer-canonical cities the eligible pool actually
   * records — a city nobody in the pool records is never offered (ADR-0040 §4).
   */
  async filters(): Promise<CandidateFiltersDto> {
    const roles = rolesForPicker();
    const industryIds = new Set(roles.map((r) => r.industryId));
    const cities = [
      ...new Set((await this.poolCitySpellings()).map((raw) => canonicalCity(raw)?.value ?? null)),
    ]
      .filter((c): c is string => c !== null)
      .sort((a, b) => a.localeCompare(b, "en"));
    return {
      roles,
      industries: INDUSTRIES.filter((i) => industryIds.has(i.id)).map((i) => ({
        id: i.id,
        label: i.name,
      })),
      experienceBuckets: EXPERIENCE_BUCKETS.map((b) => ({ id: b.id, label: b.label })),
      cities,
      maxRoles: CANDIDATE_SEARCH_MAX_ROLES,
    };
  }

  /**
   * The asked (canonical) city resolved against the spellings the pool records, lower-cased:
   * `matchKeys` — the canonical value and every recorded spelling that canonicalises to it
   * ("pune ", "PUNE"); `unrecognisedKeys` — recorded spellings the gazetteer does not know, which
   * the card shows as no city and the filter therefore treats as unrecorded, never as a "no".
   * Written values are canonicalised on write (`WorkersService.setLocation`), so both lists are
   * short; they exist so the filter, the offered city list and the card can never disagree.
   */
  private async cityFilterFor(
    canonical: string,
  ): Promise<{ matchKeys: string[]; unrecognisedKeys: string[] }> {
    const target = canonical.toLowerCase();
    const matchKeys = new Set<string>([target]);
    const unrecognisedKeys = new Set<string>();
    for (const raw of await this.repo.listPoolCities()) {
      const known = canonicalCity(raw)?.value;
      if (known === undefined) unrecognisedKeys.add(raw.toLowerCase());
      else if (known.toLowerCase() === target) matchKeys.add(raw.toLowerCase());
    }
    return { matchKeys: [...matchKeys], unrecognisedKeys: [...unrecognisedKeys] };
  }

  /** The facet's city spellings, read at most once per {@link POOL_CITIES_TTL_MS}. */
  private poolCitySpellings(): Promise<string[]> {
    const now = Date.now();
    if (this.poolCities && now - this.poolCities.readAt < POOL_CITIES_TTL_MS) {
      return this.poolCities.spellings;
    }
    const spellings = this.repo.listPoolCities();
    this.poolCities = { readAt: now, spellings };
    // A failed read must not be served from the cache for the rest of the window.
    spellings.catch(() => {
      if (this.poolCities?.spellings === spellings) this.poolCities = null;
    });
    return spellings;
  }
}

/**
 * The role options, ONE PER LABEL, in vocabulary order. Two vocabulary ids can share a label
 * (`mskill_3d_designer` and `mskill_cad_designer_3d` both read "3D CAD Designer"); a payer cannot
 * tell them apart, so the picker offers the first, and {@link expandSameLabelRoles} widens a
 * search for it to every id the label names.
 */
function rolesForPicker(): CandidateFiltersDto["roles"] {
  const seen = new Set<string>();
  const roles: CandidateFiltersDto["roles"] = [];
  for (const skill of MATCH_SKILLS) {
    if (skill.status !== "active" || seen.has(skill.labelEn)) continue;
    seen.add(skill.labelEn);
    roles.push({ id: skill.skillId, label: skill.labelEn, industryId: skill.industryId });
  }
  return roles;
}

/** Every active vocabulary id sharing a label with an asked id (see {@link rolesForPicker}). */
export function expandSameLabelRoles(asked: readonly string[]): string[] {
  const labels = new Set(asked.map((id) => matchSkillLabel(id)).filter((l) => l !== undefined));
  const out = new Set<string>(asked);
  for (const skill of MATCH_SKILLS) {
    if (skill.status === "active" && labels.has(skill.labelEn)) out.add(skill.skillId);
  }
  return [...out];
}

/** The curated related skills of the asked roles, minus the asked roles themselves. */
export function relatedSkillsOf(asked: readonly string[]): string[] {
  const askedSet = new Set(asked);
  const out = new Set<string>();
  for (const id of asked) {
    for (const related of relatedMatchSkills(id)) if (!askedSet.has(related)) out.add(related);
  }
  return [...out];
}

function groupByWorker<T extends { workerId: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.workerId);
    if (list) list.push(row);
    else out.set(row.workerId, [row]);
  }
  return out;
}

function labelled(skillId: string): LabelledIdDto {
  return { id: skillId, label: matchSkillLabel(skillId) ?? skillId };
}

function industryLabelled(industryId: string): LabelledIdDto {
  return { id: industryId, label: INDUSTRIES.find((i) => i.id === industryId)?.name ?? industryId };
}

/**
 * The applicant card's own badge rule (`toTradeLevelBadge` in match-candidates.service.ts, which
 * E2_CHECK item 10 keeps byte-identical): the printed rung, or the raw key when the taxonomy does
 * not know it; the trade label when it does.
 */
function toTradeLevelBadge(row: CandidateTradeLevelRow): TradeLevelBadge {
  return {
    skillId: row.skillId,
    skillLabel: matchSkillLabel(row.skillId) ?? null,
    tradeLevel: row.tradeLevel,
    tradeLevelLabel: TRADE_LEVEL_LABELS[row.tradeLevel as TradeLevel] ?? row.tradeLevel,
    levelConfirmed: row.levelConfirmed,
  };
}

/**
 * THE ONLY BUILDER OF A SEARCH ROW — the masking boundary. It reads closed-vocabulary ids, bucketed
 * months and a gazetteer city; it cannot emit anything else because nothing else reaches it.
 */
export function toCandidateRow(
  row: CandidatePoolRow,
  roleFiltered: boolean,
  wantedRoles: readonly CandidateRoleRow[],
  tradeLevels: readonly CandidateTradeLevelRow[],
): CandidateSearchRowDto {
  const otherRoles = wantedRoles
    .filter((r) => r.skillId !== row.skillId)
    .slice(0, OTHER_ROLES_ON_CARD)
    .map((r) => labelled(r.skillId));
  return {
    workerId: row.workerId,
    matchesFilters: row.matched,
    matchTier: !roleFiltered ? null : row.matchClass === 3 ? null : row.matchClass,
    role: labelled(row.skillId),
    otherRoles,
    skillMonths: row.skillMonths,
    industry: industryLabelled(row.industryId),
    industryMonths: row.industryMonths,
    city: row.currentCity === null ? null : (canonicalCity(row.currentCity)?.value ?? null),
    // Only the rung on the role the card leads with — a wanted skill by construction. A rung on a
    // trade he switched off, or on any other trade, never reaches the card (the clients print the
    // card's one rung beside `role`).
    tradeLevels: tradeLevels.filter((l) => l.skillId === row.skillId).map(toTradeLevelBadge),
    isSample: isSampleWorkerId(row.workerId),
  };
}
