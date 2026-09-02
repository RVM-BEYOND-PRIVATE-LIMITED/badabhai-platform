import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import 'core/auth/payer_account_deleted_signal.dart';
import 'core/config/app_config.dart';
import 'core/di/locator.dart';
import 'core/observability/crash_route_observer.dart';
import 'core/session/app_session.dart';
import 'core/session/app_session_cubit.dart';
import 'core/theme/app_theme.dart';
import 'core/widgets/bb_alert_dialog.dart';
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
        builder: (BuildContext context, Widget? child) {
          Widget content = child ?? const SizedBox.shrink();
          if (kUseMocks) {
            content = Banner(
              message: 'MOCK',
              location: BannerLocation.topEnd,
              color: Colors.deepOrange,
              child: content,
            );
          }
          // Hard-lock text scale to 1.0x, ignoring the OS accessibility font-size
          // setting entirely — every size on screen is controlled only from code
          // (explicit product decision, superseding the earlier 1.3x clamp that
          // mirrored the worker app, #1072/#1088).
          return MediaQuery(
            data: MediaQuery.of(context).copyWith(textScaler: TextScaler.noScaling),
            child: content,
          );
        },
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

  /// Listens for the backend's "this payer's account is gone" signal (410
  /// PAYER_ACCOUNT_DELETED). One app-scoped subscription for the whole app life.
  StreamSubscription<void>? _accountDeletedSub;

  /// Guards against parallel 410s (several in-flight calls fail at once) showing
  /// more than ONE dialog. Released after the dialog is dismissed + sign-out.
  bool _accountDeletedDialogShown = false;

  @override
  void initState() {
    super.initState();
    _boot = context.read<AppSessionCubit>().bootstrap();
    // Subscribe to the app-scoped signal fired by PayerHttp on a 410
    // { code: PAYER_ACCOUNT_DELETED }. Guarded by `isRegistered` so widget tests
    // that pump the app without wiring DI are unaffected.
    if (locator.isRegistered<AccountDeletedSignal>()) {
      _accountDeletedSub = locator<AccountDeletedSignal>()
          .stream
          .listen((_) => _onAccountDeleted());
    }
  }

  @override
  void dispose() {
    unawaited(_accountDeletedSub?.cancel());
    super.dispose();
  }

  /// The backend has deleted this payer's account server-side. Show ONE
  /// non-dismissible dialog over whatever screen is showing, then hard-logout on
  /// OK — [AppSessionCubit.signOut] wipes the bearer and emits `null`, so the
  /// top-level BlocBuilder swaps to Login. Parallel 410s collapse to a single
  /// dialog via [_accountDeletedDialogShown].
  Future<void> _onAccountDeleted() async {
    if (_accountDeletedDialogShown) return;
    // `_Root` is mounted as `home:` for the whole app life, so its own context
    // carries the Overlay / Directionality / Localizations the dialog needs.
    // Defensive: if it is ever gone, the next authed call re-fires the signal.
    if (!mounted) return;
    _accountDeletedDialogShown = true;
    // A single OK button; copy stays honest + simple.
    await showBbAlert(
      context,
      title: 'Account nahi mila',
      message:
          'Hamein aapka account nahi mil raha hai. Kripya dobara login karein.',
    );
    // Hard logout: revoke the server session (best-effort), wipe the bearer, emit
    // null (→ Login), reset the shared CreditsCubit. Do this BEFORE releasing the
    // guard: a second in-flight 410 must not re-open the dialog in the window
    // between the OK tap and the wipe. Once signed out no further call can 410, so
    // it is then safe to release the guard.
    if (locator.isRegistered<AppSessionCubit>()) {
      await locator<AppSessionCubit>().signOut();
    }
    _accountDeletedDialogShown = false;
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
