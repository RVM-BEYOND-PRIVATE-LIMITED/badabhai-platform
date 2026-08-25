import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/pay_format.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toast.dart';
import 'agency_kyc_screen.dart';
import 'agency_payouts_screen.dart';
import 'cubit/agency_earnings_cubit.dart';

/// Agency earnings & payouts — the supply-money hub (`GET /payer/agency/earnings`
/// + `POST /payer/agency/payouts`). AGENT-only AND FLAG-GATED: while the launch
/// flag is off the routes return a neutral 404, which this screen shows as an
/// honest "not available yet" state (never a crash / generic error). Reachable
/// only from the agency Refer-&-earn surface.
///
/// The "Request payout" action is a MONEY-OUT surface (an agent withdrawing
/// earned commission) — a plain authed POST, with NO gateway/card/checkout. The
/// server owns eligibility ([AgencyEarnings.canRequest]); this screen only
/// reflects it and confirms before requesting.
class AgencyEarningsScreen extends StatelessWidget {
  const AgencyEarningsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<AgencyEarningsCubit>(
      create: (_) => locator<AgencyEarningsCubit>()..load(),
      child: const _EarningsView(),
    );
  }
}

class _EarningsView extends StatelessWidget {
  const _EarningsView();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.surfacePage,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _Header(onBack: () => Navigator.of(context).pop()),
            Expanded(
              child: BlocBuilder<AgencyEarningsCubit, AgencyEarningsState>(
                builder: (BuildContext context, AgencyEarningsState state) =>
                    _body(context, state),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context, AgencyEarningsState state) {
    void reload() => context.read<AgencyEarningsCubit>().load();

    switch (state.status) {
      case AgencyEarningsStatus.initial:
      case AgencyEarningsStatus.loading:
        return const BbStatusView.loading(caption: 'Loading earnings…');
      case AgencyEarningsStatus.unavailable:
        // The launch flag is OFF (a neutral 404) — an honest, calm state.
        return const BbStatusView(
          icon: Icons.schedule,
          title: 'Payouts aren’t available yet',
          subtitle: 'Earning on the workers you refer is coming soon. Keep '
              'sharing your invite link — your earnings will show up here.',
        );
      case AgencyEarningsStatus.forbidden:
        return const BbStatusView(
          icon: Icons.lock_outline,
          title: 'Agency accounts only',
          subtitle: 'Earnings and payouts are only available on agency '
              '(recruiter) accounts.',
        );
      case AgencyEarningsStatus.error:
        return BbStatusView(
          icon: Icons.wifi_off,
          title: 'Could not load earnings',
          subtitle: 'Please check your connection and try again.',
          action: BbButton(label: 'Retry', onPressed: reload),
        );
      case AgencyEarningsStatus.ready:
        final AgencyEarnings? e = state.earnings;
        if (e == null) {
          return BbStatusView(
            icon: Icons.wifi_off,
            title: 'Could not load earnings',
            action: BbButton(label: 'Retry', onPressed: reload),
          );
        }
        return RefreshIndicator(
          onRefresh: () => context.read<AgencyEarningsCubit>().load(),
          color: AppColors.blue,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.gutter,
              AppSpacing.s2,
              AppSpacing.gutter,
              AppSpacing.s6,
            ),
            children: <Widget>[
              _RequestableCard(earnings: e, requesting: state.requesting),
              const SizedBox(height: AppSpacing.s4),
              _TotalsRow(earnings: e),
              const SizedBox(height: AppSpacing.s5),
              Text(
                'How you earn',
                style: AppTypography.display(
                  size: AppTypography.sizeBase,
                  weight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: AppSpacing.s2),
              _HowItWorksCard(earnings: e),
              const SizedBox(height: AppSpacing.s5),
              Text(
                'Manage',
                style: AppTypography.display(
                  size: AppTypography.sizeBase,
                  weight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: AppSpacing.s2),
              _KycNavCard(kycStatus: e.kycStatus),
              const SizedBox(height: AppSpacing.s3),
              _NavCard(
                icon: Icons.receipt_long_outlined,
                title: 'Payout history',
                subtitle: 'Every payout you have requested and its status.',
                onTap: () => _open(
                  context,
                  name: 'payer/agency/payouts',
                  builder: (_) => const AgencyPayoutsScreen(),
                ),
              ),
            ],
          ),
        );
    }
  }

  void _open(
    BuildContext context, {
    required String name,
    required WidgetBuilder builder,
  }) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        settings: RouteSettings(name: name),
        builder: builder,
      ),
    );
  }
}

