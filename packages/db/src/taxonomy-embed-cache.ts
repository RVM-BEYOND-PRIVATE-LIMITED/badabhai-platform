/**
 * A content-addressed embedding cache for the offline taxonomy experiments.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * The candidate-alias simulation embeds every fixture query plus every candidate — 232 texts
 * — and the ai-service sends ONE TEXT PER REQUEST on this endpoint. So a single experiment
 * run costs 232 provider REQUESTS, against a per-day request quota. Phase 8 exhausted that
 * quota mid-run and the harness could not finish, which is a poor property for a tool whose
 * whole purpose is to be re-run cheaply while a candidate set is iterated on.
 *
 * Note the asymmetry that makes this specific to the experiments: the corpus embedder batches
 * 100 texts into one request, so 9,121 aliases cost ~92 requests. The experiment harness
 * embedding 232 texts costs 232. The per-day ceiling is reached by the small job, not the
 * large one.
 *
 * ===========================================================================
 * WHY CACHING IS SOUND HERE AND NOT A SHORTCUT
 * ===========================================================================
 * The embedder is deterministic for a given model: embedding the text of a stored alias
 * reproduces that alias's stored vector at cosine 1.0000 (measured, see
 * `assertExactSimulationHolds`). So a cached vector is not a stale approximation of the
 * current answer — it IS the current answer, for as long as the model is the same.
 *
 * The model id is therefore part of the cache key rather than a field inside the value. A
 * model change must produce a MISS, not a hit against a vector from a different space; keying
 * on text alone would silently mix two geometries and every cosine computed across them would
 * be meaningless while looking entirely normal.
 *
 * ===========================================================================
 * WHY IT IS NOT COMMITTED
 * ===========================================================================
 * The cache holds hundreds of 768-float vectors — megabytes of derived data that can be
 * regenerated from the provider at any time. It is a local cost optimisation, not evidence.
 * The evidence is the experiment record, which IS committed. Keeping the cache out of the
 * repository also keeps a reviewer from mistaking cached vectors for a measurement.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Default on-disk location. Gitignored: derived data, not evidence. */
export const DEFAULT_CACHE_DIR = join(__dirname, "..", ".embed-cache");

export interface EmbedCacheStats {
  /** Texts served without touching the provider. */
  hits: number;
  /** Texts that required a live provider request. */
  misses: number;
}

export interface EmbedCache {
  embed(text: string): Promise<number[]>;
  stats(): EmbedCacheStats;
  flush(): void;
}

/** Model is part of the key so a model change misses instead of mixing vector spaces. */
export function cacheKey(model: string, text: string): string {
  return `${model}:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export interface EmbedCacheOptions {
  model: string;
  dir?: string;
  /** Fetches a vector for one text. Injected so the cache is testable without a network. */
  fetchVector: (text: string) => Promise<number[]>;
  /**
   * Refuse to call the provider at all. Used when the daily quota is known to be exhausted:
   * a miss then fails loudly rather than stalling for two minutes of backoff per text and
   * finishing with a partial result that looks complete.
   */
  offline?: boolean;
}

export function createEmbedCache(opts: EmbedCacheOptions): EmbedCache {
  const dir = opts.dir ?? DEFAULT_CACHE_DIR;
  const file = join(dir, "vectors.json");
  const store: Record<string, number[]> = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, number[]>)
    : {};
  let hits = 0;
  let misses = 0;
  let dirty = false;

  return {
    async embed(text: string): Promise<number[]> {
      const k = cacheKey(opts.model, text);
      const hit = store[k];
      if (hit !== undefined) {
        hits += 1;
        return hit;
      }
      if (opts.offline === true) {
        throw new Error(
          `[embed-cache] OFFLINE and no cached vector for ${JSON.stringify(text.slice(0, 60))} ` +
            `under model ${opts.model}. Refusing to report a partial simulation as a complete ` +
            `one. Re-run without --offline once provider quota is available.`,
        );
      }
      const v = await opts.fetchVector(text);
      store[k] = v;
      misses += 1;
      dirty = true;
      return v;
    },
    stats: () => ({ hits, misses }),
    flush(): void {
      if (!dirty) return;
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(store), "utf8");
    },
  };
}
