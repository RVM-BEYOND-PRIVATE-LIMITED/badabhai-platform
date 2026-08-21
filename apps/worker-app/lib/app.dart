import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'core/auth/account_deleted_signal.dart';
import 'core/auth/locale_store.dart';
import 'core/config/app_config.dart';
import 'core/di/locator.dart';
import 'core/observability/crash_route_observer.dart';
import 'core/theme/app_theme.dart';
import 'core/widgets/bb_alert_dialog.dart';
import 'core/widgets/feedback_fab.dart';
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

  /// Listens for the backend's "this worker's account is gone" signal (410
  /// `WORKER_ACCOUNT_DELETED`). One app-scoped subscription for the whole app.
  StreamSubscription<void>? _accountDeletedSub;

  /// Guards against parallel 410s (several in-flight calls fail at once) showing
  /// more than ONE dialog. Reset after the dialog is dismissed.
  bool _accountDeletedDialogShown = false;

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
    // ADR account-deletion: subscribe to the app-scoped signal fired by the HTTP
    // seams on a 410 { code: WORKER_ACCOUNT_DELETED }. Guarded like the observer
    // above so legacy widget tests that never wire DI are unaffected.
    if (locator.isRegistered<AccountDeletedSignal>()) {
      _accountDeletedSub = locator<AccountDeletedSignal>()
          .stream
          .listen((_) => _onAccountDeleted());
    }
  }

  @override
  void dispose() {
    _detachScreenTracking?.call();
    unawaited(_accountDeletedSub?.cancel());
    final LifecycleRelockObserver? observer = _relock;
    if (observer != null) WidgetsBinding.instance.removeObserver(observer);
    super.dispose();
  }

  /// The backend has deleted this worker's account server-side. Show ONE
  /// non-dismissible dialog over whatever screen is showing, then hard-logout on
  /// OK — the router redirect sends the worker to phone login so they can start
  /// again. Parallel 410s collapse to a single dialog via
  /// [_accountDeletedDialogShown].
  Future<void> _onAccountDeleted() async {
    if (_accountDeletedDialogShown) return;
    // Present through the ROUTER's navigator (see [rootNavigatorKey]) — its
    // context has the Directionality / Localizations / Overlay that the
    // MaterialApp.router builder context does not. Null before the first frame:
    // the next authed call re-fires the signal, so nothing is lost.
    final BuildContext? navContext = rootNavigatorKey.currentContext;
    if (navContext == null) return;
    _accountDeletedDialogShown = true;
    // A single OK button; copy stays honest + simple for a low-literacy worker.
    await showBbAlert(
      navContext,
      title: 'Account nahi mila',
      message:
          'Hamein aapki profile nahi mil rahi hai. Kripya dobara login karein.',
    );
    _accountDeletedDialogShown = false;
    // Hard logout: wipe tokens + PIN, drop singleton-held user data
    // (onSessionCleared), flip to loggedOut → the router bounces to phone login.
    if (locator.isRegistered<AuthSessionManager>()) {
      await locator<AuthSessionManager>().logout();
    }
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
      // Wrap every page with the app-wide floating Feedback button (CEO request)
      // — a single overlay above the router's Navigator that shows on all
      // non-auth screens (see [FeedbackFabOverlay]). In MOCK mode a corner ribbon
      // is layered on top so it stays obvious the backend is stubbed.
      builder: (BuildContext context, Widget? child) {
        Widget content = FeedbackFabOverlay(
          router: _router,
          child: child ?? const SizedBox.shrink(),
        );
        if (kUseMocks) {
          content = Banner(
            message: 'MOCK',
            location: BannerLocation.topEnd,
            color: Colors.deepOrange,
            child: content,
          );
        }
        // Clamp the OS font-scale so an extreme accessibility setting can't
        // blow the layout apart — the app still scales up to 1.3x for low-vision
        // users, but no further.
        return MediaQuery.withClampedTextScaling(
          maxScaleFactor: 1.3,
          child: content,
        );
      },
    );
  }
}
