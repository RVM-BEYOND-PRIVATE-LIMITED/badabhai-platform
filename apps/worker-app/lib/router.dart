import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'core/di/locator.dart';
import 'core/widgets/bb_bottom_nav.dart';
import 'core/widgets/bb_job_card.dart';
import 'features/notifications/domain/notifications_repository.dart';

import 'features/splash/presentation/splash_screen.dart';
import 'features/auth/presentation/phone_login_screen.dart';
import 'features/auth/presentation/otp_verify_screen.dart';
import 'features/consent/presentation/consent_screen.dart';
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
import 'features/swipe/presentation/applied_screen.dart';
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
  static const String consent = '/consent';
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
  static const String applied = '/jobs/applied'; // (keeps bar)
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

/// The app-wide router instance (one per process, like the old `appRoutes` map).
final GoRouter appRouter = _buildRouter();

GoRouter _buildRouter() {
  return GoRouter(
    navigatorKey: _rootNavKey,
    initialLocation: Routes.splash,
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
      GoRoute(
        path: Routes.consent,
        builder: (_, __) => const ConsentScreen(),
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
                  GoRoute(
                    path: 'applied',
                    builder: (_, GoRouterState s) =>
                        AppliedScreen(job: s.extra as BbJobCardData?),
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


