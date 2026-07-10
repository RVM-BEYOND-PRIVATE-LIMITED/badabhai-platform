import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toast.dart';
import 'cubit/payouts_cubit.dart';
import 'widgets/earn_header.dart';

/// Earnings & payouts — Total-earned / This-month stat cards, a pending-payout
/// card with a thick success progress bar + "ready to pay out" line + Withdraw
/// CTA, and the settled payout history.
class PayoutsScreen extends StatelessWidget {
  const PayoutsScreen({super.key, required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<PayoutsCubit>(
      create: (_) => locator<PayoutsCubit>()..load(),
      child: _PayoutsView(onBack: onBack),
    );
  }
}

class _PayoutsView extends StatelessWidget {
  const _PayoutsView({required this.onBack});

  final VoidCallback onBack;

  void _withdraw(BuildContext context, String amount) {
    showBbToast(
      context,
      title: 'Withdrawal requested',
      message: '$amount will reach your bank in 1–2 working days.',
    );
  }

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<PayoutsCubit, PayoutsState>(
      builder: (BuildContext context, PayoutsState state) {
        if (state.status == PayoutsStatus.loading ||
            state.status == PayoutsStatus.initial) {
          return const BbStatusView.loading();
        }
        if (state.status == PayoutsStatus.error || state.summary == null) {
          return BbStatusView(
            icon: Icons.wifi_off,
            title: 'Could not load payouts',
            action: BbButton(
              label: 'Retry',
              onPressed: () => context.read<PayoutsCubit>().load(),
            ),
          );
        }

        final PayoutSummary summary = state.summary!;

        return ListView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          children: <Widget>[
            EarnHeader(title: 'Earnings & payouts', onBack: onBack),
            const SizedBox(height: AppSpacing.s4),
            IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Expanded(
                    child: _StatCard(
                      label: 'Total earned',
                      value: summary.totalEarned,
                      valueColor: AppColors.textPrimary,
                    ),
                  ),
                  const SizedBox(width: AppSpacing.s3),
                  Expanded(
                    child: _StatCard(
                      label: 'This month',
                      value: summary.thisMonth,
                      valueColor: AppColors.success,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.s3),
            _PendingCard(
              summary: summary,
              onWithdraw: () => _withdraw(context, summary.pending),
            ),
            const SizedBox(height: AppSpacing.s5),
            Text(
              'Payout history',
              style: AppTypography.display(
                size: AppTypography.sizeBase,
                weight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: AppSpacing.s2),
            BbCard(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s4),
              child: Column(
                children: <Widget>[
                  for (int i = 0; i < state.history.length; i++)
                    _PayoutRow(
                      entry: state.history[i],
                      showBorder: i < state.history.length - 1,
                    ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}

class _StatCard extends StatelessWidget {
  const _StatCard({
    required this.label,
    required this.value,
    required this.valueColor,
  });

  final String label;
  final String value;
  final Color valueColor;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      padding: const EdgeInsets.all(AppSpacing.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            label,
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              weight: FontWeight.w600,
              color: AppColors.textMuted,
            ),
          ),
          const SizedBox(height: AppSpacing.s1),
          Text(
            value,
            style: AppTypography.mono(
              size: AppTypography.size2xl,
              weight: FontWeight.w700,
              color: valueColor,
            ),
          ),
        ],
      ),
    );
  }
}

/// The pending-payout card: a "pending / minimum" head row over a thick green
/// progress bar (full when the minimum is met), the "ready to pay out" line and
/// the Withdraw CTA. The bar is rendered here (thick) — the slim [BbProgress] is
/// for job quotas.
class _PendingCard extends StatelessWidget {
  const _PendingCard({required this.summary, required this.onWithdraw});

  final PayoutSummary summary;
  final VoidCallback onWithdraw;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      padding: const EdgeInsets.all(AppSpacing.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              Text(
                'Pending payout',
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  weight: FontWeight.w600,
                ),
              ),
              Text(
                '${summary.pending} / ${summary.minimum}',
                style: AppTypography.mono(
                  size: AppTypography.sizeSm,
                  weight: FontWeight.w700,
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.s3),
          ClipRRect(
            borderRadius: BorderRadius.circular(AppRadii.pill),
            child: Container(
              height: 14,
              color: AppColors.surfaceInset,
              child: FractionallySizedBox(
                widthFactor: summary.pendingMet ? 1 : 0.5,
                alignment: Alignment.centerLeft,
                child: const DecoratedBox(
                  decoration: BoxDecoration(color: AppColors.success),
                ),
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.s2),
          Row(
            children: <Widget>[
              const Icon(Icons.check_circle,
                  size: 16, color: AppColors.success),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  summary.pendingMet
                      ? 'Above ${summary.minimum} minimum — ready to pay out'
                      : 'Below ${summary.minimum} minimum — keep earning',
                  style: AppTypography.body(
                    size: AppTypography.sizeXs,
                    color: AppColors.success,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.s3),
          BbButton(
            label: 'Withdraw to bank',
            variant: BbButtonVariant.primary,
            iconLeft: Icons.account_balance,
            block: true,
            onPressed: summary.pendingMet ? onWithdraw : null,
          ),
        ],
      ),
    );
  }
}

class _PayoutRow extends StatelessWidget {
  const _PayoutRow({required this.entry, required this.showBorder});

  final PayoutEntry entry;
  final bool showBorder;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        border: showBorder
            ? const Border(bottom: BorderSide(color: AppColors.divider))
            : null,
      ),
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s3),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: <Widget>[
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                entry.label,
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  color: AppColors.textPrimary,
                ),
              ),
              Text(
                '${entry.method} · ${entry.date}',
                style: AppTypography.body(
                  size: AppTypography.sizeXs,
                  color: AppColors.textMuted,
                ),
              ),
            ],
          ),
          Text(
            entry.amount,
            style: AppTypography.mono(
              size: AppTypography.sizeBase,
              weight: FontWeight.w700,
              color: AppColors.success,
            ),
          ),
        ],
      ),
    );
  }
}
