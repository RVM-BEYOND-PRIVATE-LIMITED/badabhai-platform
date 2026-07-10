import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/session/credits_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toast.dart';
import 'cubit/credits_screen_cubit.dart';

/// Buy credits — current balance (ink card), three pack cards (50 / 200 /
/// 1,000 with a "Best value" flag), the Razorpay secure-checkout line, and the
/// unlock ledger. Tapping a pack adds credits + fires a toast.
class CreditsScreen extends StatelessWidget {
  const CreditsScreen({super.key, required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<CreditsScreenCubit>(
      create: (_) => locator<CreditsScreenCubit>()..load(),
      child: _CreditsView(onBack: onBack),
    );
  }
}

class _CreditsView extends StatelessWidget {
  const _CreditsView({required this.onBack});

  final VoidCallback onBack;

  Future<void> _buy(BuildContext context, CreditPack pack) async {
    final CreditsScreenCubit cubit = context.read<CreditsScreenCubit>();
    // REAL purchase via the server pack code; the cubit refetches balance +
    // ledger from server-truth.
    final String? error = await cubit.buyPack(pack);
    // Keep the app-wide balance (Home / Find / nav) in sync.
    await locator<CreditsCubit>().load();
    if (!context.mounted) return;
    if (error == null) {
      showBbToast(
        context,
        title: 'Credits added',
        message: '${pack.countLabel} unlocks added to your balance.',
      );
    } else {
      showBbToast(
        context,
        title: 'Not now',
        message: error,
        icon: Icons.info_outline,
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<CreditsScreenCubit, CreditsScreenState>(
      builder: (BuildContext context, CreditsScreenState state) {
        if (state.status == CreditsScreenStatus.loading ||
            state.status == CreditsScreenStatus.initial) {
          return const BbStatusView.loading();
        }
        if (state.status == CreditsScreenStatus.error) {
          return BbStatusView(
            icon: Icons.wifi_off,
            title: 'Could not load',
            action: BbButton(
              label: 'Retry',
              onPressed: () => context.read<CreditsScreenCubit>().load(),
            ),
          );
        }

        return ListView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          children: <Widget>[
            Row(
              children: <Widget>[
                BbIconButton(
                  icon: Icons.arrow_back,
                  semanticLabel: 'Back',
                  onPressed: onBack,
                ),
                const SizedBox(width: AppSpacing.s3),
                Text(
                  'Buy credits',
                  style: AppTypography.display(
                    size: AppTypography.sizeLg,
                    weight: FontWeight.w800,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.s4),
            BbCard(
              ink: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    'Current balance',
                    style: AppTypography.body(
                      size: AppTypography.sizeSm,
                      color: AppColors.ink300,
                    ),
                  ),
                  RichText(
                    text: TextSpan(
                      style: AppTypography.mono(
                        size: AppTypography.size2xl,
                        weight: FontWeight.w700,
                        color: AppColors.paper0,
                      ),
                      children: <InlineSpan>[
                        TextSpan(text: '${state.balance ?? '—'} '),
                        TextSpan(
                          text: 'unlocks',
                          style: AppTypography.body(
                            size: AppTypography.sizeBase,
                            color: AppColors.ink300,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.s3),
            for (final CreditPack pack in state.packs) ...<Widget>[
              _PackCard(pack: pack, onBuy: () => _buy(context, pack)),
              const SizedBox(height: AppSpacing.s3),
            ],
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                const Icon(Icons.lock_outline,
                    size: 14, color: AppColors.textMuted),
                const SizedBox(width: 6),
                Text(
                  'Secure checkout · Razorpay · UPI / card',
                  style: AppTypography.body(
                    size: AppTypography.sizeXs,
                    color: AppColors.textMuted,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.s5),
            Text(
              'Unlock ledger',
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
                  for (int i = 0; i < state.ledger.length; i++)
                    _LedgerRow(
                      entry: state.ledger[i],
                      showBorder: i < state.ledger.length - 1,
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

class _PackCard extends StatelessWidget {
  const _PackCard({required this.pack, required this.onBuy});

  final CreditPack pack;
  final VoidCallback onBuy;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      onTap: onBuy,
      border: pack.best
          ? Border.all(color: AppColors.brand, width: 3)
          : Border.all(color: AppColors.borderSubtle),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                RichText(
                  text: TextSpan(
                    style: AppTypography.display(
                      size: AppTypography.sizeXl,
                      weight: FontWeight.w800,
                    ),
                    children: <InlineSpan>[
                      TextSpan(text: '${pack.countLabel} '),
                      TextSpan(
                        text: 'unlocks',
                        style: AppTypography.body(
                          size: AppTypography.sizeSm,
                          weight: FontWeight.w600,
                          color: AppColors.textMuted,
                        ),
                      ),
                    ],
                  ),
                ),
                Text(
                  pack.per,
                  style: AppTypography.body(
                    size: AppTypography.sizeXs,
                    color: AppColors.textMuted,
                  ),
                ),
              ],
            ),
          ),
          if (pack.best) ...<Widget>[
            const BbBadge('Best value', tone: BbBadgeTone.brand, solid: true),
            const SizedBox(width: AppSpacing.s3),
          ],
          Text(
            pack.price,
            style: AppTypography.mono(
              size: AppTypography.sizeMd,
              weight: FontWeight.w700,
              color: AppColors.brandPress,
            ),
          ),
        ],
      ),
    );
  }
}

class _LedgerRow extends StatelessWidget {
  const _LedgerRow({required this.entry, required this.showBorder});

  final LedgerEntry entry;
  final bool showBorder;

  @override
  Widget build(BuildContext context) {
    final Color amountColor = entry.direction == LedgerDirection.credit
        ? AppColors.success
        : AppColors.textMuted;
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
          Text(
            entry.label,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textSecondary,
            ),
          ),
          Text(
            entry.amount,
            style: AppTypography.mono(
              size: AppTypography.sizeSm,
              weight: FontWeight.w700,
              color: amountColor,
            ),
          ),
        ],
      ),
    );
  }
}
