import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../router.dart';
import '../../profile_tab/domain/profile_summary.dart';
import 'cubit/profile_cubit.dart';

class ProfilePreviewScreen extends StatelessWidget {
  const ProfilePreviewScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ProfileCubit>(
      create: (_) => locator<ProfileCubit>()..extract(),
      child: const _ProfileView(),
    );
  }
}

class _ProfileView extends StatelessWidget {
  const _ProfileView();

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<ProfileCubit, ProfileState>(
      listenWhen: (prev, curr) => prev.status != curr.status,
      listener: (BuildContext context, ProfileState state) {
        if (state.status == ProfileStatus.confirmed) {
          // Profile confirmed — generate the resume (Building) then enter the
          // shell. context.go clears the onboarding stack (point of no return).
          context.go(Routes.building);
        }
      },
      builder: (BuildContext context, ProfileState state) {
        final bool isReady = state.status == ProfileStatus.ready ||
            state.status == ProfileStatus.confirmed;
        return BbScaffold(
          appBar: const BbAppBar(title: 'Your profile'),
          bottomBar: isReady
              ? BbButton(
                  label: 'Confirm & generate resume',
                  block: true,
                  iconLeft: Icons.description_outlined,
                  onPressed: context.read<ProfileCubit>().confirm,
                )
              : null,
          body: switch (state.status) {
            ProfileStatus.extracting => _buildWaiting(),
            ProfileStatus.failed => _buildFailed(context, state),
            ProfileStatus.ready ||
            ProfileStatus.confirmed =>
              _buildProfile(state.summary),
          },
        );
      },
    );
  }

  Widget _buildWaiting() {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const CircularProgressIndicator(),
          const SizedBox(height: AppSpacing.s6),
          Text(
            'Bada Bhai is preparing your profile…',
            textAlign: TextAlign.center,
            style: AppTypography.display(size: AppTypography.sizeMd),
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            'This takes a few seconds. Please wait.',
            textAlign: TextAlign.center,
            style: AppTypography.body(color: AppColors.textSecondary),
          ),
        ],
      ),
    );
  }

  Widget _buildFailed(BuildContext context, ProfileState state) {
    return BbStatusView(
      icon: failureReason(state.failure).icon,
      title: 'Profile taiyaar nahi ho payi.',
      subtitle: failureReason(state.failure).reason,
      action: BbButton(
        label: 'Try again',
        iconLeft: Icons.refresh_rounded,
        onPressed: context.read<ProfileCubit>().extract,
      ),
    );
  }

  /// Renders the REAL extracted profile read back from the summary route. Every
  /// value is actual data or an honest "being finalised" note — never a
  /// fabricated placeholder (the worker confirms what they can actually see).
  Widget _buildProfile(ProfileSummary? summary) {
    if (summary == null) {
      // Extraction succeeded but the summary read missed. Be honest — no fake
      // rows — and still let the worker confirm (the profile does exist).
      return ListView(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.s6),
        children: <Widget>[
          const _ProfileRow(
              icon: Icons.check_circle_outline,
              label: 'Profile',
              value: 'Ready'),
          const SizedBox(height: AppSpacing.s3),
          Text(
            'Details abhi dikh nahi paa rahe — aap confirm karke aage badh sakte hain.',
            style: AppTypography.body(color: AppColors.textSecondary),
          ),
        ],
      );
    }

    final String trade = (summary.tradeLabel?.isNotEmpty ?? false)
        ? summary.tradeLabel!
        : 'Tayyar ho raha hai…';
    final int pct = (summary.strength.clamp(0, 1) * 100).round();
    final String? city =
        (summary.city?.isNotEmpty ?? false) ? summary.city : null;

    return ListView(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s6),
      children: <Widget>[
        Text('Aapki profile:',
            style: AppTypography.body(color: AppColors.textSecondary)),
        const SizedBox(height: AppSpacing.s4),
        _ProfileRow(
            icon: Icons.badge_outlined, label: 'Trade', value: trade),
        if (city != null) ...<Widget>[
          const SizedBox(height: AppSpacing.s3),
          _ProfileRow(
              icon: Icons.place_outlined, label: 'City', value: city),
        ],
        const SizedBox(height: AppSpacing.s3),
        _ProfileRow(
            icon: Icons.insights_outlined,
            label: 'Profile strength',
            value: '$pct% complete'),
      ],
    );
  }
}

/// One labelled profile attribute card with a warm saffron icon chip.
class _ProfileRow extends StatelessWidget {
  const _ProfileRow({
    required this.icon,
    required this.label,
    required this.value,
  });

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.s4),
        child: Row(
          children: <Widget>[
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: AppColors.saffron50,
                borderRadius: BorderRadius.circular(AppRadii.sm),
              ),
              child: Icon(icon, color: AppColors.saffronDeep, size: 24),
            ),
            const SizedBox(width: AppSpacing.s4),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(label, style: AppTypography.eyebrow()),
                const SizedBox(height: 2),
                Text(value,
                    style: AppTypography.body(
                        size: AppTypography.sizeMd, weight: FontWeight.w600)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

