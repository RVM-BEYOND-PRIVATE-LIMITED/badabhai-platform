import type { ServerConfig } from "@badabhai/config";

import {
  AVAILABILITY_STATUSES_V1,
  AVAILABILITY_STATUSES_V2,
  type PreferenceVocabulary,
} from "./worker-preferences.vocabulary";

/** The one config key the availability-answers switch reads. */
export type AvailabilityAnswersConfig = Pick<ServerConfig, "AVAILABILITY_ANSWERS_V2_ENABLED">;

/**
 * `AVAILABILITY_ANSWERS_V2_ENABLED` (#2753 item 3) — THE ONE READ of the flag. Only `true` turns
 * it on; unset, empty and a missing config object are off, so a caller that was never handed the
 * config fails closed to today's four answers.
 */
export function availabilityAnswersV2Enabled(
  config: AvailabilityAnswersConfig | undefined,
): boolean {
  return config?.AVAILABILITY_ANSWERS_V2_ENABLED === true;
}

/**
 * The availability answers a client is OFFERED: the brief's four while the flag is on, the first
 * set (byte-identical to the dictionary served before #2753) while it is off.
 *
 * OFFERED, NOT ACCEPTED. What a write may carry and what a reader can print is
 * `AVAILABILITY_STATUSES_ALL`, whatever this returns: an installed build keeps sending the first
 * set's keys after the switch, and a stored key of either set keeps its own label.
 *
 * The dictionary objects themselves, never copies, so a client and the PUT's enum read one source.
 */
export function offeredAvailabilityStatuses(
  config: AvailabilityAnswersConfig | undefined,
): PreferenceVocabulary {
  return availabilityAnswersV2Enabled(config) ? AVAILABILITY_STATUSES_V2 : AVAILABILITY_STATUSES_V1;
}
