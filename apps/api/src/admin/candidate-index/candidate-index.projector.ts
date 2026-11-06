import { Injectable, Logger, Inject } from "@nestjs/common";
import { getRole } from "@badabhai/taxonomy";
import { decryptWorkerName } from "../../common/worker-name-read";
// VALUE import (not `import type`): Nest resolves this ctor param from
// design:paramtypes metadata, which a type-only import erases to Object —
// booting the API then fails resolving the projector (E2E caught it on #2557).
import { PiiCryptoService } from "../../common/pii-crypto.service";
import { AdminCandidateDetailRepository } from "../admin-candidate-detail.repository";
import { WorkerAttributesRepository } from "../../profiles/worker-attributes.repository";
import { WorkerLanguagesRepository } from "../../profiles/worker-languages.repository";
import { WorkerQualificationsRepository } from "../../profiles/worker-qualifications.repository";
import {
  resolveAvailabilityStateWithSource,
  resolveCityForSummaryWithSource,
  resolveSalaryBandWithSource,
  resolveSalaryPeriodWithSource,
} from "../../profiles/worker-field-precedence";
import { attributeSourceOf, profileRowSource } from "../../workers/profile-field-sources";
import { readProfileFormFacts } from "../../workers/profile-form-facts";
import { resolveTradeContent } from "../../resume/trade-content";
import { toProfileSummary } from "../../workers/profile-summary.mapper";
import { WorkersRepository } from "../../workers/workers.repository";
import { readPreferenceFacts } from "../../resume/resume-preference-facts";
import { qualificationFactsFrom } from "../../resume/resume-qualification-rows";
import { applyEffectiveFacts, resolveEffectiveFacts } from "./resolve-effective-facts";
import { NameTokenService } from "./name-token.service";
import { CandidateIndexRepository } from "./candidate-index.repository";

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function scalar(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One search-doc token: lowercased, whitespace-collapsed. The canonical fold
 * for `search_doc` — the later Candidates search side reproduces it
 * byte-for-byte when folding a typed term. Labels are already canonical
 * taxonomy/gazetteer strings; the fold only normalises case and spacing (never
 * stems, never drops words).
 */
export function foldSearchToken(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The B4 projector (design: ADR-0062 §3.5 + §7).
 *
 * `projectWorker` loads one worker through the SAME repositories and pure
 * resolvers the employer-facing reads run — `toProfileSummary` (exactly as
 * `WorkersService.getProfileSummary` calls it), the `...WithSource` precedence
 * resolvers (exactly as `toCandidateDetail` calls them), `readPreferenceFacts`
 * / `qualificationFactsFrom` / `languageFacts` — and upserts the
 * `admin_candidate_index` row. It arranges values; it never re-implements a
 * precedence rule.
 *
 * Correction overlay (#2561 seam): the overlay-able inputs (worker city, the
 * attribute bag, the salary container) pass through
 * {@link applyEffectiveFacts} — identity today, extended per fact key by #2561.
 *
 * PII discipline: the decrypted name exists IN MEMORY ONLY for tokenisation
 * (the named decrypt site); phone/email/photo/answer values never enter this
 * process beyond the columns the row stores (`phone_hash` copy, folded
 * labels). Output carries ids, column names and counts only.
 */
@Injectable()
export class CandidateIndexProjector {
  private readonly logger = new Logger(CandidateIndexProjector.name);

  constructor(
    private readonly workers: WorkersRepository,
    private readonly attributes: WorkerAttributesRepository,
    private readonly qualifications: WorkerQualificationsRepository,
    private readonly languages: WorkerLanguagesRepository,
    private readonly detail: AdminCandidateDetailRepository,
    private readonly index: CandidateIndexRepository,
    // Explicit token (not bare type resolution): the token reference forces the
    // value import above at compile time, so an `import type` regression that
    // erases the design:paramtypes entry — and fails API boot — cannot recur.
    @Inject(PiiCryptoService) private readonly pii: PiiCryptoService,
    private readonly nameTokens: NameTokenService,
  ) {}

  /**
   * Project one worker. Idempotent — re-projection converges. Returns `false`
   * (no write) when the worker row is gone (erased mid-tick; the FK cascade
   * owns that row's removal, not this).
   */
  async projectWorker(workerId: string): Promise<boolean> {
    const [
      worker,
      profile,
      tradeSheet,
      provenance,
      qualificationRows,
      languageRows,
      jobDomain,
      matchSkills,
      tenure,
      resumes,
      account,
      costTotal,
      referralSource,
      nameToken,
    ] = await Promise.all([
      this.workers.findById(workerId),
      this.workers.latestProfile(workerId),
      this.attributes.loadTradeSheet(workerId),
      this.detail.attributeProvenance(workerId),
      this.qualifications.loadForResume(workerId),
      this.languages.loadForResume(workerId),
      this.detail.currentJobDomain(workerId),
      this.detail.matchSkills(workerId),
      this.detail.industryTenure(workerId),
      this.detail.resumeVersions(workerId, 1),
      this.detail.account(workerId),
      this.index.readAiCostTotal(workerId),
      this.index.readReferralSource(workerId),
      this.workers.findFullNameToken(workerId),
    ]);
    if (!worker) return false;

    // #2561 seam: the overlay-able inputs, through the (today identity) overlay.
    const effective = applyEffectiveFacts(
      {
        workersCity: worker.currentCity as unknown,
        attributes: tradeSheet.attributes as unknown,
        salaryContainer: (profile as unknown as { salaryExpectation?: unknown } | undefined)
          ?.salaryExpectation as unknown,
      },
      await resolveEffectiveFacts(workerId),
    );
    const attributes = (effective.attributes ?? {}) as Json;
    const workersCity = typeof effective.workersCity === "string" ? effective.workersCity : null;

    // The worker's self-view summary, built exactly as getProfileSummary builds it.
    const summary = toProfileSummary(
      profile
        ? {
            ...profile,
            hasPhoto:
              typeof worker.photoStorageKey === "string" && worker.photoStorageKey.length > 0,
            workerCity: workersCity,
            formFacts: readProfileFormFacts(tradeSheet),
          }
        : null,
    );
    const prefs = readPreferenceFacts(attributes);
    const facts = qualificationFactsFrom({
      ...qualificationRows,
      languages: languageRows,
    });
    const provenanceByKey = new Map(provenance.map((p) => [p.attributeKey, p]));
    const attrSource = (key: string): ReturnType<typeof attributeSourceOf> =>
      attributeSourceOf(provenanceByKey.get(key));
    const profileSource = profileRowSource(profile);

    const location = asObject(profile?.locationPreference);
    const salaryContainer = asObject(effective.salaryContainer);
    const city = resolveCityForSummaryWithSource(
      {
        workersColumn: workersCity,
        profileCurrentCity: scalar(location?.current_city),
        profilePreferredCities: stringList(location?.preferred_cities),
      },
      { workersColumn: "worker_edit", profile: profileSource },
    );
    const band = resolveSalaryBandWithSource({
      container: {
        amountMin: finiteNumber(salaryContainer?.amount_min),
        amountMax: finiteNumber(salaryContainer?.amount_max),
      },
      containerSource: profileSource,
      attributes: { expected: prefs.salaryMin, expectedMax: prefs.salaryMax },
      attributeSources: {
        expected: attrSource("salary_expected_min"),
        expectedMax: attrSource("salary_expected_max"),
      },
    });
    const period = resolveSalaryPeriodWithSource(
      scalar(attributes.salary_period),
      attrSource("salary_period"),
    );
    const availability = resolveAvailabilityStateWithSource(
      {
        workerAnswer: asObject(attributes.availability),
        legacyStatus: scalar(asObject(profile?.availability)?.status ?? profile?.availability),
      },
      { workerAnswer: attrSource("availability"), legacy: profileSource },
    );

    // The résumé's rule: the language rows' lines win, else the `languages` attribute.
    const languageLabels =
      facts?.languages ?? (prefs.languages.length > 0 ? prefs.languages : []);
    const skillLabels = summary.skills;
    const machineLabels = summary.machines;
    const searchDoc = [
      ...(summary.trade.display_name ? [summary.trade.display_name] : []),
      tradeLabelOf(summary.trade.canonical_trade_id),
      roleLabelOf(summary.trade.canonical_role_id),
      ...(jobDomain?.label ? [jobDomain.label] : []),
      city.value ?? "",
      ...skillLabels,
      ...machineLabels,
      ...languageLabels,
    ]
      .filter((s): s is string => typeof s === "string")
      .map((s) => foldSearchToken(s))
      .filter((s) => s !== "")
      .join(" ");

    // Lead skill's bucketed months (matchSkills arrive most-months-first), else
    // the largest industry tenure, else null.
    const roleMonths =
      matchSkills[0]?.monthsBucketed ??
      tenure.reduce<number | null>(
        (max, t) => (max === null || t.calendarMonths > max ? t.calendarMonths : max),
        null,
      );

    const latestResume = resumes.rows[0] ?? null;
    const consent = account.consent;
    const employerSharing =
      consent !== null &&
      consent.revokedAt === null &&
      consent.purposes.includes("employer_sharing");

    const nameRead = decryptWorkerName(nameToken, this.pii);
    const tokens =
      nameRead.ok && nameRead.name !== null
        ? this.nameTokens.tokenise(nameRead.name)
        : { hashes: [], kid: null };

    await this.index.upsertRow({
      workerId,
      status: worker.status,
      flagged: account.flag !== null,
      isTestAccount: worker.isTestAccount,
      deletionScheduledAt: worker.deletionScheduledAt,
      employerSharingConsent: employerSharing,
      currentCity: city.value,
      currentState: worker.currentState,
      canonicalTradeId: summary.trade.canonical_trade_id,
      canonicalRoleId: summary.trade.canonical_role_id,
      jobDomainId: jobDomain?.jobDomainId ?? null,
      tradeLabel: tradeLabelOf(summary.trade.canonical_trade_id),
      roleLabel: roleLabelOf(summary.trade.canonical_role_id),
      domainLabel: jobDomain?.label ?? null,
      totalExperienceYears:
        summary.experience_years === null ? null : String(summary.experience_years),
      roleExperienceMonths: roleMonths,
      salaryMinInr: band.value === null ? null : String(band.value.low),
      salaryMaxInr: band.value?.high === null || band.value?.high === undefined ? null : String(band.value.high),
      salaryPeriod: period.value,
      availabilityStatus: availability.value.status,
      shiftPreference: prefs.shiftLabel,
      formLevel: account.formLevel,
      skills: skillLabels,
      languages: languageLabels,
      educationLevel: summary.education_level,
      resumeCount: resumes.total,
      latestResumeStatus: latestResume?.renderStatus ?? null,
      latestResumeVersion: latestResume?.version ?? null,
      profileStatus: summary.profile_status,
      profileSource: summary.source,
      appVersion: account.latestAppVersion,
      lastActiveAt: account.lastSeenAt,
      createdAt: worker.createdAt,
      updatedAt: worker.updatedAt,
      aiCostInr: costTotal,
      referralSource,
      searchDoc,
      nameTokenHashes: tokens.hashes,
      nameTokenKeyId: tokens.kid,
      phoneHash: worker.phoneHash,
    });
    return true;
  }

  /** Compare the stored row with a fresh projection — the drift check's one-worker unit. */
  async driftForWorker(workerId: string): Promise<{ drifted: boolean; columns: string[] }> {
    const stored = await this.index.readRow(workerId);
    if (!stored) return { drifted: true, columns: ["<missing>"] };
    // Re-project (writes the converged row), then diff what changed.
    await this.projectWorker(workerId);
    const fresh = await this.index.readRow(workerId);
    if (!fresh) return { drifted: true, columns: ["<vanished>"] };
    const columns: string[] = [];
    for (const key of Object.keys(fresh) as (keyof typeof fresh)[]) {
      if (key === "projectedAt") continue;
      if (!sameStoredValue(stored[key], fresh[key])) columns.push(key);
    }
    if (columns.length > 0) {
      this.logger.warn(`candidate-index drift worker=${workerId.slice(0, 8)} columns=${columns.join(",")}`);
    }
    return { drifted: columns.length > 0, columns };
  }
}

/**
 * Resolved trade label — the authored trade-content fallback, the same resolver
 * `readDisplayName` (profile-summary.mapper) consults after the taxonomy role.
 * Null ids never reach the resolver.
 */
function tradeLabelOf(tradeId: string | null): string | null {
  if (!tradeId) return null;
  try {
    return resolveTradeContent(null, tradeId)?.display_name ?? null;
  } catch {
    return null;
  }
}

/** Resolved role label — the taxonomy role name, as the employer reads serve. */
function roleLabelOf(roleId: string | null): string | null {
  if (!roleId) return null;
  try {
    return getRole(roleId)?.name ?? null;
  } catch {
    return null;
  }
}

/** Stored-vs-fresh comparison that tolerates driver formatting (numeric strings, Dates). */
function sameStoredValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : new Date(a as string).getTime();
    const tb = b instanceof Date ? b.getTime() : new Date(b as string).getTime();
    return ta === tb;
  }
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : [];
    const bb = Array.isArray(b) ? b : [];
    return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
  }
  return a === b;
}
