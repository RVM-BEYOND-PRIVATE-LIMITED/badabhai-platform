# `/.well-known/assetlinks.json` — RELEASE IS BLOCKED UNTIL THE FINGERPRINT IS FILLED IN

## What this file does

`assetlinks.json` is the Digital Asset Links statement that delegates
`delegate_permission/common.handle_all_urls` from this web origin to the BadaBhai **worker
app's** Android package. It is what makes `https://app.badabhai.in/i/<code>` a **verified
Android App Link**: with it in place, tapping a shared referral link on a device that has
the app installed opens the **app** directly (carrying the code) instead of the browser.

That is half of the post-Firebase attribution chain (Firebase Dynamic Links shut down
2025-08-25). The other half is Play Install Referrer, which covers the *not installed* case
via the `/i/[code]` landing page's Play Store link.

## THE BLOCKER

`sha256_cert_fingerprints` currently contains an obviously invalid placeholder:

```
REPLACE_WITH_PLAY_APP_SIGNING_SHA256_FINGERPRINT_RELEASE_IS_BLOCKED_UNTIL_THIS_IS_SET
```

**This is an OWNER-supplied value and was deliberately NOT invented.** A plausible-looking
but wrong fingerprint is worse than an obviously broken one: Android would simply fail
verification and silently fall back to the browser, and nobody would notice until the
referral numbers came in low.

Until it is replaced:

- App Link verification **fails**, so `/i/<code>` always opens in the browser.
- The landing page still works — a visitor gets the Play Store CTA with the referral
  payload attached — so the *fresh install* leg of attribution is unaffected.
- The *already installed* leg (open straight into the app) does **not** work.

## How to fill it in

1. Google Play Console → your app → **Release → Setup → App integrity → App signing**.
2. Copy the **SHA-256 certificate fingerprint** for **App signing key certificate** (the
   Play App Signing key — **not** the upload key; Play re-signs the uploaded artifact, so
   the upload key's fingerprint is the wrong one and is a common mistake).
3. Paste it into `sha256_cert_fingerprints`, colon-separated uppercase hex, e.g.
   `"AB:CD:EF:...:12"`. Keep it a JSON array — add the **upload key's** fingerprint as a
   second entry too if you want internal-test builds signed with the upload key to verify.
4. Confirm `package_name` matches the worker app's real application id (it must also match
   `NEXT_PUBLIC_WORKER_APP_ID`, which the landing page uses to build the Play Store URL).

## Guarding it (so it can't silently rot) — #609

The whole failure mode here is that it is **invisible from the code**: everything
looks wired, but a placeholder fingerprint or a drifted `package_name` silently
sends every "already installed" link to the browser. Two guards make it loud:

- **CI (always on):** `src/app/assetlinks.test.ts` (vitest) asserts the file is a
  single well-formed `android_app` delegate statement, that `package_name` stays
  in sync with `NEXT_PUBLIC_WORKER_APP_ID`, and that the fingerprint array is
  non-empty. This catches the drift/malformation modes — it does **not** fail on
  the placeholder, which is expected until the value is filled in.
- **Release gate (run at deploy):** `pnpm --filter payer-web verify:assetlinks`
  (`scripts/verify-assetlinks-release.mjs`) **hard-fails** while the placeholder
  (or any non-SHA-256 value) is present. Wire it into the payer-web deploy
  pipeline as a pre-publish step so a release cannot ship the launch gate broken.

Once the real fingerprint is pasted in, both go green and stay green.

## Verifying it after deploy

```bash
curl -sI https://app.badabhai.in/.well-known/assetlinks.json   # expect 200 + application/json
curl -s  https://app.badabhai.in/.well-known/assetlinks.json   # expect the statement, no placeholder
```

Then Google's verifier:

```
https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://app.badabhai.in&relation=delegate_permission/common.handle_all_urls
```

On a device: `adb shell pm get-app-links <package>` should report `verified` for the domain.

## Serving

The file is served statically by Next.js from `apps/payer-web/public/`, so it is reachable
at exactly `/.well-known/assetlinks.json` with `content-type: application/json`. No rewrite
or route handler is needed — verified against the production build's static output (a route
handler was deliberately NOT used: Android fetches this file with no cookies and no JS, and
a static file has fewer ways to break than a rendered route).

**Note on the hosting layer:** any CDN/proxy in front of this app must not rewrite, redirect
(Android follows **no** redirects when verifying), or password-protect `/.well-known/*`, and
the origin must be HTTPS.
