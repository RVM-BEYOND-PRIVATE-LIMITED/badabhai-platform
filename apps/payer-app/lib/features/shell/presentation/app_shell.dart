import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
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
import '../../earn/presentation/earn_hub_screen.dart';
import '../../earn/presentation/referral_hub_screen.dart';
import '../../earn/presentation/referred_workers_screen.dart';
import '../../earn/presentation/payouts_screen.dart';
import '../../earn/presentation/kyc_screen.dart';

/// The signed-in shell. Holds the role-aware bottom nav and an in-shell
/// navigation model mirroring the kit: a primary [_tab] (a nav destination) and
/// an optional [_sub] overlay (Post / Credits / Reveal) pushed above it with a
/// back affordance. The credit balance is loaded once here and shared app-wide.
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
  }

  bool get _isAgency => widget.session.isAgency;

  List<BbNavTab> get _tabs => <BbNavTab>[
        const BbNavTab(
          id: 'home',
          label: 'Home',
          iconInactive: Icons.home_outlined,
          iconActive: Icons.home,
        ),
        const BbNavTab(
          id: 'find',
          label: 'Find',
          iconInactive: Icons.search,
          iconActive: Icons.search,
        ),
        const BbNavTab(
          id: 'jobs',
          label: 'Jobs',
          iconInactive: Icons.work_outline,
          iconActive: Icons.work,
        ),
        if (_isAgency)
          const BbNavTab(
            id: 'earn',
            label: 'Earn',
            iconInactive: Icons.account_balance_wallet_outlined,
            iconActive: Icons.account_balance_wallet,
          )
        else
          const BbNavTab(
            id: 'credits',
            label: 'Credits',
            iconInactive: Icons.lock_open_outlined,
            iconActive: Icons.lock_open,
          ),
        const BbNavTab(
          id: 'account',
          label: 'Account',
          iconInactive: Icons.person_outline,
          iconActive: Icons.person,
        ),
      ];

  void _selectTab(String id) => setState(() {
        _tab = id;
        _sub = null;
      });

  void _openSub(String id) => setState(() => _sub = id);

  void _back() => setState(() {
        _sub = null;
        _revealed = null;
      });

  void _openReveal(RevealArgs args) => setState(() {
        _revealed = args;
        _sub = 'reveal';
      });

  /// The Earn supply sub-routes are agency-only. A Company session has no Earn
  /// tab and therefore no way to set these — the guard makes that explicit so a
  /// stray route can never render the supply surface for a company.
  static const Set<String> _earnSubs = <String>{
    'referral',
    'referred',
    'payouts',
    'kyc',
  };

  Widget _buildBody() {
    final String? sub = _sub;
    if (sub != null) {
      if (_earnSubs.contains(sub) && !_isAgency) {
        return const SizedBox.shrink();
      }
      return switch (sub) {
        'post' => PostJobScreen(onBack: _back),
        'credits' => CreditsScreen(onBack: _back),
        'reveal' => RevealScreen(args: _revealed!, onBack: _back),
        'referral' => ReferralHubScreen(onBack: _back),
        'referred' => ReferredWorkersScreen(onBack: _back),
        'payouts' => PayoutsScreen(onBack: _back),
        'kyc' => KycScreen(onBack: _back),
        _ => const SizedBox.shrink(),
      };
    }
    return switch (_tab) {
      'home' => HomeScreen(
          session: widget.session,
          onPost: () => _openSub('post'),
          onBrowse: () => _selectTab('find'),
          onBuyCredits: () => _openSub('credits'),
          onOpenEarn: () => _selectTab('earn'),
        ),
      'find' => FindScreen(onReveal: _openReveal),
      'jobs' => JobsScreen(onPost: () => _openSub('post')),
      'credits' => CreditsScreen(onBack: () => _selectTab('home')),
      'earn' => _isAgency
          ? EarnHubScreen(
              onReferral: () => _openSub('referral'),
              onReferred: () => _openSub('referred'),
              onPayouts: () => _openSub('payouts'),
              onKyc: () => _openSub('kyc'),
            )
          : const SizedBox.shrink(),
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
