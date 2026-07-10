import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_status_view.dart';
import 'cubit/earn_hub_cubit.dart';

/// Earn hub (agency only) — the Mitra-Leader supply surface. A saffron-gradient
/// summary card (earned / pending / in-window / rev-share) over four
/// interactive nav cards → Referral hub · Referred workers · Earnings & payouts
/// · KYC (the KYC card carries the current status badge).
class EarnHubScreen extends StatelessWidget {
  const EarnHubScreen({
    super.key,
    required this.onReferral,
    required this.onReferred,
    required this.onPayouts,
    required this.onKyc,
  });

  final VoidCallback onReferral;
  final VoidCallback onReferred;
  final VoidCallback onPayouts;
  final VoidCallback onKyc;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<EarnHubCubit>(
      create: (_) => locator<EarnHubCubit>()..load(),
      child: _EarnHubView(
        onReferral: onReferral,
        onReferred: onReferred,
        onPayouts: onPayouts,
        onKyc: onKyc,
      ),
    );
  }
}

class _EarnHubView extends StatelessWidget {
  const _EarnHubView({
    required this.onReferral,
    required this.onReferred,
    required this.onPayouts,
    required this.onKyc,
  });

  final VoidCallback onReferral;
  final VoidCallback onReferred;
  final VoidCallback onPayouts;
  final VoidCallback onKyc;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<EarnHubCubit, EarnHubState>(
      builder: (BuildContext context, EarnHubState state) {
        if (state.status == EarnHubStatus.loading ||
            state.status == EarnHubStatus.initial) {
          return const BbStatusView.loading();
        }
        if (state.status == EarnHubStatus.error || state.summary == null) {
          return BbStatusView(
            icon: Icons.wifi_off,
            title: 'Could not load Earn',
            action: BbButton(
              label: 'Retry',
              onPressed: () => context.read<EarnHubCubit>().load(),
            ),
          );
        }

        final EarnSummary summary = state.summary!;
        final (BbBadgeTone kycTone, String kycLabel) = switch (state.kyc) {
          KycStatus.verified => (BbBadgeTone.success, state.kyc.badgeLabel),
          KycStatus.review => (BbBadgeTone.warning, state.kyc.badgeLabel),
          KycStatus.none => (BbBadgeTone.neutral, state.kyc.badgeLabel),
        };

        return ListView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s3,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.account_balance_wallet,
                    size: 16, color: AppColors.saffronDeep),
                const SizedBox(width: 6),
                Text(
                  'SUPPLY · EARN',
                  style: AppTypography.eyebrow(color: AppColors.saffronDeep),
                ),
              ],
            ),
            const SizedBox(height: 2),
            Text(
              'Mitra-Leader',
              style: AppTypography.display(
                size: AppTypography.sizeXl,
                weight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: AppSpacing.s3),
            _SummaryCard(summary: summary),
            const SizedBox(height: AppSpacing.s3),
            _NavCard(
              icon: Icons.link,
              iconTint: AppColors.brandTint,
              iconColor: AppColors.brandPress,
              title: 'Referral hub',
              subtitle: 'Get your link · how earning works',
              onTap: onReferral,
            ),
            const SizedBox(height: AppSpacing.s3),
            _NavCard(
              icon: Icons.groups,
              iconTint: AppColors.infoTint,
              iconColor: AppColors.teal700,
              title: 'Referred workers',
              subtitle: '4 introduced · window countdowns',
              onTap: onReferred,
            ),
            const SizedBox(height: AppSpacing.s3),
            _NavCard(
              icon: Icons.account_balance,
              iconTint: AppColors.successTint,
              iconColor: AppColors.green700,
              title: 'Earnings & payouts',
              subtitle: '₹500 min · payout history',
              onTap: onPayouts,
            ),
            const SizedBox(height: AppSpacing.s3),
            _NavCard(
              icon: Icons.badge_outlined,
              iconTint: AppColors.surfaceSunken,
              iconColor: AppColors.ink700,
              title: 'KYC',
              subtitle: 'Required before first payout',
              trailing: BbBadge(kycLabel, tone: kycTone),
              onTap: onKyc,
            ),
          ],
        );
      },
    );
  }
}

/// The saffron-gradient summary card — big mono "earned this month" over a row
/// of pending-payout / in-window / rev-share mini-stats. Saffron is the
/// Earn/Supply surface accent.
class _SummaryCard extends StatelessWidget {
  const _SummaryCard({required this.summary});

  final EarnSummary summary;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      padding: const EdgeInsets.all(AppSpacing.s5),
      gradient: const LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: <Color>[AppColors.saffron50, AppColors.saffron100],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            'Earned this month',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              weight: FontWeight.w600,
              color: AppColors.saffron700,
            ),
          ),
          const SizedBox(height: AppSpacing.s1),
          Text(
            summary.earnedThisMonth,
            style: AppTypography.mono(
              size: AppTypography.size3xl,
              weight: FontWeight.w700,
              color: AppColors.ink900,
            ),
          ),
          const SizedBox(height: AppSpacing.s3),
          Row(
            children: <Widget>[
              _miniStat(summary.pendingPayout, 'Pending payout'),
              const SizedBox(width: AppSpacing.s5),
              _miniStat(summary.inWindow, 'In window'),
              const SizedBox(width: AppSpacing.s5),
              _miniStat('25%', 'Rev share'),
            ],
          ),
        ],
      ),
    );
  }

  Widget _miniStat(String value, String label) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(
          value,
          style: AppTypography.mono(
            size: AppTypography.sizeMd,
            weight: FontWeight.w700,
            color: AppColors.ink900,
          ),
        ),
        Text(
          label,
          style: AppTypography.body(
            size: AppTypography.size2xs,
            color: AppColors.saffron700,
          ),
        ),
      ],
    );
  }
}

/// An interactive row-card → a sub-screen. Tinted Phosphor-style icon tile,
/// title + subtitle, and either a caret or a trailing badge (KYC status).
class _NavCard extends StatelessWidget {
  const _NavCard({
    required this.icon,
    required this.iconTint,
    required this.iconColor,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.trailing,
  });

  final IconData icon;
  final Color iconTint;
  final Color iconColor;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      onTap: onTap,
      padding: const EdgeInsets.all(AppSpacing.s4),
      child: Row(
        children: <Widget>[
          Container(
            width: 44,
            height: 44,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: iconTint,
              borderRadius: BorderRadius.circular(AppRadii.md),
            ),
            child: Icon(icon, size: 22, color: iconColor),
          ),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  title,
                  style: AppTypography.body(
                    size: AppTypography.sizeBase,
                    weight: FontWeight.w700,
                  ),
                ),
                Text(
                  subtitle,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.textMuted,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.s2),
          trailing ??
              const Icon(Icons.chevron_right,
                  size: 22, color: AppColors.textFaint),
        ],
      ),
    );
  }
}
