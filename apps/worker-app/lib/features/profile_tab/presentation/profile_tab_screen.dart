import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_list_row.dart';
import '../../../core/widgets/bb_progress_bar.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_verified_badge.dart';
import '../../../router.dart';
import 'cubit/profile_tab_cubit.dart';
import '../domain/profile_summary.dart';

/// The tabbed Profile (spec §5.9) — distinct from the profiling ProfilePreview.
/// Header + strength card + the Interview-kit shortcut (switches to the Resume
/// tab and pushes the kit).
class ProfileTabScreen extends StatelessWidget {
  const ProfileTabScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ProfileTabCubit>(
      create: (_) => locator<ProfileTabCubit>()..load(),
      child: const _ProfileTabView(),
    );
  }
}

class _ProfileTabView extends StatelessWidget {
  const _ProfileTabView();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: BbAppBar(
        title: 'Profile',
        actions: <Widget>[
          IconButton(
            tooltip: 'Settings',
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => context.push(Routes.settings),
          ),
        ],
      ),
      body: BlocBuilder<ProfileTabCubit, ProfileTabState>(
        builder: (BuildContext context, ProfileTabState state) {
          return switch (state.status) {
            ProfileTabStatus.loading => const BbStatusView.loading(),
            ProfileTabStatus.failed => BbStatusView(
                icon: Icons.cloud_off_rounded,
                title: 'Could not load your profile.',
                subtitle: 'Please check your internet and try again.',
                action: FilledButton(
                  onPressed: () => context.read<ProfileTabCubit>().load(),
                  child: const Text('Try again'),
                ),
              ),
            ProfileTabStatus.ready => _profile(context, state.summary!),
          };
        },
      ),
    );
  }

  Widget _profile(BuildContext context, ProfileSummary s) {
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.gutter),
      children: <Widget>[
        _header(s),
        const SizedBox(height: AppSpacing.s5),
        _strengthCard(s),
        const SizedBox(height: AppSpacing.s4),
        _kitShortcut(context),
      ],
    );
  }

  Widget _header(ProfileSummary s) {
    return Row(
      children: <Widget>[
        SizedBox(
          width: 72,
          height: 72,
          child: Stack(
            clipBehavior: Clip.none,
            children: <Widget>[
              Container(
                width: 72,
                height: 72,
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: <Color>[AppColors.saffron300, AppColors.saffron200],
                  ),
                ),
                alignment: Alignment.center,
                child: Text(
                  s.initials,
                  style: AppTypography.display(
                      size: AppTypography.size2xl,
                      weight: FontWeight.w800,
                      color: AppColors.vermilion800),
                ),
              ),
              if (s.verified)
                const Positioned(
                  right: -2,
                  bottom: -2,
                  child: BbSeal(),
                ),
            ],
          ),
        ),
        const SizedBox(width: AppSpacing.s4),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(s.displayName,
                  style: AppTypography.display(
                      size: AppTypography.sizeXl, weight: FontWeight.w800)),
              const SizedBox(height: 2),
              Text('${s.tradeLabel} · ${s.city}',
                  style: AppTypography.body(color: AppColors.textMuted)),
              if (s.verified) ...<Widget>[
                const SizedBox(height: AppSpacing.s2),
                const BbVerifiedBadge(),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _strengthCard(ProfileSummary s) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      padding: const EdgeInsets.all(AppSpacing.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: <Widget>[
              Text('Profile strength',
                  style: AppTypography.body(
                      size: AppTypography.sizeSm, weight: FontWeight.w700)),
              Text('${(s.strength * 100).round()}%',
                  style: AppTypography.mono(color: AppColors.textMuted)),
            ],
          ),
          const SizedBox(height: AppSpacing.s2),
          BbProgressBar(value: s.strength),
          const SizedBox(height: AppSpacing.s3),
          Text('Ek photo add karein aur 100% tak pahunchein.',
              style: AppTypography.body(color: AppColors.textMuted)),
        ],
      ),
    );
  }

  Widget _kitShortcut(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      clipBehavior: Clip.antiAlias,
      // Switches to the Resume tab and opens the kit (kit lives under the
      // Resume branch — tab='resume' per the spec).
      child: BbListRow.kit(
        icon: Icons.quiz_outlined,
        title: 'Interview kit',
        subtitle: '15 sawaal + jawaab',
        onTap: () => context.go(Routes.kit),
      ),
    );
  }
}