/// The hero: ₹ available to request + the money-OUT request action, or the
/// honest reason it is blocked (KYC / below threshold). NO card/gateway UI.
class _RequestableCard extends StatelessWidget {
  const _RequestableCard({required this.earnings, required this.requesting});

  final AgencyEarnings earnings;
  final bool requesting;

  Future<void> _confirmAndRequest(BuildContext context) async {
    final AgencyEarningsCubit cubit = context.read<AgencyEarningsCubit>();
    final bool? go = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text('Request payout?'),
        content: Text(
          'Request ₹${formatIndianGrouped(earnings.requestableInr)} to '
          'your verified bank account. We will process it and update the '
          'status in your payout history.',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Request'),
          ),
        ],
      ),
    );
    if (go != true) return;
    final PayoutActionResult result = await cubit.requestPayout();
    if (!context.mounted) return;
    showBbToast(
      context,
      title: result.success ? 'Done' : 'Not now',
      message: result.message,
      icon: result.success ? Icons.check_circle : Icons.info_outline,
    );
  }

  @override
  Widget build(BuildContext context) {
    return BbCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            'Available to request',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          ),
          const SizedBox(height: AppSpacing.s1),
          Text(
            '₹${formatIndianGrouped(earnings.requestableInr)}',
            style: AppTypography.display(
              size: AppTypography.sizeXl,
              weight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: AppSpacing.s3),
          ..._action(context),
        ],
      ),
    );
  }

  List<Widget> _action(BuildContext context) {
    if (earnings.canRequest) {
      return <Widget>[
        BbButton(
          label: 'Request payout',
          iconLeft: Icons.account_balance_outlined,
          block: true,
          loading: requesting,
          onPressed: () => _confirmAndRequest(context),
        ),
      ];
    }
    // Blocked — say why, honestly, and route to the fix where there is one.
    switch (earnings.blockedReason) {
      case 'kyc_not_verified':
        return <Widget>[
          _BlockedNote(
            earnings.kycStatus == 'pending'
                ? 'Your KYC is being verified. You can request a payout once it '
                    'is approved.'
                : 'Verify your KYC to request a payout.',
          ),
          if (earnings.kycStatus != 'pending') ...<Widget>[
            const SizedBox(height: AppSpacing.s3),
            BbButton(
              label: 'Complete KYC',
              variant: BbButtonVariant.navy,
              block: true,
              iconLeft: Icons.verified_user_outlined,
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  settings: const RouteSettings(name: 'payer/agency/kyc'),
                  builder: (_) => const AgencyKycScreen(),
                ),
              ),
            ),
          ],
        ];
      case 'below_threshold':
        return <Widget>[
          _BlockedNote(
            'You can request a payout once you reach '
            '₹${formatIndianGrouped(earnings.thresholdInr)}. '
            '₹${formatIndianGrouped(earnings.remainingToThresholdInr)} to go.',
          ),
        ];
      default:
        return <Widget>[
          const _BlockedNote('Payouts are not available right now.'),
        ];
    }
  }
}

class _BlockedNote extends StatelessWidget {
  const _BlockedNote(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const Icon(Icons.info_outline, size: 18, color: AppColors.textMuted),
        const SizedBox(width: AppSpacing.s2),
        Expanded(
          child: Text(
            text,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textSecondary,
              height: 1.4,
            ),
          ),
        ),
      ],
    );
  }
}

