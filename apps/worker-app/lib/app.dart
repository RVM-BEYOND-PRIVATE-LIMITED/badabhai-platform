import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'core/auth/locale_store.dart';
import 'core/config/app_config.dart';
import 'core/di/locator.dart';
import 'core/observability/crash_route_observer.dart';
import 'core/theme/app_theme.dart';
import 'features/auth/domain/auth_session_manager.dart';
import 'features/auth/presentation/lifecycle_relock_observer.dart';
import 'l10n/gen/app_localizations.dart';
import 'l10n/ui_locale.dart';
import 'router.dart';

class BadaBhaiApp extends StatefulWidget {
  const BadaBhaiApp({super.key});

  @override
  State<BadaBhaiApp> createState() => _BadaBhaiAppState();
}

class _BadaBhaiAppState extends State<BadaBhaiApp> {
  LifecycleRelockObserver? _relock;
  late final GoRouter _router;

  /// The locale the widget tree is dressed in (#315).
  ///
  /// Read ONCE here rather than in `build` because nothing can change it
  /// mid-session: the splash language picker and the Settings "Bhasha" row were
  /// both removed on purpose (they offered a choice the app could not honour),
  /// so there is currently no writer to [LocaleStore] at all. Restoring a picker
  /// is the LAST step of #315 and needs a rebuild trigger here — a picker that
  /// writes the store without one would silently do nothing until app restart,
  /// which is the same "inert picker" defect all over again.
  // (No `_locale` field: the app does not force a locale yet — see build().)

  /// Detaches the Crashlytics screen tracker (see [attachRouterScreenTracking]).
  VoidCallback? _detachScreenTracking;

  @override
  void initState() {
    super.initState();
    // Build the router HERE (not as a process-global) so its redirect +
    // refreshListenable bind to the AuthSessionManager registered right now.
    _router = buildAppRouter();
    // NOTE: the stored language is deliberately NOT resolved into a forced
    // `locale:` here — see the comment on MaterialApp.router below. `uiLocaleFor`
    // (l10n/ui_locale.dart) already knows how to map a stored code onto a locale
    // the framework can dress (`bho` rides Hindi); it is used by the l10n tests
    // and is what the picker will call when #315's last step lands.
    // Tag every crash report with the current screen (route path). No-op when
    // Crashlytics isn't ready (tests / non-GMS devices).
    _detachScreenTracking = attachRouterScreenTracking(_router);
    // Register the lifecycle re-lock observer ONLY when the auth graph is wired
    // (the real app + auth/e2e tests). Legacy widget tests that pump the app
    // without `initAuthLocator` skip it — preserving their behaviour exactly.
    if (locator.isRegistered<AuthSessionManager>()) {
      final LifecycleRelockObserver observer =
          LifecycleRelockObserver(locator<AuthSessionManager>());
      WidgetsBinding.instance.addObserver(observer);
      _relock = observer;
    }
  }

  @override
  void dispose() {
    _detachScreenTracking?.call();
    final LifecycleRelockObserver? observer = _relock;
    if (observer != null) WidgetsBinding.instance.removeObserver(observer);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'BadaBhai',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      routerConfig: _router,
      // #315 — localization. `localizationsDelegates` is the generated list
      // (AppLocalizations.delegate + the three Global* framework delegates), but
      // `supportedLocales` is our CURATED kUiSupportedLocales and NOT
      // AppLocalizations.supportedLocales: the generated list includes `bho`,
      // which flutter_localizations cannot dress, and handing it here would
      // crash a Bhojpuri worker with `No MaterialLocalizations found`. See
      // l10n/ui_locale.dart for the full reasoning; the l10n test guards it.
      //
      // `locale:` is deliberately NOT SET yet. Forcing it would pin every user
      // to [LocaleStore.defaultLocale] — `hi` — because the store has no writer
      // (both pickers were removed), and that has two effects nobody has agreed
      // to: every FRAMEWORK string (back-button tooltip, Cut/Copy/Paste, date
      // pickers, TalkBack labels) flips to Devanagari while all our own copy is
      // still romanized Hinglish in Latin script — one screen, two scripts — and
      // a worker on an English handset loses their device language entirely.
      // Leaving it unset lets Flutter negotiate against [kUiSupportedLocales],
      // which is the honest behaviour until translated copy exists.
      //
      // Set this in the SAME change that restores a picker and lands real
      // translations — that is the last step of #315, not this foundation pass.
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: kUiSupportedLocales,
      // A corner ribbon in MOCK mode so it is always obvious the backend is
      // stubbed. No effect in REAL mode (the default) — the builder stays null.
      builder: kUseMocks
          ? (BuildContext context, Widget? child) => Banner(
                message: 'MOCK',
                location: BannerLocation.topEnd,
                color: Colors.deepOrange,
                child: child ?? const SizedBox.shrink(),
              )
          : null,
    );
  }
}
