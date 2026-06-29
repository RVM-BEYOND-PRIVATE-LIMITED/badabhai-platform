import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'core/di/locator.dart';
import 'core/widgets/bb_bottom_nav.dart';
import 'features/auth/domain/auth_session_manager.dart';
import 'features/notifications/domain/notifications_repository.dart';

import 'features/splash/presentation/splash_screen.dart';
import 'features/auth/presentation/phone_login_screen.dart';
import 'features/auth/presentation/otp_verify_screen.dart';
import 'features/auth/presentation/enter_pin_screen.dart';
import 'features/auth/presentation/set_pin_screen.dart';
import 'features/auth/presentation/forgot_pin_screen.dart';
import 'features/auth/presentation/devices_screen.dart';
import 'features/consent/presentation/consent_screen.dart';
import 'features/name/presentation/name_screen.dart';
import 'features/chat/presentation/chat_profiling_screen.dart';
import 'features/voice/presentation/voice_note_placeholder_screen.dart';
import 'features/kit/presentation/kit_detail_screen.dart';
import 'features/kit/presentation/kit_screen.dart';
import 'features/notifications/presentation/notifications_screen.dart';
import 'features/profile/presentation/profile_preview_screen.dart';
import 'features/profile_tab/presentation/profile_tab_screen.dart';
import 'features/settings/presentation/settings_screen.dart';
import 'features/resume/presentation/building_screen.dart';
import 'features/resume/presentation/resume_edit_screen.dart';
import 'features/resume/presentation/resume_preview_screen.dart';
import 'features/swipe/presentation/job_detail_screen.dart';
import 'features/swipe/presentation/swipe_jobs_screen.dart';

/// Route locations for the worker app (ADR-0023). Kept as string constants so
/// call-sites read `context.go(Routes.x)` and migrate mechanically from the old
/// `Navigator.pushNamed(Routes.x)`.
class Routes {
  Routes._();

  // --- Onboarding (linear, no bottom nav) ---
  static const String splash = '/';
  static const String phoneLogin = '/login';
  static const String otpVerify = '/otp';

  // --- Persistent auth (PASS 2) ---
  /// Enter-PIN unlock (the cold-start / re-lock fast path).
  static const String pin = '/pin';

  /// Set / reset PIN (new user or forgot-PIN).
  static const String setPin = '/pin/set';

  /// Forgot-PIN: re-verify OTP, then set a fresh PIN.
  static const String forgotPin = '/pin/forgot';

  /// My-devices list (reachable from Settings).
  static const String devices = '/profile/settings/devices';

  static const String consent = '/consent';
  static const String name = '/name'; // "Your name" step (after consent, before chat)
  static const String chatProfiling = '/chat';
  static const String voiceNote = '/voice';

  /// The profiling *preview/confirm* (distinct from the Profile tab at /profile).
  static const String profilePreview = '/profiling';
  static const String building = '/building';

  // --- Shell branch roots (persistent bottom nav) ---
  static const String jobs = '/jobs'; // Feed (Jobs tab)
  static const String resume = '/resume'; // Resume ready (Resume tab root + onboarding endpoint)
  static const String profile = '/profile'; // Profile tab
  static const String alerts = '/alerts'; // Notifications (Alerts tab)

  // --- Shell sub-routes (append the id where noted) ---
  static const String jobDetail = '/jobs/detail'; // + '/<jobId>'  (no bar)
  static const String resumeEdit = '/resume/edit'; // (no bar)
  static const String kit = '/resume/kit'; // (keeps bar)
  static const String kitDetail = '/resume/kit/detail'; // + '/<tradeKey>' (no bar)
  static const String settings = '/profile/settings'; // (no bar)
}

/// Root navigator — onboarding routes and every "no bar" full-screen route render
/// here (a `parentNavigatorKey: _rootNavKey` route covers the shell).
final GlobalKey<NavigatorState> _rootNavKey =
    GlobalKey<NavigatorState>(debugLabel: 'root');
final GlobalKey<NavigatorState> _jobsNavKey =
    GlobalKey<NavigatorState>(debugLabel: 'jobs');
final GlobalKey<NavigatorState> _resumeNavKey =
    GlobalKey<NavigatorState>(debugLabel: 'resume');
final GlobalKey<NavigatorState> _profileNavKey =
    GlobalKey<NavigatorState>(debugLabel: 'profile');
final GlobalKey<NavigatorState> _alertsNavKey =
    GlobalKey<NavigatorState>(debugLabel: 'alerts');

