import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_avatar.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_status_view.dart';
import 'cubit/referred_cubit.dart';
import 'widgets/earn_header.dart';

/// Referred workers — masked rows of the workers this agency introduced. Each
/// row shows a "••" avatar, a mono masked label (never a real identity), the
/// trade, an attribution badge (In window / Earned / Expired), a window-countdown
/// line, and the per-worker earned ₹. Expired rows are dimmed.
class ReferredWorkersScreen extends StatelessWidget {
  const ReferredWorkersScreen({super.key, required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ReferredCubit>(
      create: (_) => locator<ReferredCubit>()..load(),
      child: _ReferredView(onBack: onBack),
    );
  }
}

class _ReferredView extends StatelessWidget {
  const _ReferredView({required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<ReferredCubit, ReferredState>(
      builder: (BuildContext context, ReferredState state) {
        if (state.status == ReferredStatus.loading ||
            state.status == ReferredStatus.initial) {
          return const BbStatusView.loading();
        }
        if (state.status == ReferredStatus.error) {
          return BbStatusView(
            icon: Icons.wifi_off,
            title: 'Could not load referrals',
            action: BbButton(
              label: 'Retry',
              onPressed: () => context.read<ReferredCubit>().load(),
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
            EarnHeader(title: 'Referred workers', onBack: onBack),
            const SizedBox(height: AppSpacing.s4),
            for (final ReferredWorker worker in state.workers) ...<Widget>[
              _ReferredCard(worker: worker),
              const SizedBox(height: AppSpacing.s3),
            ],
          ],
        );
      },
    );
  }
}

class _ReferredCard extends StatelessWidget {
  const _ReferredCard({required this.worker});

  final ReferredWorker worker;

  @override
  Widget build(BuildContext context) {
    final BbBadgeTone tone = switch (worker.status) {
      ReferralStatus.earned => BbBadgeTone.success,
      ReferralStatus.inWindow => BbBadgeTone.info,
      ReferralStatus.expired => BbBadgeTone.neutral,
    };
    final Color earnedColor =
        worker.isEarned ? AppColors.success : AppColors.textFaint;

    return BbCard(
      opacity: worker.isExpired ? 0.55 : 1,
      padding: const EdgeInsets.all(AppSpacing.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const BbAvatar(
                initials: '••',
                size: 42,
                mode: BbAvatarMode.masked,
              ),
              const SizedBox(width: AppSpacing.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      'Worker ${worker.label}',
                      style: AppTypography.mono(
                        size: AppTypography.sizeBase,
                        weight: FontWeight.w700,
                      ),
                    ),
                    Text(
                      worker.trade,
                      style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        color: AppColors.textMuted,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.s2),
              BbBadge(worker.status.label, tone: tone),
            ],
          ),
          const SizedBox(height: AppSpacing.s3),
          const Divider(height: 1, color: AppColors.divider),
          const SizedBox(height: AppSpacing.s3),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: <Widget>[
              Flexible(
                child: Text(
                  worker.windowText,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.textMuted,
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.s2),
              Text(
                worker.earned,
                style: AppTypography.mono(
                  size: AppTypography.sizeBase,
                  weight: FontWeight.w700,
                  color: earnedColor,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
