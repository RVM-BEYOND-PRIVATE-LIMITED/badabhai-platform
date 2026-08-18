/// The build identifier stamped into the app at build time (#966).
///
/// It lets a tester read WHICH build a device is running (surfaced on the
/// Settings screen) and lets the server attribute a request to a build (sent as
/// the `x-app-build` request header). Without this, an app fix can be merged,
/// green, and on `main` while every tester's device still runs a days-old build
/// and nobody can detect the gap.
///
/// Supplied at build time — a commit SHA and/or build number:
///   flutter build apk --dart-define=APP_BUILD=$(git rev-parse --short HEAD)
/// A debug / unstamped build reads `dev`.
///
/// PII-free by contract: a commit SHA / build number only — NEVER a device or
/// user identifier. It lives in its own dependency-free library so the low-level
/// [ApiClient] can read it without importing the client factory in `app_config`.
const String kAppBuild = String.fromEnvironment('APP_BUILD', defaultValue: 'dev');
