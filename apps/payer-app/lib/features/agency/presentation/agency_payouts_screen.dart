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
import 'cubit/agency_payouts_cubit.dart';

/// Agency payout history — the agent's OWN requested payouts
/// (`GET /payer/agency/payouts`). AGENT-only AND FLAG-GATED: a neutral 404 shows
/// "not available yet", a company session's 403 shows "agency accounts only".
/// PII-free rows: ₹ + opaque id + a status pill (`requested`/`paid`/`rejected`).
class AgencyPayoutsScreen extends StatelessWidget {
  const AgencyPayoutsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<AgencyPayoutsCubit>(
      create: (_) => locator<AgencyPayoutsCubit>()..load(),
      child: const _PayoutsView(),
    );
  }
}

class _PayoutsView extends StatelessWidget {
  const _PayoutsView();

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
              child: BlocBuilder<AgencyPayoutsCubit, AgencyPayoutsState>(
                builder: (BuildContext context, AgencyPayoutsState state) =>
                    _body(context, state),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context, AgencyPayoutsState state) {
    void reload() => context.read<AgencyPayoutsCubit>().load();

    switch (state.resolvedStatus) {
      case AgencyPayoutsStatus.initial:
      case AgencyPayoutsStatus.loading:
        return const BbStatusView.loading(caption: 'Loading payouts…');
      case AgencyPayoutsStatus.empty:
        return BbStatusView(
          icon: Icons.receipt_long_outlined,
          title: 'No payouts yet',
          subtitle: 'Once you request a payout it will show up here with its '
              'status.',
          action: BbButton(
            label: 'Refresh',
            variant: BbButtonVariant.secondary,
            iconLeft: Icons.refresh,
            onPressed: reload,
          ),
        );
      case AgencyPayoutsStatus.unavailable:
        return const BbStatusView(
          icon: Icons.schedule,
          title: 'Not available yet',
          subtitle: 'Payouts are coming soon. Your requests will show up here.',
        );
      case AgencyPayoutsStatus.forbidden:
        return const BbStatusView(
          icon: Icons.lock_outline,
          title: 'Agency accounts only',
          subtitle: 'Payouts are only available on agency (recruiter) accounts.',
        );
      case AgencyPayoutsStatus.error:
        return BbStatusView(
          icon: Icons.wifi_off,
          title: 'Could not load payouts',
          subtitle: 'Please check your connection and try again.',
          action: BbButton(label: 'Retry', onPressed: reload),
        );
      case AgencyPayoutsStatus.ready:
        return RefreshIndicator(
          onRefresh: () => context.read<AgencyPayoutsCubit>().load(),
          color: AppColors.blue,
          child: ListView.separated(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.gutter,
              AppSpacing.s2,
              AppSpacing.gutter,
              AppSpacing.s6,
            ),
            itemCount: state.payouts.length,
            separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.s3),
            itemBuilder: (BuildContext context, int index) =>
                _PayoutCard(payout: state.payouts[index]),
          ),
        );
    }
  }
}

/// One payout row: ₹ + accrual count + a status pill + the coarse date.
class _PayoutCard extends StatelessWidget {
  const _PayoutCard({required this.payout});

  final AgencyPayout payout;

  (String, BbBadgeTone) get _pill => switch (payout.status) {
        // Green is reserved for a settled/verified state (kit law).
        'paid' => ('Paid', BbBadgeTone.success),
        'requested' => ('Requested', BbBadgeTone.info),
        'rejected' => ('Rejected', BbBadgeTone.danger),
        _ => (payout.status, BbBadgeTone.neutral),
      };

  /// "6 Jun 2026" from an ISO timestamp — coarse, no time-of-day.
  String get _dateLabel {
    final String? iso = payout.createdAt;
    if (iso == null) return '';
    final DateTime? dt = DateTime.tryParse(iso);
    if (dt == null) return '';
    const List<String> m = <String>[
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    final DateTime l = dt.toLocal();
    return '${l.day} ${m[l.month - 1]} ${l.year}';
  }

  @override
  Widget build(BuildContext context) {
    final (String label, BbBadgeTone tone) = _pill;
    return BbCard(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  '₹${formatIndianGrouped(payout.amountInr)}',
                  style: AppTypography.display(
                    size: AppTypography.sizeLg,
                    weight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  <String>[
                    '${payout.accrualCount} unlocks',
                    if (_dateLabel.isNotEmpty) _dateLabel,
                  ].join(' · '),
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.textMuted,
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
            'Payout history',
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
