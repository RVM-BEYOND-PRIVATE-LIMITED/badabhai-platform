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
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import 'cubit/capacity_cubit.dart';

/// Hiring capacity (ADR-0016) — READ-ONLY. Shows the payer's REAL
/// concurrent-active-vacancy allowance (`max_active_vacancies`) vs how much is
/// in use (`active_plan_count`), plus the server-reported source tier + expiry,
/// all from `GET /payer/capacity`.
///
/// The "Raise capacity" upgrade was REMOVED: it charged a MOCK payment
/// (`real_call:false`) against a client-side hardcoded price list under a
/// "Secure checkout · Razorpay · UPI / card" line, and no payment provider
/// exists. The allowance read is real, so the screen stays.
class CapacityScreen extends StatelessWidget {
  const CapacityScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<CapacityCubit>(
      create: (_) => locator<CapacityCubit>()..load(),
      child: const _CapacityView(),
    );
  }
}

class _CapacityView extends StatelessWidget {
  const _CapacityView();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.surfacePage,
      body: SafeArea(
        child: BlocBuilder<CapacityCubit, CapacityState>(
          builder: (BuildContext context, CapacityState state) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                _Header(onBack: () => Navigator.of(context).pop()),
                Expanded(child: _body(context, state)),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _body(BuildContext context, CapacityState state) {
    if (state.status == CapacityStatus.loading ||
        state.status == CapacityStatus.initial) {
      return const BbStatusView.loading();
    }
    if (state.status == CapacityStatus.error && state.capacity == null) {
      return BbStatusView(
        icon: Icons.wifi_off,
        title: 'Could not load capacity',
        subtitle: state.error,
        action: BbButton(
          label: 'Retry',
          onPressed: () => context.read<CapacityCubit>().load(),
        ),
      );
    }

    final CapacityView cap = state.capacity!;
    return ListView(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s2,
        AppSpacing.gutter,
        AppSpacing.s6,
      ),
      children: <Widget>[
        _AllowanceCard(cap: cap),
        const SizedBox(height: AppSpacing.s3),
        _DetailsCard(cap: cap),
      ],
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
            'Hiring capacity',
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

class _AllowanceCard extends StatelessWidget {
  const _AllowanceCard({required this.cap});

  final CapacityView cap;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      ink: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            'Active vacancies in use',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.ink300,
            ),
          ),
          const SizedBox(height: AppSpacing.s1),
          RichText(
            text: TextSpan(
              style: AppTypography.mono(
                size: AppTypography.size2xl,
                weight: FontWeight.w700,
                color: AppColors.paper0,
              ),
              children: <InlineSpan>[
                TextSpan(text: '${cap.activePlanCount} '),
                TextSpan(
                  text: '/ ${cap.maxActiveVacancies}',
                  style: AppTypography.body(
                    size: AppTypography.sizeBase,
                    color: AppColors.ink300,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.s3),
          ClipRRect(
            borderRadius: BorderRadius.circular(AppRadii.pill),
            child: LinearProgressIndicator(
              value: cap.usage.clamp(0, 1),
              minHeight: 8,
              backgroundColor: AppColors.ink700,
              valueColor: AlwaysStoppedAnimation<Color>(
                cap.atCapacity ? AppColors.saffron500 : AppColors.green300,
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            cap.atCapacity
                ? 'Full — close an active vacancy to open another.'
                : '${cap.remaining} more vacanc${cap.remaining == 1 ? 'y' : 'ies'} available.',
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              color: AppColors.ink300,
            ),
          ),
        ],
      ),
    );
  }
}

class _DetailsCard extends StatelessWidget {
  const _DetailsCard({required this.cap});

  final CapacityView cap;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s4),
      child: Column(
        children: <Widget>[
          _InfoRow(
            icon: Icons.workspace_premium_outlined,
            label: 'Current tier',
            child: BbBadge(
              capacityTierLabel(cap.sourceTier),
              tone: cap.sourceTier == null
                  ? BbBadgeTone.neutral
                  : BbBadgeTone.success,
            ),
          ),
          _InfoRow(
            icon: Icons.event_outlined,
            label: 'Renews / expires',
            value: _dateLabel(cap.expiresAt),
            showBorder: false,
          ),
        ],
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({
    required this.icon,
    required this.label,
    this.value,
    this.child,
    this.showBorder = true,
  });

  final IconData icon;
  final String label;
  final String? value;
  final Widget? child;
  final bool showBorder;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        border: showBorder
            ? const Border(bottom: BorderSide(color: AppColors.divider))
            : null,
      ),
      constraints: const BoxConstraints(minHeight: AppSpacing.tap),
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s3),
      child: Row(
        children: <Widget>[
          Icon(icon, size: 22, color: AppColors.textMuted),
          const SizedBox(width: AppSpacing.s3),
          Text(
            label,
            style: AppTypography.body(
              size: AppTypography.sizeBase,
              color: AppColors.textSecondary,
            ),
          ),
          const Spacer(),
          if (child != null)
            child!
          else
            Text(
              value ?? '—',
              style: AppTypography.mono(size: AppTypography.sizeSm),
            ),
        ],
      ),
    );
  }
}

String _dateLabel(String? iso) {
  if (iso == null || iso.isEmpty) return '—';
  final DateTime? dt = DateTime.tryParse(iso);
  if (dt == null) return iso;
  const List<String> months = <String>[
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return '${dt.day.toString().padLeft(2, '0')} ${months[dt.month - 1]} ${dt.year}';
}
