import type { ServerConfig } from "@badabhai/config";

/** The one config key the bulk student move reads. */
export type StudentMoveConfig = Partial<Pick<ServerConfig, "STUDENT_MOVE_ENABLED">>;

/**
 * `STUDENT_MOVE_ENABLED` (#2887) — THE ONE READ of the switch. Only `true` turns it on; unset,
 * empty and a missing config object are off, so a caller that was never handed the config (a
 * hand-built unit instance) fails closed to today: no route, no predicate, no table read.
 */
export function studentMoveEnabled(config: StudentMoveConfig | undefined): boolean {
  return config?.STUDENT_MOVE_ENABLED === true;
}
