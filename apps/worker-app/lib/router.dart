import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'core/theme/app_colors.dart';
import 'core/theme/app_typography.dart';
import 'core/widgets/bb_app_bar.dart';
import 'core/widgets/bb_bottom_nav.dart';

import 'features/splash/presentation/splash_screen.dart';
import 'features/auth/presentation/phone_login_screen.dart';
import 'features/auth/presentation/otp_verify_screen.dart';
import 'features/consent/presentation/consent_screen.dart';
import 'features/chat/presentation/chat_profiling_screen.dart';
import 'features/voice/presentation/voice_note_placeholder_screen.dart';
import 'features/profile/presentation/profile_preview_screen.dart';
import 'features/resume/presentation/resume_preview_screen.dart';
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
        // TODO(stage-5): replace with the real Building screen (BbSpinner +
        // ResumeCubit generate → go(resume)). Placeholder auto-advances for now.
        builder: (_, __) => const _BuildingPlaceholder(),
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
                        _Placeholder('Job detail · ${s.pathParameters['jobId']}'),
                  ),
                  GoRoute(
                    path: 'applied',
                    builder: (_, __) => const _Placeholder('Applied'),
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
                builder: (_, __) => const ResumePreviewScreen(),
                routes: <RouteBase>[
                  GoRoute(
                    path: 'edit',
                    parentNavigatorKey: _rootNavKey, // no bar
                    builder: (_, __) => const _Placeholder('Resume edit'),
                  ),
                  GoRoute(
                    path: 'kit',
                    builder: (_, __) => const _Placeholder('Interview kit'),
                    routes: <RouteBase>[
                      GoRoute(
                        path: 'detail/:tradeKey',
                        parentNavigatorKey: _rootNavKey, // no bar
                        builder: (_, GoRouterState s) => _Placeholder(
                            'Kit · ${s.pathParameters['tradeKey']}'),
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
                builder: (_, __) => const _Placeholder('Profile'),
                routes: <RouteBase>[
                  GoRoute(
                    path: 'settings',
                    parentNavigatorKey: _rootNavKey, // no bar
                    builder: (_, __) => const _Placeholder('Settings'),
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
                builder: (_, __) => const _Placeholder('Alerts'),
              ),
            ],
          ),
        ],
      ),
    ],
  );
}

/// The persistent shell: tab bodies + the spec 4-tab [BbBottomNav].
///
/// TODO(stage-7): wire `alertsUnread` to the notifications bloc/AppState.
class _ShellScaffold extends StatelessWidget {
  const _ShellScaffold({required this.shell});

  final StatefulNavigationShell shell;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: shell,
      bottomNavigationBar: BbBottomNav(
        currentIndex: shell.currentIndex,
        // Re-tapping the active tab resets it to its branch root.
        onTap: (int i) =>
            shell.goBranch(i, initialLocation: i == shell.currentIndex),
      ),
    );
  }
}

/// Temporary "coming soon" body for screens built in later stages.
class _Placeholder extends StatelessWidget {
  const _Placeholder(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: BbAppBar(title: label),
      body: Center(
        child: Text(
          '$label\n(coming soon)',
          textAlign: TextAlign.center,
          style: AppTypography.body(color: AppColors.textSecondary),
        ),
      ),
    );
  }
}

/// Minimal stand-in for the Building screen: shows a spinner, then enters the
/// shell at the Resume tab. The real screen (Stage 5) generates via ResumeCubit.
class _BuildingPlaceholder extends StatefulWidget {
  const _BuildingPlaceholder();

  @override
  State<_BuildingPlaceholder> createState() => _BuildingPlaceholderState();
}

class _BuildingPlaceholderState extends State<_BuildingPlaceholder> {
  @override
  void initState() {
    super.initState();
    Future<void>.delayed(const Duration(milliseconds: 1200), () {
      if (mounted) context.go(Routes.resume);
    });
  }

  @override
  Widget build(BuildContext context) {
    return const Scaffold(body: Center(child: CircularProgressIndicator()));
  }
}
