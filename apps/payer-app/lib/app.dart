import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import 'core/config/app_config.dart';
import 'core/di/locator.dart';
import 'core/observability/crash_route_observer.dart';
import 'core/session/app_session.dart';
import 'core/session/app_session_cubit.dart';
import 'core/theme/app_theme.dart';
import 'features/auth/presentation/login_screen.dart';
import 'features/shell/presentation/app_shell.dart';

/// The payer-app root. A single [AppSessionCubit] (provided here) drives the
/// top-level switch: `null` session → Login; a signed-in session → the
/// role-aware [AppShell]. The role is fixed for the session — there is no
/// in-app switch, so re-mounting the shell on sign-in carries the locked role.
class PayerApp extends StatelessWidget {
  const PayerApp({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<AppSessionCubit>.value(
      value: locator<AppSessionCubit>(),
      child: MaterialApp(
        title: 'BadaBhai · Payer',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        // Tag every crash report with the pushed route name. No-op when
        // Crashlytics isn't ready (tests / non-GMS devices).
        navigatorObservers: <NavigatorObserver>[CrashNavigatorObserver()],
        home: const _Root(),
        builder: kUseMocks
            ? (BuildContext context, Widget? child) => Banner(
                  message: 'MOCK',
                  location: BannerLocation.topEnd,
                  color: Colors.deepOrange,
                  child: child ?? const SizedBox.shrink(),
                )
            : null,
      ),
    );
  }
}

class _Root extends StatefulWidget {
  const _Root();

  @override
  State<_Root> createState() => _RootState();
}

class _RootState extends State<_Root> {
  /// Runs ONCE: cold-start rehydrate. Until it resolves the root shows a splash
  /// (never a Login flash) — then null→Login / session→AppShell. Mirrors the
  /// worker app's `bootstrap()` + `isReady` gate.
  Future<void>? _boot;

  @override
  void initState() {
    super.initState();
    _boot = context.read<AppSessionCubit>().bootstrap();
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<void>(
      future: _boot,
      builder: (BuildContext context, AsyncSnapshot<void> snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const _SplashScreen();
        }
        return BlocBuilder<AppSessionCubit, AppSession?>(
          builder: (BuildContext context, AppSession? session) {
            if (session == null) {
              return const LoginScreen();
            }
            // Keyed by role so a fresh sign-in rebuilds the shell with the
            // right nav.
            return AppShell(
                key: ValueKey<PayerRole>(session.role), session: session);
          },
        );
      },
    );
  }
}

/// Neutral boot splash shown while [AppSessionCubit.bootstrap] resolves the
/// persisted session on cold start.
class _SplashScreen extends StatelessWidget {
  const _SplashScreen();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(child: CircularProgressIndicator()),
    );
  }
}
