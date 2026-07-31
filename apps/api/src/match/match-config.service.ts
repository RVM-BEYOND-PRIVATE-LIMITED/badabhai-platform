import { Injectable, Logger } from "@nestjs/common";
import {
  MatchConfigSchema,
  parseMatchConfig,
  DEFAULT_MATCH_CONFIG,
  type MatchConfig,
} from "@badabhai/match-engine";
import { MatchConfigRepository } from "./match-config.repository";

/** The active config + its provenance (mirrors `ActiveCatalog` in the pricing service). */
export interface ActiveMatchConfig {
  readonly config: MatchConfig;
  readonly revision: number;
  /** "db" = a valid stored row; "default" = no row OR an invalid row (fail-closed). */
  readonly source: "db" | "default";
}

/**
 * How long a loaded config is reused before the row is re-read. Short on purpose: an
 * ops edit to `tier_floor_months` should take effect within a page refresh, and the
 * read it saves is one indexed single-row select. It is a constant rather than a dial
 * because it governs CACHING, not MATCHING — no ordering, threshold or price depends
 * on it, so it is not the kind of value spec Part 5 says must never be hard-coded.
 */
const CACHE_TTL_MS = 30_000;

/**
 * The ONE place `apps/api` learns any Matching V1 number (ADR-0036 §8, spec Part 5:
 * "Config, never code").
 *
 * Shaped exactly like {@link ../pricing/pricing.service.ts PricingService}: load the
 * single active row, validate it at the boundary, FAIL CLOSED to the typed defaults,
 * and surface the fallback as `source: "default"` rather than hiding it.
 *
 * `parseMatchConfig` never throws — an unparseable row yields `DEFAULT_MATCH_CONFIG`
 * whole, not field-by-field. That is deliberate (see `packages/match-engine/config.ts`):
 * a config where one field is garbage is a config nobody reviewed, and taking the good
 * half of it would ship an ordering nobody signed off.
 *
 * NO MATCHING CONSTANT MAY BE HARD-CODED ANYWHERE ELSE IN apps/api. Every consumer —
 * the reach resolver, the feed, the apply snapshot, the candidate list, the boost
 * supply gate, the free-tier grant — reads its numbers from here.
 *
 * PII-free: integers and enum strings only. Invariant #4: these are deterministic rule
 * parameters; no LLM writes or reads them.
 */
@Injectable()
export class MatchConfigService {
  private readonly logger = new Logger(MatchConfigService.name);

  /** The last successful load + when it was taken. Cleared by {@link invalidate}. */
  private cached: { value: ActiveMatchConfig; loadedAtMs: number } | null = null;
  /**
   * The in-flight load, if any. Without this, N concurrent feed requests on a cold
   * cache each issue their own SELECT; with it they share one round-trip.
   */
  private inFlight: Promise<ActiveMatchConfig> | null = null;

  constructor(private readonly repo: MatchConfigRepository) {}

  /** The active config + provenance, cached for {@link CACHE_TTL_MS}. */
  async getActive(): Promise<ActiveMatchConfig> {
    const now = Date.now();
    const cached = this.cached;
    if (cached !== null && now - cached.loadedAtMs < CACHE_TTL_MS) return cached.value;

    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.load()
      .then((value) => {
        this.cached = { value, loadedAtMs: Date.now() };
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /**
   * Just the validated knobs — the call every consumer actually makes.
   *
   * A DB error here must never take down the feed: the config is a set of thresholds,
   * and the typed defaults ARE the shipped V1 values. So an unreachable database
   * degrades to `DEFAULT_MATCH_CONFIG` loudly (one error log) rather than 500-ing a
   * worker's feed over a knob lookup.
   */
  async get(): Promise<MatchConfig> {
    try {
      return (await this.getActive()).config;
    } catch (err) {
      const cls = err instanceof Error ? err.name : "UnknownError";
      this.logger.error(`match_config load failed (${cls}); serving the typed defaults`);
      return DEFAULT_MATCH_CONFIG;
    }
  }

  /** Drop the cache — used by tests and by any future ops write path. */
  invalidate(): void {
    this.cached = null;
  }

  private async load(): Promise<ActiveMatchConfig> {
    const row = await this.repo.getActive();
    if (!row) {
      // Legitimate before D1 runs. Not an error — the defaults ARE the shipped values.
      return { config: DEFAULT_MATCH_CONFIG, revision: 0, source: "default" };
    }
    // `parseMatchConfig` is the VALUE path (never throws, fails closed whole-object).
    // The schema is re-run only to answer "did it fall back?" for the log + provenance:
    // inferring that from the returned value would mean comparing against the defaults,
    // which cannot distinguish "the row IS the defaults" from "the row was garbage".
    const valid = MatchConfigSchema.safeParse(row.config).success;
    const config = parseMatchConfig(row.config);
    if (!valid) {
      // A stored row that fails validation is NEVER served — fail closed to the typed
      // defaults and make it loud (ops + logs), but keep matching working.
      this.logger.error(
        `active match_config revision=${row.revision} FAILED validation; serving the typed defaults (fail-closed)`,
      );
      return { config: DEFAULT_MATCH_CONFIG, revision: row.revision, source: "default" };
    }
    return { config, revision: row.revision, source: "db" };
  }
}
