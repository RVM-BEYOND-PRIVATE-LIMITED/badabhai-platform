import { z } from "zod";

/**
 * The minimum supported app build's presentation model (#3058; the server half is #3048).
 *
 * Pure and client-safe: the card validates with it before a save, the Server Action validates
 * with it again before the PUT, and `app-release-policy-model.test.ts` holds every bound here to
 * the server's (`apps/api/src/app-version/app-version.constants.ts`). The bounds are repeated,
 * not imported: a sibling app cannot import the API, and the test is what keeps them equal.
 *
 * `payer` is the company app. Neither slug is ever shown: every label comes from here.
 */

export const APP_RELEASE_APPS = ["worker", "payer"] as const;
export type AppReleaseApp = (typeof APP_RELEASE_APPS)[number];

export const APP_RELEASE_PLATFORMS = ["android", "ios"] as const;
export type AppReleasePlatform = (typeof APP_RELEASE_PLATFORMS)[number];

/** The largest build number Postgres `integer` holds (the server's `APP_BUILD_NUMBER_MAX`). */
export const APP_BUILD_NUMBER_MAX = 2_147_483_647;
/** A store link: https only, no whitespace, at most 512 characters (the migration's CHECK). */
export const APP_STORE_URL_MAX = 512;
export const APP_STORE_URL_PATTERN = /^https:\/\/\S+$/;
/** A copy key's shape. The screen never edits it; it sends the row's own key back. */
export const APP_MESSAGE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** The 503 the API answers while the `app_release_policy` migration is not applied. */
export const APP_RELEASE_NOT_READY = "Not available yet: the database step is pending.";

const buildNumber = z.number().int().min(0).max(APP_BUILD_NUMBER_MAX);

/** One row of `GET /admin/app-release-policy`, and the `policy` of a `PUT`'s answer. */
export const appReleasePolicySchema = z.object({
  app: z.enum(APP_RELEASE_APPS),
  platform: z.enum(APP_RELEASE_PLATFORMS),
  min_supported_build: buildNumber,
  latest_build: buildNumber,
  store_url: z.string().nullable(),
  message_key: z.string(),
  /** The admin who last set it; null for the migration's seed. */
  updated_by: z.string().nullable(),
  updated_at: z.string().nullable(),
});
export type AppReleasePolicy = z.infer<typeof appReleasePolicySchema>;

/**
 * The `PUT /admin/app-release-policy` body, exactly as the server takes it: strict, EVERY field
 * stated, the latest build never below the minimum. No admin id: the actor is the session.
 */
export const appReleasePolicyBodySchema = z
  .object({
    app: z.enum(APP_RELEASE_APPS),
    platform: z.enum(APP_RELEASE_PLATFORMS),
    min_supported_build: buildNumber,
    latest_build: buildNumber,
    store_url: z.string().max(APP_STORE_URL_MAX).regex(APP_STORE_URL_PATTERN).nullable(),
    message_key: z.string().regex(APP_MESSAGE_KEY_PATTERN),
  })
  .strict()
  .refine((v) => v.latest_build >= v.min_supported_build, {
    message: "latest_build must be at least min_supported_build",
    path: ["latest_build"],
  });
export type AppReleasePolicyBody = z.infer<typeof appReleasePolicyBodySchema>;

// ── labels ──────────────────────────────────────────────────────────────────────────────────

const APP_LABELS: Record<AppReleaseApp, string> = {
  worker: "Worker app",
  payer: "Company app",
};
/** The app as the confirm sentence names it: "every worker app", "every company app". */
const APP_WORDS: Record<AppReleaseApp, string> = {
  worker: "worker",
  payer: "company",
};
const PLATFORM_LABELS: Record<AppReleasePlatform, string> = {
  android: "Android",
  ios: "iOS",
};

export function appLabel(app: AppReleaseApp): string {
  return APP_LABELS[app];
}

export function platformLabel(platform: AppReleasePlatform): string {
  return PLATFORM_LABELS[platform];
}

/** A card's title: "Worker app Android", "Company app iOS". */
export function policyTitle(policy: Pick<AppReleasePolicy, "app" | "platform">): string {
  return `${appLabel(policy.app)} ${platformLabel(policy.platform)}`;
}

