/**
 * THE DISCOVERY RUN — identity, input fingerprint, and the cost model.
 *
 * ===========================================================================
 * WHY A RUN IS A FIRST-CLASS THING
 * ===========================================================================
 * A candidate on its own cannot answer the question an auditor will actually ask: *"is this
 * still true?"* It was produced from a corpus, by a rule set, possibly by a model, at a
 * moment. Any of those can move, and when one does, every candidate produced before the move
 * describes a world that no longer exists — while looking exactly the same.
 *
 * The run carries those facts once, and {@link discoveryInputFingerprint} makes "has anything
 * moved?" an EQUALITY CHECK rather than a comparison of timestamps. That is the argument
 * `corpus-fingerprint.ts` already makes at length for the promotion gate, and it applies
 * here for the same reason: a timestamp answers "was this recorded after the last change we
 * know about", a fingerprint answers "was this recorded against THIS input".
 *
 * ===========================================================================
 * TWO DIGESTS, AND WHY NEITHER IS SUFFICIENT ALONE
 * ===========================================================================
 *   the CORPUS digest    catches a changed alias, a promoted skill, a new taxonomy edge, a
 *                        re-normalized domain alias. `corpus-fingerprint.ts` owns it.
 *   the LEXICON digest   catches a changed rule about what counts as an occupation head.
 *
 * Two runs that disagree about whether `fitter` is an occupation head produce different
 * candidate sets from an IDENTICAL database, and the corpus digest cannot see that at all —
 * it hashes rows, and no row moved. Conversely a lexicon that never changes says nothing
 * about the 9,121 aliases underneath it. The fingerprint is the pair.
 *
 * ===========================================================================
 * THE COST MODEL IS MEASURED, NOT GUESSED
 * ===========================================================================
 * Rates come from `apps/ai-service/app/ai/model_config.py` — the same table `cost_tracker`
 * bills against — and are restated here as constants with their source line, because a
 * `packages/db` planner cannot import Python and a number typed from memory is how an
 * estimate quietly stops matching the invoice.
 *
 * The headline finding this model exists to report: **the discovery pass over
 * `job_domain_alias` needs no embeddings at all.** All 9,121 rows already carry a real
 * `gemini-embedding-001` vector (measured 2026-08-26, single model, L2-normalized), as do all
 * 336 `skill_alias` rows. {@link estimateEmbeddingCost} therefore prices only what is
 * genuinely absent, and reports zero when nothing is.
 *
 * PURE. `createHash` only. No database, no clock — every timestamp is injected.
 */
import { createHash } from "node:crypto";

import type { CorpusFingerprint } from "./corpus-fingerprint";
import { headLexiconFingerprint, type HeadLexicon } from "./skill-discovery-heads";
import type { DiscoveryCensus } from "./skill-discovery-plan";
import type { SkillCandidateRecord } from "./skill-discovery-candidate";

// ===========================================================================
// Identity
// ===========================================================================

/**
 * Mint a run id.
 *
 * `sdr_<compact-iso>_<slug>` — readable, lexically sortable by time, and derived from inputs
 * the caller already has rather than from a random uuid. A human reading a candidate row can
 * tell when the run happened and what it was for without a join.
 */
export function discoveryRunId(startedAtIso: string, label: string): string {
  const stamp = startedAtIso.replace(/[-:]/g, "").replace(/\.\d+/, "").replace("T", "-").replace("Z", "Z");
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `sdr_${stamp}_${slug === "" ? "run" : slug}`;
}

/**
 * The input fingerprint: corpus digest + head-lexicon digest + the run's own configuration.
 *
 * CONFIGURATION IS IN THE DIGEST, and it has to be: a run with `--include-rejected` or a
 * different `maxMatches` measures a different population and produces a different candidate
 * set from identical data. Leaving it out would let two genuinely different runs claim the
 * same fingerprint, which is precisely the false equality the whole mechanism exists to
 * prevent.
 */
