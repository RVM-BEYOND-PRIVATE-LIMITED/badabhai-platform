/**
 * Catalog loading — the FAIL-CLOSED gate (ADR-0013 §A.2). Ops-edited DB catalog
 * rows are untyped until they pass `catalogSchema`. `safeParseCatalog` validates a
 * raw value and, on ANY failure, returns the DEFAULT catalog with `ok:false` — the
 * engine NEVER serves an unvalidated/garbage/negative-price catalog. The caller
 * (the NestJS pricing service) keeps a last-known-good and surfaces `ok:false` to
 * ops + audit, but pricing keeps working.
 */
import { catalogSchema, type Catalog } from "./types";
import { DEFAULT_CATALOG } from "./defaults";

/** Result of loading a catalog: the catalog to serve + whether the raw input was valid. */
export interface CatalogLoadResult {
  /** The catalog to serve — the parsed input if valid, else the safe default. */
  readonly catalog: Catalog;
  /** True if `raw` validated; false if we fell back to the default (fail-closed). */
  readonly ok: boolean;
  /** Zod error message when `ok` is false (for ops/audit; never user-facing money). */
  readonly error?: string;
}

/**
 * Validate a raw catalog value, failing closed to {@link DEFAULT_CATALOG}.
 * Pure: no I/O, no throw. A `fallback` (e.g. the last-known-good) may be supplied;
 * it defaults to the typed default seed.
 */
export function safeParseCatalog(raw: unknown, fallback: Catalog = DEFAULT_CATALOG): CatalogLoadResult {
  const parsed = catalogSchema.safeParse(raw);
  if (parsed.success) {
    return { catalog: parsed.data, ok: true };
  }
  return { catalog: fallback, ok: false, error: parsed.error.message };
}

/** Strict parse — throws on invalid input. For seed/migration tooling, NOT the serving path. */
export function parseCatalog(raw: unknown): Catalog {
  return catalogSchema.parse(raw);
}
