# Referral deep links (`/i/<code>`)

How the invite link (Profile → "Dost ko invite karein") opens the app instead of
a browser, and exactly what flips when the app goes live on the Play Store / App
Store.

## The link

`POST /invites` returns a server-relative `/i/<code>`; the app prefixes
`INVITE_LINK_BASE` (`app_config.dart`, default `https://app.badabhai.in`) to make
the shared URL:

```
https://app.badabhai.in/i/<12-hex-code>
```

One URL, three outcomes — by design:

| Tap context                               | What happens                                            |
|-------------------------------------------|---------------------------------------------------------|
| App installed **and** domain verified     | OS opens the app straight to the referral capture       |
| App installed, not verified (see caveats) | Android shows the app in the "open with" chooser        |
| App **not** installed                     | Browser loads the URL → the page must redirect to store |

The custom scheme `badabhai://i/<code>` is a legacy fallback that never opens a
browser but also never redirects to a store — it only resolves if the app is
already installed. The `https://` App Link is the real path.

## What is already DONE (in this app)

Client-side, both platforms are wired — no code work remains here:

- **Dart (both platforms):** `lib/router.dart` — `referralCodeFromUri` parses both
  the `https://…/i/<code>` and `badabhai://i/<code>` shapes; the root redirect
  captures the opaque code into `PendingReferralStore` and bounces to splash, so
  the invited worker flows through login → consent, where the code is attributed
  once (`POST /referrals/attribute`). PII-free — the code carries no identity.
- **Android:** `AndroidManifest.xml` — `flutter_deeplinking_enabled`, the
  `badabhai://i` custom-scheme filter, and the **verified App Link** filter
  (`autoVerify="true"`, `https`, host `app.badabhai.in`, `pathPrefix="/i/"`).
- **iOS:** `ios/Runner/Info.plist` — `FlutterDeepLinkingEnabled` + the `badabhai`
  custom URL scheme. (Universal Links are a go-live step — see below.)

## What is NOT code — the go-live checklist

App Links / Universal Links are an **infra + store** dependency. Nothing below is
a code change in this app.

### Android

1. **Host the digital-asset-links file** at
   `https://app.badabhai.in/.well-known/assetlinks.json` — served `200`,
   `Content-Type: application/json`, **no redirect**. Use
   `deeplinks/well-known/assetlinks.json`.
   - It currently lists the **debug** signing SHA-256
     (`38:C5:…:10:B5`), which is what the release APK is signed with **today**
     (`android/app/build.gradle` → `signingConfig = signingConfigs.debug`). So a
     cable/sideload install verifies against it right now — you can test the full
     open-in-app flow before the store.
   - **At Play Store publish:** Google Play App Signing re-signs the app, so add
     the **Play App Signing SHA-256** (Play Console → Setup → App integrity → App
     signing key certificate) to the `sha256_cert_fingerprints` array. Keep the
     debug one too if you still sideload; drop it otherwise. The array takes
     multiple fingerprints.
2. **Add a real release keystore** (replace the debug signing config) before
   publishing — the debug key must never sign a store build. When you do, that
   key's SHA-256 is the *upload* key; Play still re-signs, so step 1's fingerprint
   is the Play App Signing one, not the upload key's.
3. **The not-installed page:** `https://app.badabhai.in/i/<code>` must be a real
   web page that redirects to the Play Store listing (and later the App Store)
   when the app is absent. Backend/web owns this — raise an issue on that team.
   Verify: `assetlinks` covers the *app-open* case; the page covers the
   *not-installed* case. Both are needed.

Verify Android wiring after hosting:
```
adb shell pm verify-app-links --re-verify com.badabhai.workerapp
adb shell pm get-app-links com.badabhai.workerapp   # expect: app.badabhai.in  verified
```

### iOS

1. **Enable Associated Domains** on the App ID (`com.badabhai.workerapp`) in the
   Apple Developer portal, regenerate the provisioning profile.
2. **Wire the entitlement:** copy `deeplinks/ios/Runner.entitlements` to
   `ios/Runner/Runner.entitlements` and set `CODE_SIGN_ENTITLEMENTS =
   Runner/Runner.entitlements` on the Runner target (both Debug + Release) in
   Xcode. It is kept out of `ios/Runner/` until then because the entitlement
   breaks signing until step 1 exists.
3. **Host the AASA file** at
   `https://app.badabhai.in/.well-known/apple-app-site-association` — `200`,
   `application/json`, **no `.json` extension, no redirect**. Use
   `deeplinks/well-known/apple-app-site-association`; replace `TEAMID` with the
   Apple Developer Team ID (→ `TEAMID.com.badabhai.workerapp`).
4. **The not-installed page** is the same `/i/<code>` page as Android — it should
   detect iOS and send those users to the App Store.

## Changing the domain

Everything keys off one constant: `INVITE_LINK_BASE` (`app_config.dart`). If the
domain ever changes, update it, the Android manifest `android:host`, the iOS
`applinks:` entitlement, and re-host both `.well-known` files under the new host.