export function discoveryInputFingerprint(
  corpus: CorpusFingerprint,
  lexicon: HeadLexicon,
  config: Readonly<Record<string, unknown>>,
): string {
  const corpusPart = [
    corpus.skill_alias,
    corpus.skill,
    corpus.job_domain_skill,
    corpus.job_domain,
    corpus.job_domain_alias,
  ].join("\u0001");
  const configPart = Object.keys(config)
    .sort()
    .map((k) => `${k}=${JSON.stringify(config[k])}`)
    .join("\u0001");
  return createHash("sha256")
    .update([corpusPart, headLexiconFingerprint(lexicon), configPart].join("\u0002"))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Is a stored run still describing the current inputs?
 *
 * Equality or it is not fresh — no tolerance, no ordering subtlety. The cost is that a run
 * recorded before fingerprinting existed can never prove currency, which is correct and
 * deliberate: it does not carry the evidence, and backfilling one would be fabricating the
 * very proof the field exists to provide.
 */
export function runIsFresh(storedFingerprint: string, currentFingerprint: string): boolean {
  return storedFingerprint === currentFingerprint && storedFingerprint.length > 0;
}

// ===========================================================================
// Cost
// ===========================================================================

/**
 * ₹ per 1,000 INPUT tokens for `gemini-embedding-001`.
 *
 * Source: `apps/ai-service/app/ai/model_config.py:192` — `("gemini-embedding-001", (0.0125, 0.0))`.
 * Embeddings bill input only; the output rate is structurally zero, not merely unknown.
 */
export const EMBEDDING_INR_PER_1K_TOKENS = 0.0125;

/** The live embedding model, from `apps/ai-service/app/config.py:324`. */
export const EMBEDDING_MODEL = "gemini-embedding-001";

/**
 * ₹ per 1,000 tokens for the extraction model, input and output.
 *
 * Source: `apps/ai-service/app/ai/model_config.py:180` — `("gemini-2.5-flash-lite", (0.008, 0.033))`.
 * Flash-Lite is the honest default for this task: the extraction stage proposes a short label
 * and one sentence from a phrase and its evidence tokens, which is not reasoning work. A
 * caller planning a run with a more capable model passes its own rates.
 */
export const EXTRACTION_INR_PER_1K_IN = 0.008;
export const EXTRACTION_INR_PER_1K_OUT = 0.033;
export const EXTRACTION_MODEL = "gemini-2.5-flash-lite";

/**
 * Characters per token, for estimating from text length.
 *
 * DELIBERATELY CRUDE AND DELIBERATELY LOW. ~4 chars/token is the usual English figure; 3.5 is
 * used here because Hinglish transliteration tokenizes worse than English and an estimate that
 * comes in UNDER the invoice is the failure mode that matters. Every estimate this module
 * produces is labelled an estimate for the same reason.
 */
export const CHARS_PER_TOKEN = 3.5;

export interface EmbeddingCostEstimate {
  readonly model: string;
  /** Phrases that already have a stored vector — the ₹0 half. */
  readonly reused: number;
  /** Phrases with no stored vector, which a real run would have to pay for. */
  readonly to_embed: number;
  readonly estimated_tokens: number;
  readonly estimated_inr: number;
  /** Provider requests at the shipped 100-texts-per-request batch size. */
  readonly provider_requests: number;
  /** Why any spend is required at all. Empty when `to_embed` is 0. */
  readonly justification: string;
}

/**
 * Price the embeddings a run would actually need.
 *
 * `alreadyEmbedded` is the set of normalized phrases that already carry a stored vector. The
 * caller builds it from `job_domain_alias.text_norm` / `skill_alias.text_norm` WHERE
 * `embedding IS NOT NULL` — which, measured on 2026-08-26, is every row of both tables.
 */
export function estimateEmbeddingCost(
  phrases: readonly string[],
  alreadyEmbedded: ReadonlySet<string>,
): EmbeddingCostEstimate {
  const missing = phrases.filter((p) => !alreadyEmbedded.has(p));
  const chars = missing.reduce((sum, p) => sum + p.length, 0);
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
  return {
    model: EMBEDDING_MODEL,
    reused: phrases.length - missing.length,
    to_embed: missing.length,
    estimated_tokens: tokens,
    estimated_inr: Number(((tokens / 1000) * EMBEDDING_INR_PER_1K_TOKENS).toFixed(4)),
    provider_requests: Math.ceil(missing.length / 100),
    justification:
      missing.length === 0
        ? ""
        : `${missing.length} phrase(s) have no stored vector, so cosine similarity against ` +
          "the shipped skill corpus cannot be computed for them from existing data.",
  };
}

export interface ExtractionCostEstimate {
  readonly model: string;
  readonly candidates: number;
  readonly estimated_input_tokens: number;
  readonly estimated_output_tokens: number;
  readonly estimated_inr: number;
  readonly justification: string;
}

/**
 * Tokens of prompt overhead per candidate — the instruction block and the response schema,
 * amortized. An ESTIMATE, and stated as one.
 */
export const EXTRACTION_PROMPT_OVERHEAD_TOKENS = 320;
/** Tokens the model is expected to return per candidate: a label, a sentence, a confidence. */
export const EXTRACTION_OUTPUT_TOKENS = 90;

/**
 * Price the label-and-description proposal pass.
 *
 * PER CANDIDATE, NEVER PER ALIAS. That is the whole reason the deterministic layer runs
 * first: pricing this against 8,762 distinct phrases and against the far smaller cluster
 * count are different orders of magnitude, and the difference is what the clustering bought.
 */
export function estimateExtractionCost(
  candidates: readonly SkillCandidateRecord[],
): ExtractionCostEstimate {
  let inputTokens = 0;
  for (const c of candidates) {
    const payload =
      c.normalized_phrase.length +
      c.evidence_tokens.join(" ").length +
      c.sources.slice(0, 8).reduce((n, s) => n + s.original_text.length, 0) +
      c.matches.reduce((n, m) => n + m.skill_id.length + 8, 0);
    inputTokens += EXTRACTION_PROMPT_OVERHEAD_TOKENS + Math.ceil(payload / CHARS_PER_TOKEN);
  }
  const outputTokens = candidates.length * EXTRACTION_OUTPUT_TOKENS;
  const inr =
    (inputTokens / 1000) * EXTRACTION_INR_PER_1K_IN + (outputTokens / 1000) * EXTRACTION_INR_PER_1K_OUT;
  return {
    model: EXTRACTION_MODEL,
    candidates: candidates.length,
    estimated_input_tokens: inputTokens,
    estimated_output_tokens: outputTokens,
    estimated_inr: Number(inr.toFixed(4)),
    justification:
      candidates.length === 0
        ? ""
        : "A canonical LABEL and a one-sentence DESCRIPTION cannot be derived from tokens: " +
          `"strip mill" plus the head "operator" is evidence, not wording. One call per ` +
          "CANDIDATE (not per alias) proposes both; the id is still minted from the label by " +
          "`taxonomySkillIdFor`, never supplied by the model.",
  };
}

// ===========================================================================
// Review workload
// ===========================================================================

/**
 * Seconds a reviewer needs per candidate, by confidence band.
 *
 * AN ASSUMPTION, LABELLED AS ONE, and the only one in this file. It has no measurement behind
 * it because nobody has reviewed a skill candidate in this system yet. It is stated as a
 * named constant rather than folded into a formula precisely so the first real review session
 * can replace it with a measurement instead of an argument.
 */
export const REVIEW_SECONDS_BY_BAND: Readonly<Record<string, number>> = {
  high: 20,
  medium: 45,
  low: 90,
};

export interface ReviewWorkloadEstimate {
  readonly candidates: number;
  readonly by_band: Readonly<Record<string, number>>;
  readonly estimated_minutes: number;
  readonly estimated_hours: number;
  /** Decisions per hour at the assumed rates — the number a plan is actually built on. */
  readonly decisions_per_hour: number;
  readonly assumption: string;
}

export function estimateReviewWorkload(census: DiscoveryCensus): ReviewWorkloadEstimate {
  const byBand = census.candidates_by_band;
  let seconds = 0;
  for (const [band, count] of Object.entries(byBand)) {
    seconds += count * (REVIEW_SECONDS_BY_BAND[band] ?? REVIEW_SECONDS_BY_BAND.low ?? 90);
  }
  const minutes = seconds / 60;
  return {
    candidates: census.candidates,
    by_band: byBand,
    estimated_minutes: Number(minutes.toFixed(1)),
    estimated_hours: Number((minutes / 60).toFixed(2)),
    decisions_per_hour: seconds === 0 ? 0 : Number(((census.candidates / seconds) * 3600).toFixed(1)),
    assumption:
      `ESTIMATE. Assumes ${REVIEW_SECONDS_BY_BAND.high}s / ${REVIEW_SECONDS_BY_BAND.medium}s / ` +
      `${REVIEW_SECONDS_BY_BAND.low}s per high/medium/low-confidence candidate. Unmeasured — ` +
      "nobody has reviewed a skill candidate in this system yet. Replace with a measurement " +
      "after the first review session rather than defending the number.",
  };
}