/** The four rows in the screen's fixed order: worker before company, Android before iOS. */
export function orderPolicies(policies: readonly AppReleasePolicy[]): AppReleasePolicy[] {
  const rank = (p: AppReleasePolicy) =>
    APP_RELEASE_APPS.indexOf(p.app) * APP_RELEASE_PLATFORMS.length +
    APP_RELEASE_PLATFORMS.indexOf(p.platform);
  return [...policies].sort((a, b) => rank(a) - rank(b));
}

/**
 * Who last set the row. The seed has no admin (and its `updated_at` is only when the migration
 * ran), so a row without `updated_by` was never changed by anyone.
 */
export type LastChange = { kind: "never" } | { kind: "changed"; by: string; at: string | null };

export function lastChange(
  policy: Pick<AppReleasePolicy, "updated_by" | "updated_at">,
): LastChange {
  if (policy.updated_by === null) return { kind: "never" };
  return { kind: "changed", by: policy.updated_by, at: policy.updated_at };
}

// ── the form ────────────────────────────────────────────────────────────────────────────────

export type AppReleaseFieldKey = "min_supported_build" | "latest_build" | "store_url";

export interface AppReleaseField {
  key: AppReleaseFieldKey;
  label: string;
  help: string;
}

export const APP_RELEASE_FIELDS: readonly AppReleaseField[] = Object.freeze([
  {
    key: "min_supported_build",
    label: "Minimum build",
    help: "Builds below this are blocked from writing.",
  },
  {
    key: "latest_build",
    label: "Latest build",
    help: "Builds below this see a ‘new version available’ notice.",
  },
  {
    key: "store_url",
    label: "Store link (optional)",
    help: "An https:// link to the store listing or the download page. Leave it empty for none.",
  },
]);

/** The form keeps raw strings, so a field can be cleared while it is being retyped. */
export type AppReleaseFormValues = Record<AppReleaseFieldKey, string>;

export type AppReleaseFieldErrors = Partial<Record<AppReleaseFieldKey | "form", string>>;

export function formValuesFromPolicy(policy: AppReleasePolicy): AppReleaseFormValues {
  return {
    min_supported_build: String(policy.min_supported_build),
    latest_build: String(policy.latest_build),
    store_url: policy.store_url ?? "",
  };
}

export const BUILD_NUMBER_BLANK = "Enter a build number.";
export const BUILD_NUMBER_INVALID = `Enter a whole number from 0 to ${APP_BUILD_NUMBER_MAX}.`;
export const LATEST_BELOW_MINIMUM = "The latest build must be at least the minimum build.";
export const STORE_URL_INVALID = "Enter a full link that starts with https:// and has no spaces.";
export const STORE_URL_TOO_LONG = `Use a link of at most ${APP_STORE_URL_MAX} characters.`;
const FORM_REFUSED = "That change was refused. Check the values and try again.";

/** A build number as typed: digits only (no sign, no decimal point, no exponent), within bounds. */
function parseBuild(raw: string): { value: number } | { error: string } {
  const value = raw.trim();
  if (value === "") return { error: BUILD_NUMBER_BLANK };
  if (!/^\d+$/.test(value)) return { error: BUILD_NUMBER_INVALID };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > APP_BUILD_NUMBER_MAX) {
    return { error: BUILD_NUMBER_INVALID };
  }
  return { value: parsed };
}

/** The store link as typed: empty means none (`null`); otherwise https, no spaces, ≤ 512. */
function parseStoreUrl(raw: string): { value: string | null } | { error: string } {
  const value = raw.trim();
  if (value === "") return { value: null };
  if (value.length > APP_STORE_URL_MAX) return { error: STORE_URL_TOO_LONG };
  if (!APP_STORE_URL_PATTERN.test(value)) return { error: STORE_URL_INVALID };
  return { value };
}

export type AppReleaseFormValidation =
  | { ok: true; body: AppReleasePolicyBody }
  | { ok: false; errors: AppReleaseFieldErrors };

/**
 * Validate one card's raw strings into the PUT body. Every field is sent; `app`, `platform` and
 * `message_key` come from the row as it was read, so the copy key goes back unchanged.
 */
