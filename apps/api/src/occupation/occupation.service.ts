/**
 * The retrieval ladder — the one place a worker's words become an occupation.
 *
 * L0 exact -> L1 skeleton -> L2 trigram -> L3 vector, cheapest first, stopping the moment
 * the answer is good enough to act on. The ladder is not an optimization detail: L0 and L1
 * are free and in-process, so every turn they resolve is a turn that costs nothing, and the
 * plan's economics depend on that being most of them.
 *
 * THIS SERVICE NEVER EMBEDS, AND THAT IS DELIBERATE. `apps/api` has no embedding client at
 * all — embeddings live in the ai-service behind an HTTP hop. Minting one here would add a
 * second seam to the same provider (the reuse ledger forbids exactly this) and would put a
 * network call on the chat hot path, which risk #11 rules out in as many words. So L3 runs
 * only when the CALLER already holds a vector, and `embedSpent` is always false. If no
 * vector arrives, the ladder stops at L2 — which is why the whole design insists the
 * product must work with vector retrieval switched off.
 *
 * AI NEVER OWNS THIS DECISION (CLAUDE.md §3). Nothing here calls a model. The layers are a
 * hash lookup, a hash lookup, a trigram scan and an ANN probe; the choice between their
 * results is `decide()`, which is arithmetic over a threshold. A model may later SUGGEST an
 * alias for review, but it does not pick a worker's trade.
 *
 * PRIVACY: the worker's utterance is an argument and is never stored, logged or emitted by
 * this class. Spans reaching the log are matched CATALOGUE text, not worker text.
 */
import { createHash } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import { matchSpan, normalizeOccupationText } from "@badabhai/profiling-lexicon";

import { EventsService } from "../events/events.service";

import { SkillsRepository } from "../skills/skills.repository";
import {
  calibrate,
  decide,
  MAX_DISAMBIGUATION_OPTIONS,
  type MatchDecision,
  type RetrievalLayer,
  type ScoredCandidate,
} from "./occupation-calibration";
import { OccupationIndexService } from "./occupation-index.service";
import { OccupationRepository } from "./occupation.repository";

/** How many candidates each database layer may return before calibration sees them. */
const LAYER_FANOUT = 8;

/** Layer precedence for tie-breaking. Cheaper and more exact sorts first. */
const LAYER_RANK: Record<RetrievalLayer, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

export interface ResolveOptions {
  /**
   * A query embedding the caller already has. The service does not create one — see the
   * file header. Omitted (the normal case today, since nothing is embedded yet) means the
   * ladder stops at L2.
   */
  readonly vector?: readonly number[];
  readonly allowVector?: boolean;
}

export interface ResolvedCandidate {
  readonly jobDomainId: string;
  readonly label: string;
  readonly familyId: string | null;
  readonly iscoUnitCode: string | null;
  readonly confidence: number;
  readonly layer: RetrievalLayer;
}

export interface DisambiguationOption {
  readonly jobDomainId: string;
  readonly familyId: string | null;
  /** What the worker sees and taps. Becomes their answer of record verbatim. */
  readonly label: string;
}

export type ResolveStatus = MatchDecision | "degraded";

export interface ResolveResult {
  readonly status: ResolveStatus;
  readonly catalogVersion: string | null;
  readonly pinned: ResolvedCandidate | null;
  readonly candidates: readonly ResolvedCandidate[];
  readonly disambiguationOptions: readonly DisambiguationOption[];
  readonly needsDisambiguation: boolean;
  /** Always false: this service never spends an embedding. Kept so callers can log it. */
  readonly embedSpent: boolean;
  /** Why. Logged, never shown to a worker. */
  readonly reason: string;
}

@Injectable()
export class OccupationService {
  private readonly logger = new Logger(OccupationService.name);

  constructor(
    private readonly index: OccupationIndexService,
    private readonly repo: OccupationRepository,
    private readonly skills: SkillsRepository,
    private readonly events: EventsService,
  ) {}

