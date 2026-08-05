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
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import 'cubit/agency_engagement_cubit.dart';

/// Agency engagement — the FACELESS per-worker referral funnel
/// (`GET /payer/agency/workers`, AGENT-only). Each row is an opaque ref handle
/// plus coarse progress (profile ready y/n) and engagement counts (applied,
/// unlocked) and a coarse last-active marker — NEVER a name/phone.
///
/// Reachable only from the agency Refer-&-earn surface (the route 403s for a
/// company session, which we surface as the honest "agency accounts only" view).
class AgencyEngagementScreen extends StatelessWidget {
  const AgencyEngagementScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<AgencyEngagementCubit>(
      create: (_) => locator<AgencyEngagementCubit>()..load(),
      child: const _EngagementView(),
    );
  }
}

class _EngagementView extends StatelessWidget {
  const _EngagementView();

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
              child: BlocBuilder<AgencyEngagementCubit, AgencyEngagementState>(
                builder: (BuildContext context, AgencyEngagementState state) =>
                    _body(context, state),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context, AgencyEngagementState state) {
    void reload() => context.read<AgencyEngagementCubit>().load();

    switch (state.resolvedStatus) {
      case AgencyEngagementStatus.initial:
      case AgencyEngagementStatus.loading:
        return const BbStatusView.loading(caption: 'Loading workers…');
      case AgencyEngagementStatus.empty:
        return BbStatusView(
          icon: Icons.groups_outlined,
          title: 'No referred workers yet',
          subtitle: 'Share your invite link. Workers you refer show up here as '
              'they join and get active.',
          action: BbButton(
            label: 'Refresh',
            variant: BbButtonVariant.secondary,
            iconLeft: Icons.refresh,
            onPressed: reload,
          ),
        );
      case AgencyEngagementStatus.forbidden:
        return const BbStatusView(
          icon: Icons.lock_outline,
          title: 'Agency accounts only',
          subtitle: 'This referral funnel is only available on agency '
              '(recruiter) accounts.',
        );
      case AgencyEngagementStatus.rateLimited:
        return BbStatusView(
          icon: Icons.hourglass_empty,
          title: 'Too many requests',
          subtitle: 'You have refreshed a lot. Wait a moment, then try again.',
          action: BbButton(
            label: 'Try again',
            onPressed: reload,
          ),
        );
      case AgencyEngagementStatus.error:
        return BbStatusView(
          icon: Icons.wifi_off,
          title: 'Could not load workers',
          subtitle: 'Please check your connection and try again.',
          action: BbButton(label: 'Retry', onPressed: reload),
        );
      case AgencyEngagementStatus.ready:
        return RefreshIndicator(
          onRefresh: () => context.read<AgencyEngagementCubit>().load(),
          color: AppColors.blue,
          child: ListView.separated(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.gutter,
              AppSpacing.s2,
              AppSpacing.gutter,
              AppSpacing.s6,
            ),
            itemCount: state.workers.length + 1,
            separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.s3),
            itemBuilder: (BuildContext context, int index) {
              if (index == 0) return const _Intro();
              return _WorkerCard(worker: state.workers[index - 1]);
            },
          ),
        );
    }
  }
}

class _Intro extends StatelessWidget {
  const _Intro();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.s2),
      child: Text(
        'How the workers you referred are progressing. Handles only — no names '
        'or numbers.',
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          color: AppColors.textSecondary,
          height: 1.45,
        ),
      ),
    );
  }
}

/// One faceless funnel row: opaque ref, profile-ready badge, applied/unlocked
/// counts, and a coarse last-active line.
class _WorkerCard extends StatelessWidget {
  const _WorkerCard({required this.worker});

  final AgencyWorker worker;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              // Faceless funnel row: the masked avatar is the kit's mark for a
              // candidate with no revealed identity — no name, no photo, no
              // demographic signal, only the opaque ref below it.
              const BbAvatar(
                initials: '••',
                size: 40,
                mode: BbAvatarMode.masked,
              ),
              const SizedBox(width: AppSpacing.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      worker.ref.isNotEmpty ? worker.ref : 'Worker',
                      style: AppTypography.mono(
                        size: AppTypography.sizeBase,
                        weight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: <Widget>[
                        const Icon(Icons.schedule,
                            size: 14, color: AppColors.textFaint),
                        const SizedBox(width: 6),
                        Flexible(
                          child: Text(
                            _lastActiveLabel(worker.lastActiveOn),
                            style: AppTypography.body(
                              size: AppTypography.sizeXs,
                              color: AppColors.textMuted,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.s2),
              worker.profileComplete
                  ? const BbBadge(
                      'Profile ready',
                      tone: BbBadgeTone.success,
                      icon: Icons.check_circle,
                    )
                  : const BbBadge(
                      'Profile pending',
                      tone: BbBadgeTone.warning,
                      icon: Icons.hourglass_bottom,
                    ),
            ],
          ),
          const SizedBox(height: AppSpacing.s3),
          // Hairline — the kit's only separator (no shadow, elevation 0).
          Container(height: 1, color: AppColors.border),
          const SizedBox(height: AppSpacing.s3),
          Row(
            children: <Widget>[
              _MiniStat(label: 'Applied', value: worker.appliedCount),
              const SizedBox(width: AppSpacing.s6),
              _MiniStat(label: 'Unlocked', value: worker.unlockedCount),
            ],
          ),
        ],
      ),
    );
  }
}

class _MiniStat extends StatelessWidget {
  const _MiniStat({required this.label, required this.value});

  final String label;
  final int value;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      children: <Widget>[
        Text(
          '$value',
          style: AppTypography.mono(
            size: AppTypography.sizeLg,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(width: AppSpacing.s2),
        Text(
          label,
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            color: AppColors.textMuted,
          ),
        ),
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
            'Referred workers',
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

/// A calm, low-literacy last-active line. Coarse relative buckets for recent
/// activity, a short absolute date beyond a week, and an honest fallback when the
/// marker is absent (never active, or suppressed server-side).
String _lastActiveLabel(String? iso) {
  if (iso == null || iso.isEmpty) return 'Not active yet';
  final DateTime? when = DateTime.tryParse(iso);
  if (when == null) return 'Not active yet';
  final DateTime now = DateTime.now().toUtc();
  final Duration ago = now.difference(when.toUtc());
  if (ago.isNegative || ago.inDays == 0) return 'Active today';
  if (ago.inDays == 1) return 'Active yesterday';
  if (ago.inDays < 7) return 'Active ${ago.inDays} days ago';
  return 'Last active ${_shortDate(when.toUtc())}';
}

const List<String> _months = <String>[
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

String _shortDate(DateTime d) => '${d.day} ${_months[d.month - 1]} ${d.year}';