export function validateAppReleaseForm(
  policy: Pick<AppReleasePolicy, "app" | "platform" | "message_key">,
  values: AppReleaseFormValues,
): AppReleaseFormValidation {
  const errors: AppReleaseFieldErrors = {};
  const min = parseBuild(values.min_supported_build);
  const latest = parseBuild(values.latest_build);
  const link = parseStoreUrl(values.store_url);
  if ("error" in min) errors.min_supported_build = min.error;
  if ("error" in latest) errors.latest_build = latest.error;
  if ("error" in link) errors.store_url = link.error;
  if ("value" in min && "value" in latest && latest.value < min.value) {
    errors.latest_build = LATEST_BELOW_MINIMUM;
  }
  if ("error" in min || "error" in latest || "error" in link || errors.latest_build) {
    return { ok: false, errors };
  }

  const parsed = appReleasePolicyBodySchema.safeParse({
    app: policy.app,
    platform: policy.platform,
    min_supported_build: min.value,
    latest_build: latest.value,
    store_url: link.value,
    message_key: policy.message_key,
  });
  if (!parsed.success) {
    const mapped = fieldErrorsFromIssues(parsed.error.issues);
    return { ok: false, errors: Object.keys(mapped).length > 0 ? mapped : { form: FORM_REFUSED } };
  }
  return { ok: true, body: parsed.data };
}

export interface AppReleaseIssue {
  path: readonly PropertyKey[];
  message: string;
}

/**
 * Map Zod/API issues onto the field that caused them, in this screen's own words. Anything that
 * is not one of the three editable fields (an unknown app, a bad copy key) lands on the form.
 */
export function fieldErrorsFromIssues(issues: readonly AppReleaseIssue[]): AppReleaseFieldErrors {
  const errors: AppReleaseFieldErrors = {};
  for (const issue of issues) {
    const key = issue.path.map(String)[0];
    if (key === "min_supported_build") errors.min_supported_build = BUILD_NUMBER_INVALID;
    else if (key === "latest_build") {
      errors.latest_build = /at least/i.test(issue.message)
        ? LATEST_BELOW_MINIMUM
        : BUILD_NUMBER_INVALID;
    } else if (key === "store_url") {
      errors.store_url = /too_big|at most|512/i.test(issue.message)
        ? STORE_URL_TOO_LONG
        : STORE_URL_INVALID;
    } else errors.form = FORM_REFUSED;
  }
  return errors;
}

// ── the confirm ─────────────────────────────────────────────────────────────────────────────

/** Only RAISING a minimum stops installs, so only a raise asks first. */
export function needsRaiseConfirm(
  saved: Pick<AppReleasePolicy, "min_supported_build">,
  next: Pick<AppReleasePolicyBody, "min_supported_build">,
): boolean {
  return next.min_supported_build > saved.min_supported_build;
}

/** The question the confirm asks, word for word from #3058. */
export function raiseConfirmQuestion(
  policy: Pick<AppReleasePolicy, "app" | "platform">,
  nextMin: number,
): string {
  return (
    `Every ${APP_WORDS[policy.app]} app on ${platformLabel(policy.platform)} older than build ` +
    `${nextMin} will be stopped until it updates. Continue?`
  );
}

export interface AppReleaseChange {
  label: string;
  before: string;
  after: string;
}

/** What the save changes, field by field, for the confirm's before/after table. */
export function policyChanges(
  saved: AppReleasePolicy,
  next: AppReleasePolicyBody,
): AppReleaseChange[] {
  const out: AppReleaseChange[] = [];
  if (saved.min_supported_build !== next.min_supported_build) {
    out.push({
      label: "Minimum build",
      before: String(saved.min_supported_build),
      after: String(next.min_supported_build),
    });
  }
  if (saved.latest_build !== next.latest_build) {
    out.push({
      label: "Latest build",
      before: String(saved.latest_build),
      after: String(next.latest_build),
    });
  }
  if (saved.store_url !== next.store_url) {
    out.push({
      label: "Store link",
      before: saved.store_url ?? "None",
      after: next.store_url ?? "None",
    });
  }
  return out;
}

// ── the save ────────────────────────────────────────────────────────────────────────────────

export type SaveAppReleasePolicyResult =
  | { ok: true; changed: boolean; policy: AppReleasePolicy }
  | {
      ok: false;
      kind: "validation" | "not_ready" | "refused" | "error";
      error: string;
      fieldErrors?: AppReleaseFieldErrors;
    };

/** The success notice: a real change, or a save that matched what was already there. */
export function saveSuccessMessage(changed: boolean): string {
  return changed ? "Saved" : "No change";
}
