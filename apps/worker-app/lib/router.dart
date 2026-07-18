import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'core/di/locator.dart';
import 'core/nav/tab_focus.dart';
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
import 'features/voice/presentation/voice_note_screen.dart';
import 'features/kit/presentation/kit_detail_screen.dart';
import 'features/kit/presentation/kit_screen.dart';
import 'features/notifications/presentation/notifications_screen.dart';
import 'features/profile/presentation/profile_preview_screen.dart';
import 'features/invite/presentation/invite_screen.dart';
import 'features/applications/presentation/applied_jobs_screen.dart';
import 'features/profile_tab/presentation/profile_tab_screen.dart';
import 'features/settings/presentation/settings_screen.dart';
import 'features/resume/presentation/building_screen.dart';
import 'features/resume/presentation/resume_edit_screen.dart';
import 'features/resume/presentation/resume_preview_screen.dart';
import 'features/swipe/domain/job_detail.dart';
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

  /// Referral invite (A3) — pushed full-screen from Profile / Settings.
  static const String invite = '/invite';
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

  /// Interview kit. Lives under the PROFILE branch (WA-3): the kit is entered
  /// from the Profile tab, so popping out of it must land back on Profile. It
  /// previously sat under /resume — entering from Profile silently switched the
  /// shell to the Resume branch, and backing out of the kit detail stranded the
  /// worker on the Resume tab.
  static const String kit = '/profile/kit'; // (keeps bar)
  static const String kitDetail = '/profile/kit/detail'; // + '/<tradeKey>' (no bar)
  static const String settings = '/profile/settings'; // (no bar)
  static const String appliedJobs =
      '/profile/applied'; // (no bar) — pushed from Profile, back → Profile
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
/// Returns null (no redirect) when auth isn't wired (legacy widget tests), while
/// [AuthSessionManager.bootstrap] hasn't resolved the cold-start state yet (the
/// worker simply waits on splash), or when persistent-auth is DISABLED (the gate
/// is inert — main's routing). Null otherwise means "stay put".
String? _authRedirect(BuildContext context, GoRouterState state) {
  final AuthSessionManager? auth = _maybeAuth();
  // When persistent-auth is disabled (real/default build until the backend
  // /auth/* contract lands), the gate is INERT — routing matches `main` exactly
  // (splash→login→OTP→consent→onboarding→shell), with the API bearer
  // (SessionRepository.sessionToken) as the only auth gate, as before. This also
  // removes the /otp→/resume bounce that would otherwise fight the consent push.
  if (auth == null || !auth.isReady || !auth.persistentAuthEnabled) return null;

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
      // #349: remember where the worker actually was before the PIN takes over
      // the stack, so unlocking returns them there. `!onAuthRoute` keeps a cold
      // start (loc == /splash) from stashing the splash screen as a destination.
      if (!onAuthRoute) auth.stashResumeLocation(loc);
      // #352: route by whether a PIN actually EXISTS on this device. A worker
      // who killed the app between OTP verify and choosing their first PIN used
      // to cold-start into Enter-PIN and be asked for a PIN that was never set —
      // every guess returned the neutral "wrong PIN", and the only way out was
      // the forgot-PIN OTP (confusing, and it burns a real SMS). Their tokens
      // are already persisted, so send them to set-PIN and let them finish.
      return auth.pinSet ? Routes.pin : Routes.setPin;
    case AuthStatus.authenticated:
      // TD62 — the client half of the DPDP consent gate (§6's server-side
      // ConsentGuard stays authoritative). TRI-STATE on purpose: only a
      // DEFINITIVE `false` from the server (consent_accepted on the OTP/PIN
      // verify response) forces the consent screen; `null` (unknown / an older
      // server without the field) passes through so an old API never bricks
      // routing. Consent is the FIRST onboarding step (consent → name → chat),
      // so /consent itself is the only surface allowed through the gate.
      if (auth.consentAccepted == false && loc != Routes.consent) {
        return Routes.consent;
      }
      // Authenticated workers must not sit on splash/login/pin — lift them into
      // the shell. #349: back to where the re-lock interrupted them when we know
      // it, else the Resume tab as before. PEEKED, not consumed — EnterPinScreen
      // resolves the same target, and a consuming read here would strand it on
      // the fallback.
      if (onAuthRoute) return auth.resumeLocation ?? Routes.resume;
      // Landed on a real screen — the stash has done its job.
      auth.clearResumeLocation();
      return null;
  }
}

