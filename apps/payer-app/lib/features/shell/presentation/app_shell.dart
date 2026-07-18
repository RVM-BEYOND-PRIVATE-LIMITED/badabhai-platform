import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/observability/crash_reporter.dart';
import '../../../core/session/app_session.dart';
import '../../../core/session/app_session_cubit.dart';
import '../../../core/session/credits_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/widgets/bb_bottom_nav.dart';
import '../../credits/presentation/credits_screen.dart';
import '../../find/presentation/find_screen.dart';
import '../../find/presentation/reveal_args.dart';
import '../../find/presentation/reveal_screen.dart';
import '../../home/presentation/home_screen.dart';
import '../../jobs/presentation/jobs_screen.dart';
import '../../jobs/presentation/post_job_screen.dart';
import '../../account/presentation/account_screen.dart';

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

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  String _tab = 'home';
  String? _sub;
  RevealArgs? _revealed;

  /// #382 — the tabs the payer has actually opened. The branches live in an
  /// [IndexedStack] so leaving a tab HIDES it instead of disposing it, but a
  /// never-visited tab stays an empty placeholder: mounting all five eagerly
  /// would fire every tab's `load()` on cold start (Find alone costs
  /// `GET /payer/job-postings` + `GET /payer/reach/jobs/:id/applicants`) for
  /// surfaces the payer may never open. Grows to at most five entries.
  final Set<String> _visited = <String>{'home'};

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
      iconInactive: Icons.home_outlined,
      iconActive: Icons.home,
    ),
    BbNavTab(
      id: 'find',
      label: 'Find',
      iconInactive: Icons.search,
      iconActive: Icons.search,
    ),
    BbNavTab(
      id: 'jobs',
      label: 'Jobs',
      iconInactive: Icons.work_outline,
      iconActive: Icons.work,
    ),
    BbNavTab(
      id: 'credits',
      label: 'Credits',
      iconInactive: Icons.lock_open_outlined,
      iconActive: Icons.lock_open,
    ),
    BbNavTab(
      id: 'account',
      label: 'Account',
      iconInactive: Icons.person_outline,
      iconActive: Icons.person,
    ),
  ];

  void _selectTab(String id) => setState(() {
        _tab = id;
        _sub = null;
        // #382 — first visit mounts the branch; from then on it stays in the
        // tree and keeps its cubit, list and scroll offset.
        _visited.add(id);
        CrashReporter.setScreen('payer/$id');
      });

  void _openSub(String id) => setState(() {
        _sub = id;
        CrashReporter.setScreen('payer/$id');
      });

  void _back() => setState(() {
        _sub = null;
        _revealed = null;
        CrashReporter.setScreen('payer/$_tab');
      });

  void _openReveal(RevealArgs args) => setState(() {
        _revealed = args;
        _sub = 'reveal';
        CrashReporter.setScreen('payer/reveal');
      });

  /// One tab branch, or an empty placeholder until that tab has been visited
  /// (see [_visited]). Every branch here builds its own `BlocProvider`, so what
  /// this returns is exactly what the IndexedStack keeps alive.
  Widget _tabBody(String id) {
    if (!_visited.contains(id)) return const SizedBox.shrink();
    return switch (id) {
      'home' => HomeScreen(
          session: widget.session,
          onPost: () => _openSub('post'),
          onBrowse: () => _selectTab('find'),
          onOpenCredits: () => _selectTab('credits'),
        ),
      'find' => FindScreen(onReveal: _openReveal),
      'jobs' => JobsScreen(onPost: () => _openSub('post')),
      'credits' => CreditsScreen(onBack: () => _selectTab('home')),
      'account' => AccountScreen(
          session: widget.session,
          onSignOut: () => context.read<AppSessionCubit>().signOut(),
        ),
      _ => const SizedBox.shrink(),
    };
  }

  Widget _buildBody() {
    // #382 — this used to `switch` a whole subtree per tab, so every hop
    // disposed the outgoing tab's cubit and rebuilt+reloaded the incoming one:
    // Find refetched postings + applicants, reset the job selection to the
    // first open job and lost the applicant scroll on every return (and the
    // same on every Post/Credits/Reveal round-trip). An IndexedStack keeps each
    // visited branch mounted and merely hides it. The overlay gets ONE extra
    // slot past the tabs, so opening it hides the tabs instead of tearing them
    // down.
    final String? sub = _sub;
    final int tabIndex = _tabs.indexWhere((BbNavTab t) => t.id == _tab);
    return IndexedStack(
      // An unknown tab id falls back to the first branch — the old switch's
      // SizedBox default, minus the risk of an out-of-range stack index.
      index: sub != null ? _tabs.length : (tabIndex < 0 ? 0 : tabIndex),
      // The body was previously the Scaffold's full-bleed child; the default
      // loose sizing would shrink-wrap it, so keep the tight fill.
      sizing: StackFit.expand,
      children: <Widget>[
        for (final BbNavTab tab in _tabs) _tabBody(tab.id),
        // The overlay slot. Unlike a tab this one is deliberately rebuilt from
        // scratch on open/dismiss: Post must open on a blank form, and Reveal
        // is bound to the [RevealArgs] of the card that opened it.
        switch (sub) {
          'post' => PostJobScreen(onBack: _back),
          'credits' => CreditsScreen(onBack: _back),
          'reveal' => RevealScreen(args: _revealed!, onBack: _back),
          _ => const SizedBox.shrink(),
        },
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
          _back();
        } else if (_tab != 'home') {
          _selectTab('home');
        }
      },
      child: Scaffold(
        backgroundColor: AppColors.surfacePage,
        body: SafeArea(bottom: false, child: _buildBody()),
        bottomNavigationBar: BbBottomNav(
          tabs: _tabs,
          currentId: navId,
          onSelect: _selectTab,
        ),
      ),
    );
  }
}