/// Builds a router bound to the CURRENTLY-registered [AuthSessionManager] (its
/// `refreshListenable`). Built once per [BadaBhaiApp] instance in `initState`
/// (no longer a process-global final) so each app — and each test that re-wires
/// the locator — gets a redirect that reacts to the live auth status. Legacy
/// widget tests that don't wire auth get an inert redirect (null manager).
GoRouter buildAppRouter() => _buildRouter();

/// Routes the auth redirect treats as "auth surface" — reachable while NOT
/// authenticated (splash + the whole login/PIN journey). Everything else (the
/// shell + onboarding) requires [AuthStatus.authenticated].
const Set<String> _authRoutes = <String>{
  Routes.splash,
  Routes.phoneLogin,
  Routes.otpVerify,
  Routes.pin,
  Routes.setPin,
  Routes.forgotPin,
};

/// Resolve the [AuthSessionManager] if the auth graph is wired (it is in the
/// real app + the e2e/auth tests). Returns null under the legacy widget tests
/// that pump [BadaBhaiApp] without `initAuthLocator` — in which case the
/// redirect is INERT and app-open routing behaves exactly as before.
AuthSessionManager? _maybeAuth() =>
    locator.isRegistered<AuthSessionManager>() ? locator<AuthSessionManager>() : null;

/// The auth gate (PASS 2 §5). Driven by [AuthSessionManager]:
///  - `loggedOut`  → force to `/login` (unless already on an auth route),
///  - `locked`     → force to `/pin` (the enter-PIN fast path),
///  - `authenticated` → block the auth routes (bounce login/PIN into the shell);
///    onboarding + shell are otherwise allowed.
///
/// Returns null (no redirect) when auth isn't wired (legacy widget tests) or
/// while [AuthSessionManager.bootstrap] hasn't resolved the cold-start state yet
/// (the worker simply waits on splash). Null otherwise means "stay put".
String? _authRedirect(BuildContext context, GoRouterState state) {
  final AuthSessionManager? auth = _maybeAuth();
  if (auth == null || !auth.isReady) return null;

  final String loc = state.matchedLocation;
  final bool onAuthRoute = _authRoutes.contains(loc);

  switch (auth.status) {
    case AuthStatus.loggedOut:
      // The pre-auth surface is reachable: splash → phone → OTP, plus the
      // forgot-PIN OTP flow. Everything else (shell + onboarding) is forced to
      // login. (Set-PIN is NOT reachable while loggedOut — a PIN can only be set
      // after an OTP verify, which flips the status to locked/authenticated.)
      if (loc == Routes.splash ||
          loc == Routes.phoneLogin ||
          loc == Routes.otpVerify ||
          loc == Routes.forgotPin) {
        return null;
      }
      return Routes.phoneLogin;
    case AuthStatus.locked:
      // Reachable while locked: enter-PIN, set-PIN (a brand-new user is "locked"
      // between OTP verify and choosing their first PIN), and the forgot-PIN OTP
      // flow. `otpVerify` is allowed too so the OTP→set-PIN hand-off isn't
      // bounced to enter-PIN by the redirect that fires on the status change.
      if (loc == Routes.pin ||
          loc == Routes.setPin ||
          loc == Routes.forgotPin ||
          loc == Routes.otpVerify) {
        return null;
      }
      return Routes.pin;
    case AuthStatus.authenticated:
      // Authenticated workers must not sit on splash/login/pin — lift them into
      // the shell (the worker's home tab). Onboarding + shell routes pass.
      if (onAuthRoute) return Routes.resume;
      return null;
  }
}