/// #380 — the guard for `/jobs/detail/:jobId`. The screen renders the tapped
/// row's REAL [JobDetail], which travels as in-memory `extra`; `extra` survives
/// neither a deep link nor go_router state restoration, and there is no
/// worker-facing job-detail endpoint to re-fetch `:jobId` from. So a navigation
/// that arrives without one has nothing truthful to show — send it to the feed
/// instead of building a screen around a null (or, worse, a fabricated job).
String? _jobDetailRedirect(BuildContext context, GoRouterState state) =>
    state.extra is JobDetail ? null : Routes.jobs;

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
        //
        // #336 — `extra` now also carries the server's `resend_in_seconds`, so
        // the screen opens with the cooldown ALREADY running. It stays tolerant
        // of a bare String: a deep link or an older push that supplies only the
        // phone still works, and simply starts with the resend armed.
        builder: (_, GoRouterState s) {
          final Object? extra = s.extra;
          if (extra is OtpVerifyArgs) {
            return OtpVerifyScreen(phone: extra.phone, resendIn: extra.resendIn);
          }
          return OtpVerifyScreen(phone: extra as String?);
        },
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
        builder: (_, __) => const VoiceNoteScreen(),
      ),
      GoRoute(
        path: Routes.invite,
        builder: (_, __) => const InviteScreen(),
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
                    // The REAL job rides as typed `extra` from the row that was
                    // tapped (feed / applied). There is no worker-facing
                    // job-detail route, so the row's data IS the source of
                    // truth — the screen never synthesises anything.
                    //
                    // #380 — but this route is PATH-addressable and `extra` is
                    // in-memory only: it is not serialized, so a deep link, a
                    // notification tap, or go_router state restoration reaches
                    // `/jobs/detail/<id>` with `extra == null`. The old
                    // `s.extra! as JobDetail` red-screened there with "Null
                    // check operator used on a null value". We cannot fetch the
                    // job by `:jobId` (no worker-facing detail endpoint) and we
                    // must not synthesise one from the id, so degrade the only
                    // truthful way there is: bounce to the feed, where the row
                    // that owns the data lives.
                    redirect: _jobDetailRedirect,
                    builder: (_, GoRouterState s) {
                      final JobDetail? detail = s.extra as JobDetail?;
                      // Belt-and-braces: the redirect above already bounces the
                      // extra-less case, so this only guards against the route
                      // being reached some other way. Never throw at the worker.
                      if (detail == null) return const SwipeJobsScreen();
                      return JobDetailScreen(detail: detail);
                    },
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
                  // Applied jobs — pushed full-screen from Profile (back → Profile),
                  // consistent with how Settings hangs off the Profile branch.
                  GoRoute(
                    path: 'applied',
                    parentNavigatorKey: _rootNavKey, // no bar
                    builder: (_, __) => const AppliedJobsScreen(),
                  ),
                  // Interview kit — NESTED under the Profile branch (WA-3): it
                  // is entered from the Profile tab, so the kit list keeps the
                  // bar with Profile active and popping the detail lands back
                  // here, never on the Resume branch. (Declared on this branch
                  // rather than hacking a tab-index setter — deep links to
                  // /profile/kit/detail/:tradeKey build the correct stack.)
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
class _ShellScaffold extends StatefulWidget {
  const _ShellScaffold({required this.shell});

  final StatefulNavigationShell shell;

  @override
  State<_ShellScaffold> createState() => _ShellScaffoldState();
}

class _ShellScaffoldState extends State<_ShellScaffold> {
  TabFocus get _tabFocus => locator<TabFocus>();

  @override
  void initState() {
    super.initState();
    // Populate the Alerts badge on app open (before the Alerts tab is opened).
    // Best-effort + fire-and-forget — refresh() never throws.
    locator<NotificationsRepository>().refresh();
  }

  /// Publishes the visible tab so each root can refetch when it comes back into
  /// view (the IndexedStack keeps branches mounted, so nothing re-runs on its
  /// own).
  ///
  /// Set SYNCHRONOUSLY here, before `goBranch` builds the target branch: on a
  /// tab's FIRST visit its `create:` already loads, and if the focus signal
  /// landed after that build the root would immediately load a second time.
  /// Setting it first means the root mounts already-focused, and
  /// [TabFocusRefetch] fires on change only.
  void _onTabTapped(int index) {
    final bool reTapped = index == widget.shell.currentIndex;
    _tabFocus.value = index;
    // Re-tapping the active tab resets it to its branch root.
    widget.shell.goBranch(index, initialLocation: reTapped);
  }

  /// Safety net for branch changes that did NOT come from a tap — e.g. the
  /// post-unlock restore or any `context.go` into another branch's location.
  /// Post-framed because listeners must not fire during build; a no-op when the
  /// tap handler already set it.
  void _syncActiveTabAfterBuild() {
    final int index = widget.shell.currentIndex;
    if (_tabFocus.value == index) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _tabFocus.value = index;
    });
  }

  @override
  Widget build(BuildContext context) {
    _syncActiveTabAfterBuild();
    return Scaffold(
      body: widget.shell,
      bottomNavigationBar: ValueListenableBuilder<int>(
        valueListenable: locator<NotificationsRepository>().unreadCount,
        builder: (BuildContext context, int unread, Widget? _) => BbBottomNav(
          currentIndex: widget.shell.currentIndex,
          onTap: _onTabTapped,
          alertsUnread: unread,
        ),
      ),
    );
  }
}