  /**
   * Resolve an occupation from a worker's own words.
   *
   * THE LADDER SHORT-CIRCUITS ON `auto`, NOT ON "FOUND SOMETHING". An L0 hit that has a
   * rival in another family is not good enough to pin, so the ladder keeps climbing and
   * lets L2/L3 break the tie — which is the entire reason the layers are merged before the
   * decision rather than each deciding for itself.
   */
  async resolve(text: string, options: ResolveOptions = {}): Promise<ResolveResult> {
    const snapshot = this.index.snapshot();
    if (snapshot === null) {
      // NOT "no match". The index has never built, so we know nothing about this phrase —
      // reporting it as unresolved would record a worker's real trade as an unknown one
      // and drop them to the universal pack while every dashboard looked normal.
      this.logger.error("occupation resolve attempted with no index; retrieval is degraded");
      return {
        status: "degraded",
        catalogVersion: null,
        pinned: null,
        candidates: [],
        disambiguationOptions: [],
        needsDisambiguation: false,
        embedSpent: false,
        reason: "occupation index unavailable",
      };
    }

    const byDomain = new Map<string, ScoredCandidate>();
    const consider = (jobDomainId: string, layer: RetrievalLayer, rawScore: number): void => {
      const domain = snapshot.domains.get(jobDomainId);
      if (domain === undefined) return; // indexed against a domain the snapshot cannot describe
      const confidence = calibrate(layer, rawScore);
      const existing = byDomain.get(jobDomainId);
      // Keep the STRONGEST evidence for a domain, not the last-seen. A later, cheaper-scoring
      // layer must never overwrite an exact hit.
      if (existing !== undefined && existing.confidence >= confidence) return;
      byDomain.set(jobDomainId, {
        jobDomainId,
        familyId: domain.familyId,
        confidence,
        layer,
      });
    };

    // ── L0 / L1 — in-process, free ────────────────────────────────────────────────
    const lexical = matchSpan(snapshot.spans, text);
    if (lexical !== null) {
      for (const id of lexical.ids) consider(id, lexical.layer, 1);
    }

    let result = this.judge(byDomain, snapshot.catalogVersion, snapshot);
    if (result.status === "auto") return result;

    // ── L2 — trigram over the normalized alias text ───────────────────────────────
    //
    // NORMALIZED HERE, and it has to be. `trigramCandidates`' parameter is named `queryNorm` and
    // its SQL compares against `a.text_norm`, the column `normalizeOccupationText` wrote. L0/L1
    // never needed this because `matchSpan` normalizes internally — which is exactly why passing
    // the raw utterance here was invisible: the two layers that run first are immune, and L2 is
    // only reached when they miss. For any conversational sentence ("kapde silne ka kaam karta
    // hun") that is EVERY time, so the ladder's only fuzzy layer returned nothing for precisely
    // the inputs it exists to catch.
    const queryNorm = normalizeOccupationText(text);
    for (const c of await this.repo.trigramCandidates(queryNorm, LAYER_FANOUT)) {
      consider(c.jobDomainId, "L2", c.rawScore);
    }
    result = this.judge(byDomain, snapshot.catalogVersion, snapshot);
    if (result.status === "auto") return result;

    // ── L3 — vector ANN, only when the caller already paid for the embedding ──────
    const vector = options.vector;
    if (options.allowVector !== false && vector !== undefined && vector.length > 0) {
      // Reuses `SkillsRepository.nearestDomains`: the ANN-first CTE, the measured overfetch
      // bounds and the EXPLAIN-plan test all live there already.
      for (const c of await this.skills.nearestDomains([...vector], LAYER_FANOUT)) {
        consider(c.job_domain_id, "L3", c.score);
      }
      result = this.judge(byDomain, snapshot.catalogVersion, snapshot);
    }

    return result;
  }

  /**
   * Order the accumulated candidates and put them to the decision function.
   *
   * SORTED HERE, NEVER INSIDE `decide()`. That function documents that it does not re-sort
   * because the caller's order also carries layer precedence — so producing that order is
   * this method's job. Confidence first, then the cheaper/more exact layer, then the id, so
   * two API instances with the same evidence always offer the same chips.
   */
  private judge(
    byDomain: ReadonlyMap<string, ScoredCandidate>,
    catalogVersion: string,
    snapshot: NonNullable<ReturnType<OccupationIndexService["snapshot"]>>,
  ): ResolveResult {
    const ordered = [...byDomain.values()].sort(
      (a, b) =>
        b.confidence - a.confidence ||
        LAYER_RANK[a.layer] - LAYER_RANK[b.layer] ||
        a.jobDomainId.localeCompare(b.jobDomainId),
    );

    const decision = decide(ordered);
    const describe = (c: ScoredCandidate): ResolvedCandidate => {
      const d = snapshot.domains.get(c.jobDomainId);
      return {
        jobDomainId: c.jobDomainId,
        label: d?.chipLabel ?? c.jobDomainId,
        familyId: c.familyId,
        iscoUnitCode: d?.iscoUnitCode ?? null,
        confidence: c.confidence,
        layer: c.layer,
      };
    };

    const offer = this.buildOffer(decision.options, snapshot);

    return {
      status: offer.abandoned ? "unresolved" : decision.decision,
      catalogVersion,
      pinned: decision.pinned === null ? null : describe(decision.pinned),
      candidates: ordered.slice(0, MAX_DISAMBIGUATION_OPTIONS * 2).map(describe),
      disambiguationOptions: offer.options,
      needsDisambiguation: !offer.abandoned && decision.decision === "disambiguate",
      reason: offer.abandoned ? `${decision.reason}; ${offer.reason}` : decision.reason,
      embedSpent: false,
    };
  }

