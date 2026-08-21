import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart' show SchedulerBinding;

import 'app.dart';
import 'core/config/remote_config.dart';
import 'core/di/locator.dart';
import 'core/theme/app_typography.dart';
import 'core/observability/crash_reporter.dart';
import 'core/referral/install_referrer_reader.dart';
import 'core/referral/pending_referral_store.dart';
import 'features/auth/domain/auth_session_manager.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Fonts must NEVER fetch over the network. A flaky-link google_fonts fetch
  // threw an unhandled ClientException during the first frames — before the crash
  // reporter was ready to swallow it — and crashed the app on a real worker
  // device. Set BEFORE the first widget builds so no headline/PIN cell can
  // trigger a fetch. See AppTypography.configureFontLoading.
  AppTypography.configureFontLoading();

  // Wire the synchronous, plugin-free graph, then the async auth singletons
  // (LocaleStore + AuthApi + AuthSessionManager). The latter MUST be awaited
  // before the first authed request and before the router reads the manager.
  //
  // #315: this await is also what makes the UI language work. BadaBhaiApp reads
  // LocaleStore ONCE in initState to pick its Locale, so the store has to be
  // registered before runApp below — skip the await and every worker silently
  // gets the Hindi default no matter what they chose.
  setupLocator();
  await initAuthLocator();

  // Resolve the cold-start auth state once (remembered refresh token → locked →
  // PIN; none → loggedOut → phone) BEFORE the first frame, so the router's
  // redirect routes correctly from app open. This is a local Keystore read —
  // bounded, and the router's first redirect is wrong without it.
  await locator<AuthSessionManager>().bootstrap();

  runApp(const BadaBhaiApp());

  // Crash reporting comes up AFTER the first frame (#379) — never before it.
  // It is fail-closed but not fast: it awaits native Firebase init, which on a
  // non-GMS / AOSP ROM can hang until its 8s timeout instead of erroring. Doing
  // that ahead of runApp froze the worker on the static native splash for ~8s
  // on EVERY cold start. Deferred, it costs no crash coverage: init installs
  // the Dart error handlers before it awaits Firebase and buffers anything
  // raised in the gap. Not awaited — it never throws.
  CrashReporter.initAfterFirstFrame(
    appName: 'worker-app',
    ownPackage: 'badabhai_worker_app',
  );

  _bootstrapAfterFirstFrame();
}

/// Everything that must NOT gate the first frame (#379's rule, applied to the
/// two things added since): Remote Config's fetch and the Play install-referrer
/// read. Both are unawaited, both are time-boxed or best-effort internally, and
/// both are no-ops on a device where Firebase / Play Services are unavailable.
///
/// Scheduled after the first frame rather than from the splash WIDGET on
/// purpose: `SplashScreen` is deliberately DI-free and bloc-free (it is the
/// initial route, so a widget test must be able to pump it with no locator), and
/// hanging plugin work off its build would take that property away. This runs at
/// the same moment for the worker — the splash is what is on screen — without
/// coupling the screen to either plugin.
void _bootstrapAfterFirstFrame() {
  SchedulerBinding.instance.addPostFrameCallback((_) {
    // Display-only levers. A miss leaves the compiled-in defaults, which ARE
    // today's behaviour, so nothing waits on this.
    unawaited(BbRemoteConfig.instance.init());

    // B4: recover a referral the Play Store swallowed at install time. Writes
    // into the SAME PendingReferralStore the `/i/<code>` deep link uses, which
    // consent already drains into POST /referrals/attribute — so no new API
    // call, just codes that used to be lost. One-shot and silent on every
    // failure path.
    unawaited(
      InstallReferrerReader(
        store: const SharedPrefsPendingReferralStore(),
      ).consumeOnce(),
    );
  });
}