GoRouter _buildRouter() {
  return GoRouter(
    navigatorKey: _rootNavKey,
    initialLocation: Routes.splash,
    // Re-run the redirect whenever the auth status changes (login, unlock,
    // re-lock, reauth). Null when auth isn't wired (legacy widget tests).
    refreshListenable: _maybeAuth(),
    redirect: _authRedirect,
    routes: <RouteBase>[
      // ---------------- Onboarding (no bottom nav) ----------------
      GoRoute(
        path: Routes.splash,
        builder: (_, __) => const SplashScreen(),
      ),
      GoRoute(
        path: Routes.phoneLogin,
        builder: (_, __) => const PhoneLoginScreen(),
      ),
      GoRoute(
        path: Routes.otpVerify,
        // The submitted phone rides as typed `extra` (was ModalRoute arguments).
        builder: (_, GoRouterState s) =>
            OtpVerifyScreen(phone: s.extra as String?),
      ),
      // ---------------- Persistent auth (PASS 2) ----------------
      GoRoute(
        path: Routes.pin,
        builder: (_, __) => const EnterPinScreen(),
      ),
      GoRoute(
        path: Routes.setPin,
        // `extra == true` → reset mode (forgot-PIN), else new-user onboarding.
        builder: (_, GoRouterState s) =>
            SetPinScreen(isReset: s.extra == true),
      ),
      GoRoute(
        path: Routes.forgotPin,
        builder: (_, __) => const ForgotPinScreen(),
      ),
      GoRoute(
        path: Routes.consent,
        builder: (_, __) => const ConsentScreen(),
      ),
      GoRoute(
        path: Routes.name,
        builder: (_, __) => const NameScreen(),
      ),
      GoRoute(
        path: Routes.chatProfiling,
        builder: (_, __) => const ChatProfilingScreen(),
      ),
      GoRoute(
        path: Routes.voiceNote,
        builder: (_, __) => const VoiceNotePlaceholderScreen(),
      ),
      GoRoute(
        path: Routes.profilePreview,
        builder: (_, __) => const ProfilePreviewScreen(),
      ),
      GoRoute(
        path: Routes.building,
        builder: (_, __) => const BuildingScreen(),
      ),

      // ---------------- Shell (persistent 4-tab bottom nav) ----------------
      StatefulShellRoute.indexedStack(
        builder: (_, __, StatefulNavigationShell shell) =>
            _ShellScaffold(shell: shell),
        branches: <StatefulShellBranch>[
          // ---- Jobs ----
          StatefulShellBranch(
            navigatorKey: _jobsNavKey,
            routes: <RouteBase>[
              GoRoute(
                path: Routes.jobs,
                // TODO(stage-3): SwipeJobsScreen evolves into the rich Feed/deck.
                builder: (_, __) => const SwipeJobsScreen(),
                routes: <RouteBase>[
                  GoRoute(
                    path: 'detail/:jobId',
                    parentNavigatorKey: _rootNavKey, // full-screen, no bar
                    builder: (_, GoRouterState s) =>
                        JobDetailScreen(jobId: s.pathParameters['jobId']!),
                  ),
                ],
              ),
            ],
          ),
          // ---- Resume ----
          StatefulShellBranch(
            navigatorKey: _resumeNavKey,
            routes: <RouteBase>[
              GoRoute(
                path: Routes.resume,
                builder: (_, GoRouterState s) =>
                    ResumePreviewScreen(initialResume: s.extra as String?),
                routes: <RouteBase>[
                  GoRoute(
                    path: 'edit',
                    parentNavigatorKey: _rootNavKey, // no bar
                    builder: (_, __) => const ResumeEditScreen(),
                  ),
                  GoRoute(
                    path: 'kit',
                    builder: (_, __) => const KitScreen(),
                    routes: <RouteBase>[
                      GoRoute(
                        path: 'detail/:tradeKey',
                        parentNavigatorKey: _rootNavKey, // no bar
                        builder: (_, GoRouterState s) => KitDetailScreen(
                            tradeKey: s.pathParameters['tradeKey']!),
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
          // ---- Profile ----
          StatefulShellBranch(
            navigatorKey: _profileNavKey,
            routes: <RouteBase>[
              GoRoute(
                path: Routes.profile,
                builder: (_, __) => const ProfileTabScreen(),
                routes: <RouteBase>[
                  GoRoute(
                    path: 'settings',
                    parentNavigatorKey: _rootNavKey, // no bar
                    builder: (_, __) => const SettingsScreen(),
                    routes: <RouteBase>[
                      GoRoute(
                        path: 'devices',
                        parentNavigatorKey: _rootNavKey, // no bar
                        builder: (_, __) => const DevicesScreen(),
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
          // ---- Alerts ----
          StatefulShellBranch(
            navigatorKey: _alertsNavKey,
            routes: <RouteBase>[
              GoRoute(
                path: Routes.alerts,
                builder: (_, __) => const NotificationsScreen(),
              ),
            ],
          ),
        ],
      ),
    ],
  );
}

/// The persistent shell: tab bodies + the spec 4-tab [BbBottomNav]. The Alerts
/// unread badge tracks the shared [NotificationsRepository]'s reactive count.
class _ShellScaffold extends StatelessWidget {
  const _ShellScaffold({required this.shell});

  final StatefulNavigationShell shell;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: shell,
      bottomNavigationBar: ValueListenableBuilder<int>(
        valueListenable: locator<NotificationsRepository>().unreadCount,
        builder: (BuildContext context, int unread, Widget? _) => BbBottomNav(
          currentIndex: shell.currentIndex,
          // Re-tapping the active tab resets it to its branch root.
          onTap: (int i) =>
              shell.goBranch(i, initialLocation: i == shell.currentIndex),
          alertsUnread: unread,
        ),
      ),
    );
  }
}


