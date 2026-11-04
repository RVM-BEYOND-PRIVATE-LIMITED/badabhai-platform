import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/observability/crash_reporter.dart';
import '../../../core/session/app_session.dart';
import '../../../core/session/app_session_cubit.dart';
import '../../../core/session/credits_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_system_ui.dart';
import '../../../core/widgets/bb_bottom_nav.dart';
import '../../../core/widgets/bb_leave_guard.dart';
import '../../../core/widgets/bb_overlay_host.dart';
import '../../credits/presentation/credits_screen.dart';
import '../../find/presentation/find_screen.dart';
import '../../find/presentation/reveal_args.dart';
import '../../find/presentation/reveal_screen.dart';
import '../../home/presentation/home_screen.dart';
import '../../job_posting_chat/presentation/job_posting_chat_screen.dart';
import '../../jobs/presentation/jobs_screen.dart';
import '../../jobs/presentation/post_job_screen.dart';
import '../../account/presentation/account_screen.dart';
import '../../referral/presentation/referral_screen.dart';

/// The signed-in shell. Holds the bottom nav and an in-shell navigation model
/// mirroring the kit: a primary [_tab] (a nav destination) and an optional
/// [_sub] overlay (Post / Credits / Reveal) pushed above it with a back
/// affordance. The credit balance is loaded once here and shared app-wide.
///
/// The agency-only Earn tab (hub · referral · referred workers · payouts · KYC)
/// was REMOVED: none of those surfaces had a backend route, so every figure was
/// invented, and the KYC form collected real PAN/bank details that were then
/// discarded behind a fake "in review". Both roles now share the same tabs;
/// `Credits` is real (`GET /payer/credits`) for a company and an agency alike.
class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.session});

  final AppSession session;

  /// The full-bleed blue strip behind the status bar on a bare Home (#2590).
  @visibleForTesting
  static const Key statusBarStripKey = Key('app_shell_status_bar_strip');

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  String _tab = 'home';
  String? _sub;
  RevealArgs? _revealed;

  /// The chat session the 'aiPost' overlay should RESUME (ADR-0035 cross-device
  /// pickup), or null to start a fresh conversation. Cleared on [_back] so the
  /// next open does not silently reopen a finished chat.
  String? _resumeChatId;

  /// Per-tab refresh epochs. Selecting a tab bumps ITS epoch, so only that
  /// branch is rebuilt with fresh cubits and a fresh load — the data is never
  /// stale just because IndexedStack kept the screen mounted. Other tabs keep
  /// their key (and their state) until they are selected again.
  final Map<String, int> _tabEpochs = <String, int>{};

  int _epochOf(String id) => _tabEpochs[id] ?? 0;

  /// #2591 — bumped on every overlay open. The overlay animates OUT for
  /// the page duration; keying each open on its own epoch guarantees a reopen
  /// inside that window still mounts a fresh screen (a blank Post form).
  int _overlayEpoch = 0;

  /// #382 — the tabs the payer has actually opened. The branches live in an
  /// [IndexedStack] so leaving a tab HIDES it instead of disposing it, but a
  /// never-visited tab stays an empty placeholder: mounting all five eagerly
  /// would fire every tab's `load()` on cold start (Find alone costs
  /// `GET /payer/job-postings` + `GET /payer/reach/jobs/:id/applicants`) for
  /// surfaces the payer may never open. Grows to at most five entries.
  final Set<String> _visited = <String>{'home'};

  /// The view the next Find mount opens on: All candidates (owner rulings
  /// 2026-11-03) unless a Jobs card's "Applicants" button opened it. Read only
  /// when the Find branch is (re)built for a new epoch.
  FindView _findView = FindView.allCandidates;

  /// #2595 — the open overlay's unsaved-changes guard (Post, the AI chat): the
  /// shell asks it before its own system Back or a nav tap leaves the overlay.
  final BbLeaveGuardController _leaveGuard = BbLeaveGuardController();

  /// #2595 — overlays that are full-screen TASKS with their own pinned bar:
  /// the app's bottom nav hides under them (it stacked as a second bar under
  /// Post's action bar and the AI chat's composer). Leaving one is its back
  /// arrow or the system Back, which its leave guard asks about; a nav tap
  /// that leaves any other overlay still goes through the guard
  /// ([_onNavSelect]).
  static const Set<String> _fullScreenTasks = <String>{'post', 'aiPost'};

  @override
  void initState() {
    super.initState();
    locator<CreditsCubit>().load();
    CrashReporter.setScreen('payer/$_tab'); // seed the shell's initial screen
  }

  static const List<BbNavTab> _tabs = <BbNavTab>[
    BbNavTab(
      id: 'home',
      label: 'Home',
      iconInactive: Icons.home_rounded,
      iconActive: Icons.home_rounded,
    ),
    BbNavTab(
      id: 'find',
      label: 'Find',
      iconInactive: Icons.search_rounded,
      iconActive: Icons.search_rounded,
    ),
    BbNavTab(
      id: 'jobs',
      label: 'Jobs',
      iconInactive: Icons.work_rounded,
      iconActive: Icons.work_rounded,
    ),
    BbNavTab(
      id: 'credits',
      label: 'Credits',
      iconInactive: Icons.lock_open_rounded,
      iconActive: Icons.lock_open_rounded,
    ),
    BbNavTab(
      id: 'account',
      label: 'Account',
      iconInactive: Icons.person_rounded,
      iconActive: Icons.person_rounded,
    ),
  ];

  /// [findView] picks the view a Find visit opens on; every other caller (the
  /// nav, Home's Browse) gets the default, All candidates.
  void _selectTab(String id, {FindView findView = FindView.allCandidates}) {
    _leaveGuard.release();
    setState(() {
      _tab = id;
      _sub = null;
      _findView = findView;
      _visited.add(id);
      // Every visit re-reads the screen's API. The branch keeps its identity
      // while hidden; this key bump is what makes the revisit fetch again.
      _tabEpochs[id] = _epochOf(id) + 1;
      CrashReporter.setScreen('payer/$id');
    });
    // Home/Find/Credits all read the shared balance; refresh it with the tab.
    locator<CreditsCubit>().load();
  }

  void _openSub(String id) => setState(() {
        _overlayEpoch++;
        _sub = id;
        CrashReporter.setScreen('payer/$id');
      });

  /// A bottom-nav tap. With an overlay open it LEAVES that overlay, so one
  /// holding unsaved input asks first (#2595).
  void _onNavSelect(String id) {
    if (_sub == null) {
      _selectTab(id);
    } else {
      _leaveGuard.leaveThen(() => _selectTab(id));
    }
  }

  void _back() => setState(() {
        _leaveGuard.release();
        _sub = null;
        _revealed = null;
        _resumeChatId = null;
        CrashReporter.setScreen('payer/$_tab');
      });

  /// Opens the AI job-posting chat (ADR-0035). A non-null [resumeSessionId]
  /// picks an existing conversation back up — the mobile half of cross-device
  /// resume; null starts a new one.
  void _openAiPost(String? resumeSessionId) => setState(() {
        _overlayEpoch++;
        _resumeChatId = resumeSessionId;
        _sub = 'aiPost';
        CrashReporter.setScreen('payer/aiPost');
      });

  void _openReveal(RevealArgs args) => setState(() {
        _overlayEpoch++;
        _revealed = args;
        _sub = 'reveal';
        CrashReporter.setScreen('payer/reveal');
      });

  /// Opens the agency supply hub (Refer & earn) as a full-page route — the same
  /// agent-only surface the Account entry pushes. A real route (not an in-shell
  /// overlay) so Android back pops it normally. Only wired for an agency session.
  void _openReferral() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        settings: const RouteSettings(name: 'payer/agency/referral'),
        builder: (_) => const ReferralScreen(),
      ),
    );
  }

  /// One tab branch, or an empty placeholder until that tab has been visited
  /// (see [_visited]). Every branch here builds its own `BlocProvider`, so what
  /// this returns is exactly what the IndexedStack keeps alive.
  Widget _tabBody(String id) {
    if (!_visited.contains(id)) return const SizedBox.shrink();
    // A new epoch disposes that branch's cubits and mounts fresh ones, whose
    // `create` runs the screen's load — the "latest data on every return" rule.
    return KeyedSubtree(
      key: ValueKey<String>('$id:${_epochOf(id)}'),
      // #2590 — Home draws its blue identity header BEHIND the status bar (it
      // pads itself by the top inset); every other branch keeps the top inset.
      child: id == 'home'
          ? _tabScreen(id)
          : SafeArea(bottom: false, child: _tabScreen(id)),
    );
  }

  Widget _tabScreen(String id) {
    return switch (id) {
      'home' => HomeScreen(
          session: widget.session,
          onPost: () => _openSub('post'),
          onBrowse: () => _selectTab('find'),
          onOpenCredits: () => _selectTab('credits'),
          // Agency-only: the Home supply hub. Null for a company session, so the
          // Home agency section never renders for a company.
          onOpenReferral: widget.session.isAgency ? _openReferral : null,
        ),
      'find' => FindScreen(onReveal: _openReveal, initialView: _findView),
      'jobs' => JobsScreen(
          onPost: () => _openSub('post'),
          onAiPost: _openAiPost,
          // Both session kinds see their candidates on the shared Find tab —
          // a job card's "Applicants" button lands on the Applicants view
          // (the per-job feed, unchanged: it opens on the first open job).
          onApplicants: () => _selectTab('find', findView: FindView.applicants),
        ),
      // M9 (#2597): a tab root has no back arrow; the bottom nav is the way
      // out. The pushed Credits overlay below keeps its back.
      'credits' => const CreditsScreen(),
      'account' => AccountScreen(
          session: widget.session,
          onSignOut: () => context.read<AppSessionCubit>().signOut(),
        ),
      _ => const SizedBox.shrink(),
    };
  }

  Widget _buildBody() {
    // #382 — the branches live in an IndexedStack, so leaving a tab hides it
    // instead of tearing it down. Latest-on-switch is a deliberate follow-up:
    // `_selectTab` bumps THAT tab's epoch (see _tabBody), which rebuilds only
    // the selected branch with fresh cubits and a fresh API read. Hidden tabs
    // keep their state.
    final String? sub = _sub;
    final int tabIndex = _tabs.indexWhere((BbNavTab t) => t.id == _tab);
    final Widget tabs = IndexedStack(
      // An unknown tab id falls back to the first branch — the old switch's
      // SizedBox default, minus the risk of an out-of-range stack index.
      index: tabIndex < 0 ? 0 : tabIndex,
      // The body was previously the Scaffold's full-bleed child; the default
      // loose sizing would shrink-wrap it, so keep the tight fill.
      sizing: StackFit.expand,
      children: <Widget>[
        for (final BbNavTab tab in _tabs) _tabBody(tab.id),
      ],
    );
    // #2591 — the overlay sits ABOVE the tabs in a [BbOverlayHost], which
    // animates it in and out (it used to hard-cut as an IndexedStack slot) and
    // keeps the tabs mounted-but-offstage while it covers them. Unlike a tab
    // the overlay is deliberately rebuilt from scratch on open/dismiss: Post
    // must open on a blank form, and Reveal is bound to the [RevealArgs] of
    // the card that opened it.
    final Widget stack = BbOverlayHost(
      base: tabs,
      overlay: sub == null
          ? null
          : SafeArea(
              key: ValueKey<int>(_overlayEpoch),
              bottom: false,
              child: switch (sub) {
                'post' => PostJobScreen(onBack: _back),
                'aiPost' => JobPostingChatScreen(
                    // A fresh chat and a resumed one are different
                    // conversations — key on the session so reopening never
                    // reuses the old bloc.
                    key: ValueKey<String>('aiPost:${_resumeChatId ?? 'new'}'),
                    onBack: _back,
                    resumeSessionId: _resumeChatId,
                    onPublished: () => setState(() {
                      _tabEpochs['jobs'] = _epochOf('jobs') + 1;
                    }),
                  ),
                'credits' => CreditsScreen(onBack: _back),
                'reveal' => RevealScreen(args: _revealed!, onBack: _back),
                _ => const SizedBox.shrink(),
              },
            ),
    );
    // #1087 — cap the content column on tablets/foldables so it never stretches
    // to an unreadable line length. The page background stays full-bleed (the
    // Scaffold canvas shows outside the cap); only the content is centred.
    final Widget capped = Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: AppSpacing.appMax),
        // #2595 — the open overlay's leave guard registers here (a tab never
        // carries one; the shell only asks while an overlay is open).
        child: BbLeaveGuardScope(controller: _leaveGuard, child: stack),
      ),
    );
    // #2590 — Home's blue header runs under the status bar and asks for light
    // icons, but the column is capped at appMax. On a wider screen the bar
    // corners (clock, battery) would show the light canvas, so a full-bleed
    // blue strip of the status-bar height sits behind the capped column. The
    // Stack is always present (only the strip toggles) so switching tabs never
    // reparents — and so never remounts — the IndexedStack branches (#382).
    final bool bareHome = sub == null && _tab == 'home';
    return Stack(
      children: <Widget>[
        Positioned(
          top: 0,
          left: 0,
          right: 0,
          height: MediaQuery.paddingOf(context).top,
          child: bareHome
              ? const ColoredBox(
                  key: AppShell.statusBarStripKey,
                  color: AppColors.blue,
                )
              : const SizedBox.shrink(),
        ),
        capped,
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    // The active nav id stays highlighted while a sub-overlay is open if the
    // overlay belongs to that tab; default to the current tab otherwise.
    final String navId = _tab;
    // #359 — the tab and the Post/Credits/Reveal overlays are setState state,
    // NOT Navigator routes, so the Android system back used to reach the
    // shell's root route unopposed and finish the activity: a half-filled
    // Post-a-job form (11 controllers of typed input) was lost on the primary
    // Android affordance, with only the small in-screen arrow doing the right
    // thing. Back now unwinds the in-shell stack the way the payer built it —
    // overlay first, then a non-home tab back to Home — and only bubbles out
    // (exiting the app) from a bare Home, which is the shell's true root.
    // Routes pushed above the shell (Disclosure history, dialogs) are real
    // routes and pop normally; this PopScope belongs to the shell's route and
    // never sees their back presses.
    return PopScope<Object?>(
      canPop: _sub == null && _tab == 'home',
      onPopInvokedWithResult: (bool didPop, Object? result) {
        if (didPop) return;
        if (_sub != null) {
          // #2595 — an overlay holding unsaved input asks before it goes.
          _leaveGuard.leaveThen(_back);
        } else if (_tab != 'home') {
          _selectTab('home');
        }
      },
      child: Scaffold(
        backgroundColor: AppColors.surfacePage,
        // #2590 — the top inset is applied per branch (see _tabBody) so Home's
        // header can run under the status bar; the canvas gets dark icons.
        body: AnnotatedRegion<SystemUiOverlayStyle>(
          value: AppSystemUi.onLight,
          child: SafeArea(top: false, bottom: false, child: _buildBody()),
        ),
        bottomNavigationBar: _fullScreenTasks.contains(_sub)
            ? null
            : BbBottomNav(
                tabs: _tabs,
                currentId: navId,
                onSelect: _onNavSelect,
              ),
      ),
    );
  }
}
