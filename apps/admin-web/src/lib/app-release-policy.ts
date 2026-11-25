import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import {
  appReleasePolicySchema,
  type AppReleasePolicy,
  type AppReleasePolicyBody,
} from "./app-release-policy-model";

/**
 * THE MINIMUM SUPPORTED APP BUILD'S ONE ROUTE MODULE (#3058; the API half is #3048,
 * `docs/api/app-config-api-reference.md`).
 *
 *   GET /admin/app-release-policy  -> { policies: [ four rows: worker/android, worker/ios,
 *                                       payer/android, payer/ios ] }
 *   PUT /admin/app-release-policy  body { app, platform, min_supported_build, latest_build,
 *                                         store_url, message_key } (strict, every field)
 *                                  -> { changed, policy }
 *
 * Both sit on `manage_app_release_policy` (super_admin only) and answer 503 while the
 * `app_release_policy` migration is not applied. The responses are validated, not trusted.
 */

const appReleasePolicyListSchema = z.object({
  policies: z.array(appReleasePolicySchema),
});

const setAppReleasePolicyResponseSchema = z.object({
  changed: z.boolean(),
  policy: appReleasePolicySchema,
});
export type SetAppReleasePolicyResponse = z.infer<typeof setAppReleasePolicyResponseSchema>;

export async function getAppReleasePolicies(): Promise<AppReleasePolicy[]> {
  const res = await adminFetch("/admin/app-release-policy", {
    schema: appReleasePolicyListSchema,
  });
  return res.policies;
}

/** Set ONE app and platform's row. The body is already validated by the caller's schema. */
export function setAppReleasePolicy(
  body: AppReleasePolicyBody,
): Promise<SetAppReleasePolicyResponse> {
  return adminFetch("/admin/app-release-policy", {
    method: "PUT",
    body,
    schema: setAppReleasePolicyResponseSchema,
  });
}
