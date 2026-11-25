import { z } from "zod";

import {
  APP_BUILD_NUMBER_MAX,
  APP_MESSAGE_KEY_PATTERN,
  APP_NAMES,
  APP_PLATFORMS,
  APP_STORE_URL_MAX,
  APP_STORE_URL_PATTERN,
} from "./app-version.constants";

/**
 * #3048 — `GET /app-config?app=worker&platform=android`. Both are required; anything else is a
 * 400. The answer is the {@link AppConfigView} for that app and platform. NOT strict: an extra
 * query parameter (a cache-buster) is dropped, never a 400 that would read as "config failed".
 */
export const AppConfigQuerySchema = z.object({
  app: z.enum(APP_NAMES),
  platform: z.enum(APP_PLATFORMS),
});
export type AppConfigQueryDto = z.infer<typeof AppConfigQuerySchema>;

const buildNumber = z.number().int().min(0).max(APP_BUILD_NUMBER_MAX);

/**
 * `PUT /admin/app-release-policy` — set ONE app and platform's policy, every field stated (the
 * admin screen sends the whole row). The admin is the session's; no body field names one.
 * `latest_build` may not be below `min_supported_build` (the migration's CHECK says the same).
 */
export const AdminSetAppReleasePolicySchema = z
  .object({
    app: z.enum(APP_NAMES),
    platform: z.enum(APP_PLATFORMS),
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
export type AdminSetAppReleasePolicyDto = z.infer<typeof AdminSetAppReleasePolicySchema>;
