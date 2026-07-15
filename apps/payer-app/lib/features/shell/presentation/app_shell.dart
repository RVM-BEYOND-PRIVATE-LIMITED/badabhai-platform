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

  Widget _buildBody() {
    final String? sub = _sub;
    if (sub != null) {
      return switch (sub) {
        'post' => PostJobScreen(onBack: _back),
        'credits' => CreditsScreen(onBack: _back),
        'reveal' => RevealScreen(args: _revealed!, onBack: _back),
        _ => const SizedBox.shrink(),
      };
    }
    return switch (_tab) {
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

  @override
  Widget build(BuildContext context) {
    // The active nav id stays highlighted while a sub-overlay is open if the
    // overlay belongs to that tab; default to the current tab otherwise.
    final String navId = _tab;
    return Scaffold(
      backgroundColor: AppColors.surfacePage,
      body: SafeArea(bottom: false, child: _buildBody()),
      bottomNavigationBar: BbBottomNav(
        tabs: _tabs,
        currentId: navId,
        onSelect: _selectTab,
      ),
    );
  }
}
