/**
 * ADR-0062 §3.2 — the PURE overlay applied by every read of an editable fact. The caller resolves
 * the live admin corrections (`EffectiveFactsService`) and hands them in with the base inputs; a
 * key this file cannot apply THROWS rather than being silently ignored, because a correction that
 * never reaches a display is worse than a loud failure.
 *
 * PR 1 (#2561) applies the LOCATION group. PR 2 adds the profile-column group that the read
 * table builds its summary from (trade, role, skills, total experience). The salary keys are
 * deliberately handled at the precedence layer instead (`resolveSalaryBandWithSource`'s
 * `override`, above the DraftProfile container), and the table-backed groups (work history,
 * qualifications, languages, preferences) are written through their domain store, which every
 * reader already consults — an explicit no-op here keeps the fail-closed default meaningful
 * without pretending the overlay owns a value the store now holds.
 */
export type EffectiveFactKey = string;

export interface EffectiveOverlayInputs extends Record<string, unknown> {
  /** `workers.current_city`. */
  workersCity?: unknown;
  /** The worker's attribute bag (`worker_attributes` as a value map). */
  attributes?: unknown;
  /** `worker_profiles.canonical_trade_id` / `canonical_role_id`. */
  canonicalTradeId?: unknown;
  canonicalRoleId?: unknown;
  /** `worker_profiles.skills` / `experience`. */
  skills?: unknown;
  experience?: unknown;
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
      case "trade": {
        if (value !== null && typeof value !== "string") {
          throw new Error(`admin correction trade is not a string (worker overlay)`);
        }
        next.canonicalTradeId = value;
        break;
      }
      case "role": {
        if (value !== null && typeof value !== "string") {
          throw new Error(`admin correction role is not a string (worker overlay)`);
        }
        next.canonicalRoleId = value;
        break;
      }
      case "skills": {
        if (!isStringArray(value)) {
          throw new Error(`admin correction skills is not a string[]`);
        }
        next.skills = [...value];
        break;
      }
      case "experience": {
        const base =
          typeof inputs.experience === "object" && inputs.experience !== null
            ? (inputs.experience as Record<string, unknown>)
            : {};
        next.experience = { ...base, total_years: value };
        break;
      }
      case "salary_expected":
      case "salary_period":
      case "secondary_roles":
      case "work_history":
      case "education":
      case "certifications":
      case "training":
      case "languages":
      case "availability":
      case "shift":
      case "relocation":
      case "accommodation":
      case "job_type":
      case "work_types":
      case "commute_max_km":
      case "willing_to_travel":
      case "documents_ready":
        // Written through the domain store by the correction (and, for salary, applied at the
        // precedence layer). The store is what the display/projector reads, so the pure overlay
        // intentionally leaves these inputs alone.
        break;
      default:
        throw new Error(
          `unhandled effective-fact override (extend applyEffectiveFacts): ${key}`,
        );
    }
  }
  return next as T;
}
