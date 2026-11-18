import type { ServerConfig } from "@badabhai/config";

/**
 * Every feature behind an off/pilot/on switch (#2746 item 1). The key is what
 * `feature_pilot_payers.feature` (and, for a worker or an admin, `feature_pilot_subjects.feature`)
 * stores; #2747–#2750 add theirs here, with a config field, and need no migration. Keep each key
 * in the tables' shape (`fpp_feature_chk` / `fps_feature_chk`: `^[a-z][a-z0-9_]{1,63}$`).
 *
 * `theme` (#2820): may this login use a theme other than the app's default? Asked only through
 * `FeatureRolloutService.isThemeOpenFor`, for a worker, a company or an admin.
 */
export const FEATURE_ROLLOUT_KEYS = [
  "job_audience",
  "campus_drive_requests",
  "applicant_facts",
  "contact_rules",
  "theme",
  "outcome_stages",
  "outbound_signals",
  "credit_rules",
  "posting_choice",
] as const;
export type FeatureRolloutKey = (typeof FEATURE_ROLLOUT_KEYS)[number];

/**
 * The config field holding each feature's switch. Only `FeatureRolloutService` reads these, and its
 * `mode()` return type fails to compile if a field here is not a `FeatureRolloutMode`.
 */
export const FEATURE_ROLLOUT_CONFIG = {
  job_audience: "JOB_AUDIENCE_ROLLOUT",
  campus_drive_requests: "CAMPUS_DRIVE_REQUESTS_ROLLOUT",
  applicant_facts: "APPLICANT_FACTS_ROLLOUT",
  contact_rules: "CONTACT_RULES_ROLLOUT",
  theme: "THEME_ROLLOUT",
  outcome_stages: "OUTCOME_STAGES_ROLLOUT",
  outbound_signals: "OUTBOUND_SIGNALS_ROLLOUT",
  credit_rules: "CREDIT_RULES_ROLLOUT",
  posting_choice: "POSTING_CHOICE_ROLLOUT",
} as const satisfies Record<FeatureRolloutKey, keyof ServerConfig>;
