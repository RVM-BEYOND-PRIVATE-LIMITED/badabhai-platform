import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_festive_card.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../router.dart';
import 'cubit/resume_cubit.dart';

class ResumePreviewScreen extends StatelessWidget {
  const ResumePreviewScreen({super.key, this.initialResume});

  /// The resume text generated upstream by the Building screen. When present it
  /// is shown directly (no re-generation); when null the screen generates.
  final String? initialResume;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ResumeCubit>(
      create: (_) {
        final ResumeCubit cubit = locator<ResumeCubit>();
        if (initialResume != null) {
          cubit.showGenerated(initialResume!);
        } else {
          cubit.generate();
        }
        return cubit;
      },
      child: const _ResumeView(),
    );
  }
}

class _ResumeView extends StatelessWidget {
  const _ResumeView();

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<ResumeCubit, ResumeState>(
      builder: (BuildContext context, ResumeState state) {
        return BbScaffold(
          appBar: const BbAppBar(title: 'Your resume'),
          bottomBar: state.status == ResumeStatus.ready ? _actions(context) : null,
          body: switch (state.status) {
            ResumeStatus.loading =>
              const Center(child: CircularProgressIndicator()),
            ResumeStatus.failed => _buildFailed(context),
            ResumeStatus.ready => _buildResume(state.resumeText),
          },
        );
      },
    );
  }

  Widget _actions(BuildContext context) {
    // Download-PDF + WhatsApp-share are §7 follow-ups; the safe-field edit is the
    // one entry-point in scope here.
    return BbButton(
      label: 'Naam / photo / phone edit karein',
      block: true,
      variant: BbButtonVariant.ghost,
      iconLeft: Icons.edit_outlined,
      onPressed: () => context.push(Routes.resumeEdit),
    );
  }

  Widget _buildResume(String resumeText) {
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s6),
      children: <Widget>[
        _buildHeader(),
        const SizedBox(height: AppSpacing.s5),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.s4),
            child: Text(
              resumeText,
              style: AppTypography.body(size: AppTypography.sizeMd),
            ),
          ),
        ),
      ],
    );
  }

  /// Celebratory festive header — the "stamp" moment when the resume is ready.
  Widget _buildHeader() {
    return BbFestiveCard(
      child: Row(
        children: <Widget>[
          Container(
            width: 52,
            height: 52,
            decoration: BoxDecoration(
              color: AppColors.saffron50,
              borderRadius: BorderRadius.circular(AppRadii.md),
            ),
            child: const Icon(Icons.description_rounded,
                color: AppColors.saffronDeep, size: 28),
          ),
          const SizedBox(width: AppSpacing.s4),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('Resume ready! 👍',
                    style: AppTypography.display(size: AppTypography.sizeLg)),
                const SizedBox(height: 2),
                Text(
                  'Free, and yours to share.',
                  style: AppTypography.body(color: AppColors.textSecondary),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildFailed(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const Icon(Icons.cloud_off_rounded, size: 48, color: AppColors.textMuted),
          const SizedBox(height: AppSpacing.s4),
          Text('Could not make your resume.',
              textAlign: TextAlign.center,
              style: AppTypography.display(size: AppTypography.sizeMd)),
          const SizedBox(height: AppSpacing.s2),
          Text('Please check your internet and try again.',
              textAlign: TextAlign.center,
              style: AppTypography.body(color: AppColors.textSecondary)),
          const SizedBox(height: AppSpacing.s6),
          BbButton(
            label: 'Try again',
            iconLeft: Icons.refresh_rounded,
            onPressed: context.read<ResumeCubit>().generate,
          ),
        ],
      ),
    );
  }
}