  /**
   * Turn the chosen candidates into chips, or refuse to.
   *
   * TWO IDENTICAL CHIPS ARE WORSE THAN NO CHIPS. The label the worker taps becomes their
   * answer of record verbatim, so offering "mistri" twice asks them to choose between two
   * things that read as the same thing and records whichever they hit as a deliberate
   * answer. When that happens the offer is ABANDONED and the caller falls back to an open
   * narrowing question — which for a genuinely ambiguous word like "mistri" is the honest
   * product answer, not a degraded one.
   *
   * The plan's preferred repair — qualifying the duplicate from a parent label — needs a
   * vernacular qualifier this snapshot does not carry. `label_hi` exists on FAMILIES (Phase
   * 2 minted it there rather than on 4,071 domains), so the repair is to widen the snapshot
   * with family labels. Deliberately not done blind here: qualifying a Hindi chip with an
   * English parent title would be worse for a low-literacy reader than asking a question.
   */
  private buildOffer(
    options: readonly ScoredCandidate[],
    snapshot: NonNullable<ReturnType<OccupationIndexService["snapshot"]>>,
  ): { options: DisambiguationOption[]; abandoned: boolean; reason: string } {
    const built: DisambiguationOption[] = [];
    const labels = new Set<string>();
    for (const c of options) {
      const label = snapshot.domains.get(c.jobDomainId)?.chipLabel;
      if (label === undefined) continue;
      if (labels.has(label)) {
        return {
          options: [],
          abandoned: true,
          reason: `two candidates share the chip label ${JSON.stringify(label)}; offering both would record an ambiguous tap as a deliberate answer`,
        };
      }
      labels.add(label);
      built.push({ jobDomainId: c.jobDomainId, familyId: c.familyId, label });
    }
    return { options: built, abandoned: false, reason: "" };
  }

  /**
   * Record a trade phrase that reached no layer, and emit the hash-only event.
   *
   * THE PHRASE MUST ALREADY BE PSEUDONYMIZED, and this service cannot do it — the
   * pseudonymizer lives in the ai-service, behind HTTP. So this is a SEPARATE call rather
   * than something `resolve()` does for itself: auto-recording would write the worker's raw
   * utterance into a table whose entire contract is "pseudonymized text only" (SG-1), and it
   * would do so silently, on the hot path, for every unmatched turn.
   *
   * `scope: "occupation"` is what keeps this out of the skill growth queue. Same table
   * (migration 0070 widened it rather than minting a second one), different queue: "fitter"
   * can be an open skill gap and an open occupation gap at once, and resolving one must not
   * close the other.
   *
   * `domainId` is NULL: an occupation miss is not scoped to a skill domain. The unique
   * index's NULLS NOT DISTINCT is what still collapses repeats onto one counted row.
   */
  async recordUnresolved(phrase: string, lang: string): Promise<{ count: number }> {
    const { id, count } = await this.skills.recordUnresolved(phrase, null, lang, "occupation");
    // HASH ONLY. Even the pseudonymized text never rides the event spine — the same rule
    // `SkillsService.recordUnresolved` follows, and the reason its payload is `.strict()`.
    const phraseHash = createHash("sha256").update(phrase, "utf8").digest("hex");
    await this.events.emit({
      event_name: "occupation.phrase_unresolved",
      actor: { actor_type: "ai_service", actor_id: null },
      subject: { subject_type: "occupation_phrase", subject_id: id },
      payload: { phrase_hash: phraseHash, lang, count },
      // Keyed on the row AND its count, so an at-least-once retry of the same occurrence
      // does not double-emit while a genuine second occurrence still does.
      idempotencyKey: `occupation.phrase_unresolved:${id}:${count}`,
    });
    return { count };
  }

  /** Catalogue metadata for one occupation, from the in-process snapshot. */
  describeDomain(jobDomainId: string): {
    jobDomainId: string;
    labelEn: string;
    labelHi: string | null;
    label: string;
    iscoUnitCode: string | null;
    familyId: string | null;
    catalogVersion: string;
  } | null {
    const snapshot = this.index.snapshot();
    const domain = snapshot?.domains.get(jobDomainId);
    if (snapshot === undefined || snapshot === null || domain === undefined) return null;
    return {
      jobDomainId: domain.jobDomainId,
      labelEn: domain.labelEn,
      labelHi: domain.labelHi,
      label: domain.chipLabel,
      iscoUnitCode: domain.iscoUnitCode,
      familyId: domain.familyId,
      catalogVersion: snapshot.catalogVersion,
    };
  }
}
