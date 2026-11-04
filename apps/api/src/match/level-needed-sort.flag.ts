import type { ServerConfig } from "@badabhai/config";

/** The one config key the "Level needed" applicant sort reads. */
export type LevelNeededSortConfig = Pick<ServerConfig, "LEVEL_NEEDED_SORT_ENABLED">;

/**
 * `LEVEL_NEEDED_SORT_ENABLED` (engine v1.1, CEO ruling 30 Oct 2026, ADR-0061) — THE ONE READ of
 * the flag. Only `true` turns it on; unset, empty and a missing config object are off, so a
 * caller that was never handed the config fails closed to today's list.
 */
export function levelNeededSortEnabled(config: LevelNeededSortConfig | undefined): boolean {
  return config?.LEVEL_NEEDED_SORT_ENABLED === true;
}
