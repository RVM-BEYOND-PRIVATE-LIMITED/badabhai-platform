import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'core/config/app_config.dart';
import 'core/di/locator.dart';
import 'core/observability/crash_route_observer.dart';
import 'core/theme/app_theme.dart';
import 'features/auth/domain/auth_session_manager.dart';
import 'features/auth/presentation/lifecycle_relock_observer.dart';
import 'router.dart';

class BadaBhaiApp extends StatefulWidget {
  const BadaBhaiApp({super.key});

  @override
  State<BadaBhaiApp> createState() => _BadaBhaiAppState();
}

class _BadaBhaiAppState extends State<BadaBhaiApp> {
  LifecycleRelockObserver? _relock;
  late final GoRouter _router;

  /// Detaches the Crashlytics screen tracker (see [attachRouterScreenTracking]).
  VoidCallback? _detachScreenTracking;

  @override
  void initState() {
    super.initState();
    // Build the router HERE (not as a process-global) so its redirect +
    // refreshListenable bind to the AuthSessionManager registered right now.
    _router = buildAppRouter();
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
