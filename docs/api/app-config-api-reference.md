# Minimum supported app build — API reference (#3048)

The server half of "Update required". The app half is #3049 (worker app and company app).

One policy row per app (`worker`, `payer`) and platform (`android`, `ios`), in
`app_release_policy` (migration 0199). Every row is seeded at minimum 0, which blocks nobody.
The owner raises a minimum from the admin route; no release or setting is needed.

"Build" is the app's **integer build number**: the `+N` of pubspec `version`, which is the
Android `versionCode` and the iOS `CFBundleVersion`. It is not the worker app's `x-app-build`
commit stamp (#966), which cannot be ordered and is left as it is.

## Request headers (every app request, after #3049)

| Header               | Value                            |
| -------------------- | -------------------------------- |
| `x-app-name`         | `worker` or `payer`              |
| `x-app-platform`     | `android` or `ios`               |
| `x-app-build-number` | the integer build number, `0`–`2147483647` |

A request is checked only when **all three** are present and well formed. Values are trimmed and
case-insensitive. A request without them is never blocked: the web apps, and every app installed
before #3049.

## `GET /app-config?app=<worker|payer>&platform=<android|ios>`

Public, no sign-in. `Cache-Control: public, max-age=300`. No event.

```json
{
  "app": "worker",
  "platform": "android",
  "min_supported_build": 0,
  "latest_build": 0,
  "store_url": null,
  "message_key": "update_default"
}
```

- `min_supported_build`: a build **below** this must update (full-screen page, and every write
  answers 426).
- `latest_build`: a build below this, but not below the minimum, may update (dismissible notice).
  Never below `min_supported_build`.
- `store_url`: an `https://` link (Play Store, App Store, or a download link until the apps are
  listed), or `null` until the owner sets it.
- `message_key`: a copy key (`^[a-z][a-z0-9_]{0,63}$`). Seeded `update_default`; an app reads any
  key it does not know as `update_default`.

Errors: `400` for a missing or unknown `app` / `platform` (an extra query parameter is ignored);
`503` when the policy cannot be read. **The apps let the user in on any failure.**

## 426 on writes

`POST`, `PUT`, `PATCH` and `DELETE` on **any** route answer `426` when the three headers name a
build below that app and platform's minimum. `GET`, `HEAD` and `OPTIONS` always pass. The gate is by
method, so a POST that only reads (the company candidate search) answers 426 too.

```json
{
  "statusCode": 426,
  "error": {
    "code": "APP_UPDATE_REQUIRED",
    "message": "This app version is no longer supported. Update the app to continue.",
    "config": {
      "app": "worker",
      "platform": "android",
      "min_supported_build": 50,
      "latest_build": 52,
      "store_url": "https://play.google.com/store/apps/details?id=...",
      "message_key": "update_default"
    }
  },
  "requestId": "…",
  "path": "/workers/me/…",
  "timestamp": "2026-11-25T10:00:00.000Z"
}
```

`error.config` is exactly the `GET /app-config` body for that app and platform. Key the app on
`statusCode == 426 && error.code == "APP_UPDATE_REQUIRED"`.

The guard **fails open**: if the policy cannot be read, every write passes. This is a
compatibility gate, not authentication, and a server fault must never lock a worker out.

## Admin: `GET` / `PUT /admin/app-release-policy`

`super_admin` only (capability `manage_app_release_policy`).

- `GET` → `{ "policies": [ …four rows, worker/android, worker/ios, payer/android, payer/ios… ] }`,
  each the config above plus `updated_by` (admin id or null) and `updated_at` (ISO or null).
- `PUT` body, every field required:
  `{ "app", "platform", "min_supported_build", "latest_build", "store_url", "message_key" }`.
  `latest_build >= min_supported_build`; `store_url` is `https://…` (at most 512 characters) or
  `null`. Answers `{ "changed": boolean, "policy": { … } }`. A PUT that changes nothing writes
  nothing.

Every real change emits `app_version.policy_changed` v1: `app`, `platform`,
`old_/new_min_supported_build`, `old_/new_latest_build`, `store_url`, `message_key`,
`updated_by_admin_id`. The guard sees a change within 30 seconds (the policy cache).
