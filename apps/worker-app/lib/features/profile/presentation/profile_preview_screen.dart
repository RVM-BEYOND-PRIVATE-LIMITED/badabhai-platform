import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../router.dart';
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
            ProfileStatus.failed => _buildFailed(context),
            ProfileStatus.ready ||
            ProfileStatus.confirmed =>
              _buildProfile(),
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

  Widget _buildFailed(BuildContext context) {
    return BbStatusView(
      icon: Icons.cloud_off_rounded,
      title: 'Could not prepare your profile.',
      subtitle: 'Please check your internet and try again.',
      action: BbButton(
        label: 'Try again',
        iconLeft: Icons.refresh_rounded,
        onPressed: context.read<ProfileCubit>().extract,
      ),
    );
  }

  Widget _buildProfile() {
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s6),
      children: <Widget>[
        Text('Draft profile (placeholder data):',
            style: AppTypography.body(color: AppColors.textSecondary)),
        const SizedBox(height: AppSpacing.s4),
        const _ProfileRow(
            icon: Icons.badge_outlined, label: 'Role', value: 'VMC Operator'),
        const SizedBox(height: AppSpacing.s3),
        const _ProfileRow(
            icon: Icons.timeline_outlined,
            label: 'Experience',
            value: '5 years'),
        const SizedBox(height: AppSpacing.s3),
        const _ProfileRow(
            icon: Icons.precision_manufacturing_outlined,
            label: 'Machines',
            value: 'VMC, CNC Lathe'),
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