/// Lifetime / in-request / paid ₹ splits — three faceless mono figures.
class _TotalsRow extends StatelessWidget {
  const _TotalsRow({required this.earnings});

  final AgencyEarnings earnings;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      child: Row(
        children: <Widget>[
          _Total(label: 'Earned', value: earnings.totalAccruedInr),
          _Total(label: 'In request', value: earnings.inRequestInr),
          _Total(label: 'Paid', value: earnings.paidInr),
        ],
      ),
    );
  }
}

class _Total extends StatelessWidget {
  const _Total({required this.label, required this.value});

  final String label;
  final int value;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            '₹${formatIndianGrouped(value)}',
            style: AppTypography.display(
              size: AppTypography.sizeLg,
              weight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            label,
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              color: AppColors.textMuted,
            ),
          ),
        ],
      ),
    );
  }
}

/// The economics in plain words — the rate/basis/window come from the server, so
/// the copy never hard-codes the numbers.
class _HowItWorksCard extends StatelessWidget {
  const _HowItWorksCard({required this.earnings});

  final AgencyEarnings earnings;

  @override
  Widget build(BuildContext context) {
    final int ratePct = earnings.rateBps ~/ 100;
    return BbCard(
      child: Text(
        'You earn $ratePct% of each ₹${formatIndianGrouped(earnings.basisInr)} '
        'contact unlock on a worker you referred, for up to '
        '${earnings.windowDays} days after they join. You can request a payout '
        'once your balance reaches '
        '₹${formatIndianGrouped(earnings.thresholdInr)}.',
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          color: AppColors.textSecondary,
          height: 1.5,
        ),
      ),
    );
  }
}

/// Nav to the KYC screen with a live status chip.
class _KycNavCard extends StatelessWidget {
  const _KycNavCard({required this.kycStatus});

  final String kycStatus;

  (String, BbBadgeTone) get _pill => switch (kycStatus) {
        'verified' => ('Verified', BbBadgeTone.success),
        'pending' => ('In review', BbBadgeTone.warning),
        'rejected' => ('Action needed', BbBadgeTone.danger),
        _ => ('Not started', BbBadgeTone.neutral),
      };

  @override
  Widget build(BuildContext context) {
    final (String label, BbBadgeTone tone) = _pill;
    return BbCard(
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          settings: const RouteSettings(name: 'payer/agency/kyc'),
          builder: (_) => const AgencyKycScreen(),
        ),
      ),
      child: Row(
        children: <Widget>[
          const Icon(Icons.verified_user_outlined,
              size: 24, color: AppColors.blue),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  'KYC details',
                  style: AppTypography.display(
                    size: AppTypography.sizeBase,
                    weight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  'Your PAN and bank account for payouts.',
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.textMuted,
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.s2),
          BbBadge(label, tone: tone),
        ],
      ),
    );
  }
}

/// A tappable card that links to a deeper agent-only surface.
class _NavCard extends StatelessWidget {
  const _NavCard({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      onTap: onTap,
      child: Row(
        children: <Widget>[
          Icon(icon, size: 24, color: AppColors.blue),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  title,
                  style: AppTypography.display(
                    size: AppTypography.sizeBase,
                    weight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.textMuted,
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.s2),
          const Icon(Icons.chevron_right, size: 20, color: AppColors.textFaint),
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s2,
        AppSpacing.gutter,
        AppSpacing.s2,
      ),
      child: Row(
        children: <Widget>[
          BbIconButton(
            icon: Icons.arrow_back,
            semanticLabel: 'Back',
            onPressed: onBack,
          ),
          const SizedBox(width: AppSpacing.s3),
          Text(
            'Earnings & payouts',
            style: AppTypography.display(
              size: AppTypography.sizeLg,
              weight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }
}
