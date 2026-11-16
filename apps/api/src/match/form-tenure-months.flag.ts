import type { ServerConfig } from "@badabhai/config";
import type { FormTenureSwitches } from "@badabhai/db";

/** The two config keys the form-tenure fill reads. */
export type FormTenureMonthsConfig = Partial<
  Pick<ServerConfig, "FORM_TENURE_MONTHS_ENABLED" | "FORM_TYPED_TENURE_DERIVE_ENABLED">
>;

/**
 * `FORM_TENURE_MONTHS_ENABLED` (#2753 item 2) — THE ONE READ of the switch on the live path, and of
 * `FORM_TYPED_TENURE_DERIVE_ENABLED` as it applies to it. Only `true` turns either on; unset, false
 * and a missing config object are off, so a rebuild that was never handed the config derives
 * today's months. A typed tenure counts only when BOTH are on.
 *
 * `db:backfill:worker-skills` reads the same two names from its own environment
 * (`formTenureSwitchesFromEnv`, @badabhai/db), so the two writers of `worker_skill` agree only when
 * the operator runs the batch with the values production runs with.
 */
export function formTenureSwitches(config: FormTenureMonthsConfig | undefined): FormTenureSwitches {
  const months = config?.FORM_TENURE_MONTHS_ENABLED === true;
  return { months, typed: months && config?.FORM_TYPED_TENURE_DERIVE_ENABLED === true };
}
