/**
 * The #2561 correction-overlay seam for the candidate read table (B4, #2557 —
 * ADR-0062 §3.2: one resolver `resolveEffectiveFacts(workerId)` overlaying the
 * live override).
 *
 * TODAY the admin correction layer (`worker_admin_override`) does not exist, so
 * this resolves NO overrides and the projector runs on base values exactly as
 * the employer-facing reads do. #2561 plugs the live-override read into
 * {@link resolveEffectiveFacts} and extends {@link applyEffectiveFacts} per
 * fact key (location writes via `WorkersService.setLocation`, the salary
 * overlay ABOVE the `salary_expectation` container, skills as `source='ops'`
 * rows — ADR-0062 §4); the projector itself stays untouched.
 *
 * FAIL-CLOSED: an override for a key this file does not know how to apply
 * throws rather than being silently ignored — a correction that never reaches
 * the read table is worse than a loud projector error.
 */
export type EffectiveFactKey = string;

/** Live admin correction overrides as fact-key → corrected value. Empty until #2561. */
export async function resolveEffectiveFacts(
  workerId: string,
): Promise<ReadonlyMap<EffectiveFactKey, unknown>> {
  void workerId;
  return new Map();
}

/**
 * Overlay live corrections onto projector inputs. Identity while
 * {@link resolveEffectiveFacts} is empty; throws on any key so #2561 must
 * handle each fact key explicitly (fail closed, never silently dropped).
 */
export function applyEffectiveFacts<T extends Record<string, unknown>>(
  inputs: T,
  overrides: ReadonlyMap<EffectiveFactKey, unknown>,
): T {
  if (overrides.size === 0) return inputs;
  const keys = [...overrides.keys()].join(",");
  throw new Error(`unhandled effective-fact overrides (extend applyEffectiveFacts in #2561): ${keys}`);
}
