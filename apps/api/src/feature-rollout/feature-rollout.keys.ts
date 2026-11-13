import type { ServerConfig } from "@badabhai/config";

/**
 * Every feature behind an off/pilot/on switch (#2746 item 1). The key is what
 * `feature_pilot_payers.feature` stores; #2747–#2750 add theirs here, with a config field, and need
 * no migration. Keep each key in the table's shape (`fpp_feature_chk`: `^[a-z][a-z0-9_]{1,63}$`).
 */
export const FEATURE_ROLLOUT_KEYS = ["job_audience", "campus_drive_requests"] as const;
export type FeatureRolloutKey = (typeof FEATURE_ROLLOUT_KEYS)[number];

/**
 * The config field holding each feature's switch. Only `FeatureRolloutService` reads these, and its
 * `mode()` return type fails to compile if a field here is not a `FeatureRolloutMode`.
 */
export const FEATURE_ROLLOUT_CONFIG = {
  job_audience: "JOB_AUDIENCE_ROLLOUT",
  campus_drive_requests: "CAMPUS_DRIVE_REQUESTS_ROLLOUT",
} as const satisfies Record<FeatureRolloutKey, keyof ServerConfig>;
