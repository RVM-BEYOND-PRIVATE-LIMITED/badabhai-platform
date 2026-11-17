import type { ServerConfig } from "@badabhai/config";

/** The one config key "leave company search" reads. */
export type SearchExitConfig = Pick<ServerConfig, "SEARCH_EXIT_ENABLED">;

/**
 * `SEARCH_EXIT_ENABLED` (#2753 item 6) — THE ONE READ of the switch. Only `true` turns it on;
 * unset, empty and a missing config object are off, so a caller that was never handed the config
 * (a hand-built unit instance) fails closed to today: no route, no predicate, no table read.
 */
export function searchExitEnabled(config: SearchExitConfig | undefined): boolean {
  return config?.SEARCH_EXIT_ENABLED === true;
}
