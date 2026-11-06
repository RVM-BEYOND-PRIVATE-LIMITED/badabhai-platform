/**
 * ADR-0062 §3.2 — the PURE overlay applied by every read of an editable fact. The caller resolves
 * the live admin corrections (`EffectiveFactsService`) and hands them in with the base inputs; a
 * key this file cannot apply THROWS rather than being silently ignored, because a correction that
 * never reaches a display is worse than a loud failure.
 *
 * PR 1 (#2561) applies the LOCATION group. The salary keys are deliberately handled at the
 * precedence layer instead (`resolveSalaryBandWithSource`'s `override`, above the DraftProfile
 * container); the remaining groups are opened by PR 2, which extends this switch — the fail-closed
 * default is what forces that edit to be explicit.
 */
export type EffectiveFactKey = string;

export interface EffectiveOverlayInputs extends Record<string, unknown> {
  /** `workers.current_city`. */
  workersCity?: unknown;
  /** The worker's attribute bag (`worker_attributes` as a value map). */
  attributes?: unknown;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function applyEffectiveFacts<T extends EffectiveOverlayInputs>(
  inputs: T,
  overrides: ReadonlyMap<EffectiveFactKey, unknown>,
): T {
  if (overrides.size === 0) return inputs;
  const next: EffectiveOverlayInputs = { ...inputs };
  for (const [key, value] of overrides) {
    switch (key) {
      case "current_city": {
        if (typeof value !== "string") {
          throw new Error(`admin correction current_city is not a string (worker overlay)`);
        }
        next.workersCity = value;
        break;
      }
      case "preferred_locations": {
        if (!isStringArray(value)) {
          throw new Error(`admin correction preferred_locations is not a string[]`);
        }
        next.attributes = {
          ...((inputs.attributes as Record<string, unknown> | undefined) ?? {}),
          // The attribute key the worker-preference reader uses; the wire/DTO name is
          // `preferred_cities`, but the store key is `preferred_locations` (ADR-0062 §4).
          preferred_locations: [...value],
        };
        break;
      }
      default:
        throw new Error(
          `unhandled effective-fact override (extend applyEffectiveFacts): ${key}`,
        );
    }
  }
  return next as T;
}
