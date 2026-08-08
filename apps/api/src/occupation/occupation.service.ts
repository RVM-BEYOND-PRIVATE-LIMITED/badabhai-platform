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
import { idfOverlap, matchSpan, normalizeOccupationText } from "@badabhai/profiling-lexicon";
import { DISAMBIGUATION_ESCAPE_LABEL } from "@badabhai/config";

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
  /** `null` on the "Kuch aur" escape — the tap that resolves to no occupation. */
  readonly jobDomainId: string | null;
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

    // NORMALIZED ONCE, USED BY EVERYTHING BELOW. `trigramCandidates`' parameter is named
    // `queryNorm` and its SQL compares against `a.text_norm`, the column
    // `normalizeOccupationText` wrote. L0/L1 never needed it because `matchSpan` normalizes
    // internally — which is exactly why passing the raw utterance to L2 was invisible: the
    // two layers that run first are immune, and L2 is only reached when they miss.
    const queryNorm = normalizeOccupationText(text);

    // ── L0 / L1 — in-process, free ────────────────────────────────────────────────
    const lexical = matchSpan(snapshot.spans, text);
    if (lexical !== null) {
      for (const id of lexical.ids) consider(id, lexical.layer, 1);
    }

    let result = this.judge(byDomain, snapshot.catalogVersion, snapshot, queryNorm);
    if (result.status === "auto") return result;

    // ── NEGATIVE CACHE — a phrase we already know reaches nothing ─────────────────
    //
    // The growth queue IS the negative cache (the plan's caching table says so): a phrase
    // recorded `scope='occupation'`, still `status='open'`, is one ops has not yet turned
    // into an alias. Every worker who says it will miss again, so paying for a trigram scan
    // and possibly an ANN probe to rediscover that is pure waste on a repeated phrase.
    //
    // PROBED ONLY AFTER L0/L1 AND ONLY WHEN THEY FOUND NOTHING USABLE. A phrase can be in
    // the queue AND newly resolvable — ops adds an alias, `status` stays `open` until
    // someone closes it, and the catalogue has moved on. Letting the free layers speak first
    // means a stale queue row can never suppress a hit that now exists.
    if (byDomain.size === 0 && queryNorm.length > 0) {
      const known = await this.repo.isKnownUnresolved(queryNorm);
      if (known) {
        return {
          status: "unresolved",
          catalogVersion: snapshot.catalogVersion,
          pinned: null,
          candidates: [],
          disambiguationOptions: [],
          needsDisambiguation: false,
          embedSpent: false,
          reason: "negative cache hit — phrase is an open unresolved occupation phrase",
        };
      }
    }

    // ── L2 — trigram over the normalized alias text ───────────────────────────────
    for (const c of await this.repo.trigramCandidates(queryNorm, LAYER_FANOUT)) {
      consider(c.jobDomainId, "L2", c.rawScore);
    }
    result = this.judge(byDomain, snapshot.catalogVersion, snapshot, queryNorm);
    if (result.status === "auto") return result;

    // ── L3 — vector ANN, only when the caller already paid for the embedding ──────
    const vector = options.vector;
    if (options.allowVector !== false && vector !== undefined && vector.length > 0) {
      // Reuses `SkillsRepository.nearestDomains`: the ANN-first CTE, the measured overfetch
      // bounds and the EXPLAIN-plan test all live there already.
      for (const c of await this.skills.nearestDomains([...vector], LAYER_FANOUT)) {
        consider(c.job_domain_id, "L3", c.score);
      }
      result = this.judge(byDomain, snapshot.catalogVersion, snapshot, queryNorm);
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
    utteranceNorm = "",
  ): ResolveResult {
    // IDF OVERLAP IS THE THIRD TIE-BREAK, AND IT IS THE ONLY ONE THAT READS THE WORKER'S
    // OTHER WORDS. Confidence and layer are properties of the MATCH, so when one span is
    // claimed by several domains they are identical by construction and the remaining key
    // (the id) is arbitrary. "mistri" reaches a mason and a general repairman with exactly
    // the same evidence — but "raj mistri deewar banata hoon" contains `deewar`, which
    // belongs to masonry and not to repair. Inverse document frequency is what stops `kaam`,
    // present in hundreds of aliases, from counting as much as `deewar`.
    //
    // A TIE-BREAK ONLY: it reorders candidates that already scored equally and can never
    // lift one past a threshold. Anything stronger would be a fifth retrieval layer with no
    // calibration behind it, and the ladder has four.
    const overlap = new Map<string, number>();
    if (utteranceNorm.length > 0) {
      for (const id of byDomain.keys()) {
        overlap.set(id, idfOverlap(snapshot.spans, utteranceNorm, id));
      }
    }

    const ordered = [...byDomain.values()].sort(
      (a, b) =>
        b.confidence - a.confidence ||
        LAYER_RANK[a.layer] - LAYER_RANK[b.layer] ||
        (overlap.get(b.jobDomainId) ?? 0) - (overlap.get(a.jobDomainId) ?? 0) ||
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
   * QUALIFY FIRST, ABANDON SECOND — the plan's two-step repair. Chips are already one per
   * FAMILY, so two colliding chips are two genuinely different trades that happen to share
   * their shortest alias. The family's own `label_hi` is exactly the qualifier that
   * separates them, and it is vernacular rather than an English parent title, so it stays
   * readable for the worker being shown it. Only when qualification ALSO collides — two
   * families sharing a label, or one lacking one — is the offer abandoned for an open
   * narrowing question.
   */
  private buildOffer(
    options: readonly ScoredCandidate[],
    snapshot: NonNullable<ReturnType<OccupationIndexService["snapshot"]>>,
  ): { options: DisambiguationOption[]; abandoned: boolean; reason: string } {
    const raw: { candidate: ScoredCandidate; label: string }[] = [];
    for (const c of options) {
      const label = snapshot.domains.get(c.jobDomainId)?.chipLabel;
      if (label !== undefined) raw.push({ candidate: c, label });
    }

    const collides = new Set(
      raw.filter((r, i) => raw.findIndex((o) => o.label === r.label) !== i).map((r) => r.label),
    );
    const qualified = raw.map((r) => {
      if (!collides.has(r.label)) return r;
      const familyLabel =
        r.candidate.familyId === null
          ? null
          : (snapshot.familyLabels.get(r.candidate.familyId) ?? null);
      return familyLabel === null ? r : { candidate: r.candidate, label: familyLabel };
    });

    const seen = new Set<string>();
    for (const r of qualified) {
      if (seen.has(r.label)) {
        return {
          options: [],
          abandoned: true,
          reason: `two candidates share the chip label ${JSON.stringify(r.label)} even after family qualification; an ambiguous tap would be recorded as a deliberate answer`,
        };
      }
      seen.add(r.label);
    }

    const built: DisambiguationOption[] = qualified.map((r) => ({
      jobDomainId: r.candidate.jobDomainId,
      familyId: r.candidate.familyId,
      label: r.label,
    }));

    // THE ESCAPE, appended last and deliberately NOT counted against the four-chip cap.
    //
    // Without it the offer is a trap. A worker whose trade is not among the chips has no way
    // to say so, and the chip they tap anyway becomes their answer of record verbatim — at
    // which point a wrong tap is indistinguishable from a right one for the rest of the
    // interview. `jobDomainId: null` is what tells the caller this tap resolves to no
    // occupation and the engine must broaden instead of pinning.
    if (built.length > 0) {
      built.push({ jobDomainId: null, familyId: null, label: DISAMBIGUATION_ESCAPE_LABEL });
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
    // STORED NORMALIZED, so `isKnownUnresolved` can find it again. The probe runs on
    // `normalizeOccupationText(utterance)`; storing the raw phrase would mean the negative
    // cache never hits for the same trade said twice with different punctuation or particles
    // — and a cache that silently never hits is indistinguishable from one that works.
    //
    // Normalization also improves the ops queue: it is the same key the alias corpus uses,
    // so a promoted phrase becomes an `rvm` alias with no further editing, and repeats
    // collapse onto one counted row instead of one row per phrasing.
    const normalized = normalizeOccupationText(phrase);
    // The empty-guard matters: a phrase made entirely of particles normalizes to "" and an
    // empty key would collapse every such phrase onto one row under NULLS NOT DISTINCT.
    const stored = normalized.length > 0 ? normalized : phrase;
    const { id, count } = await this.skills.recordUnresolved(stored, null, lang, "occupation");

    // HASH ONLY. Even the pseudonymized text never rides the event spine — the same rule
    // `SkillsService.recordUnresolved` follows, and the reason its payload is `.strict()`.
    //
    // HASHED OVER THE VALUE THAT WAS STORED, not the raw argument. The hash's only purpose
    // is to let an ops consumer correlate an event back to a queue row without either of
    // them carrying the text; hashing a different string than the row holds would make that
    // correlation quietly impossible while still producing a valid-looking payload.
    const phraseHash = createHash("sha256").update(stored, "utf8").digest("hex");
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
