/**
 * #3048 — the minimum supported app build: the closed values and the request headers the company
 * (payer) app and the worker app send (#3049).
 *
 * Header names are constants, as every header in this repo is (`APP_BUILD_HEADER`,
 * `INTERNAL_SERVICE_TOKEN_HEADER`, …), so a rename is one edit and a typo is a compile error.
 */

/** The two installable apps. `payer` is the company app (`apps/payer-app`). */
export const APP_NAMES = ["worker", "payer"] as const;
export type AppName = (typeof APP_NAMES)[number];

/** The two store platforms. */
export const APP_PLATFORMS = ["android", "ios"] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

/** Which app sent the request: `worker` or `payer`. */
export const APP_NAME_HEADER = "x-app-name";

/** Which platform the app runs on: `android` or `ios`. */
export const APP_PLATFORM_HEADER = "x-app-platform";

/**
 * The app's INTEGER build number (the `+N` of pubspec `version`; Android versionCode, iOS
 * CFBundleVersion). Deliberately NOT `x-app-build` (#966): that one is a commit SHA or `dev`,
 * telemetry that cannot be ordered, and every installed worker app already sends it.
 */
export const APP_BUILD_NUMBER_HEADER = "x-app-build-number";

/** The `error.code` of a 426 answer. */
export const APP_UPDATE_REQUIRED_CODE = "APP_UPDATE_REQUIRED";

/** The copy key every row is seeded with; an app reads any key it does not know as this one. */
export const DEFAULT_APP_MESSAGE_KEY = "update_default";

/** A copy key's shape (the migration's CHECK). */
export const APP_MESSAGE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** The largest build number Postgres `integer` holds. */
export const APP_BUILD_NUMBER_MAX = 2_147_483_647;

/** A store link: https only, no whitespace, at most 512 characters (the migration's CHECK). */
export const APP_STORE_URL_PATTERN = /^https:\/\/\S+$/;
export const APP_STORE_URL_MAX = 512;

/** `GET /app-config` may be cached by the app and any proxy for this long. */
export const APP_CONFIG_CACHE_SECONDS = 300;
