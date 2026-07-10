import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/pdf_launcher.dart';
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
            ResumeStatus.noProfile => _buildNoProfile(context),
            ResumeStatus.failed => _buildFailed(context),
            ResumeStatus.ready => _buildResume(state.resumeText),
          },
        );
      },
    );
  }

  Widget _actions(BuildContext context) {
    // Download the resume PDF (GET /resume/:id/download — real, worker-authed),
    // then the safe-field edit entry-point.
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        const _DownloadResumeButton(),
        const SizedBox(height: AppSpacing.s2),
        BbButton(
          label: 'Naam / photo / phone edit karein',
          block: true,
          variant: BbButtonVariant.ghost,
          iconLeft: Icons.edit_outlined,
          onPressed: () => context.push(Routes.resumeEdit),
        ),
      ],
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

  /// Worker has no profile yet — nothing to build a resume from. Guide them to
  /// finish profiling rather than showing a network error.
  Widget _buildNoProfile(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(Icons.badge_outlined, size: 48, color: AppColors.textMuted),
            const SizedBox(height: AppSpacing.s4),
            Text('Abhi resume nahi ban sakta.',
                textAlign: TextAlign.center,
                style: AppTypography.display(size: AppTypography.sizeMd)),
            const SizedBox(height: AppSpacing.s2),
            Text('Pehle apna profile poora karein — fir resume apne aap ban jayega.',
                textAlign: TextAlign.center,
                style: AppTypography.body(color: AppColors.textSecondary)),
            const SizedBox(height: AppSpacing.s6),
            BbButton(
              label: 'Profile poora karein',
              iconLeft: Icons.arrow_forward_rounded,
              onPressed: () => context.go(Routes.consent),
            ),
          ],
        ),
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
          Text('Resume abhi ban nahi paya.',
              textAlign: TextAlign.center,
              style: AppTypography.display(size: AppTypography.sizeMd)),
          const SizedBox(height: AppSpacing.s2),
          Text('Thodi der baad dobara try karein.',
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

/// "Download PDF" CTA. Resolves a short-lived signed url via the cubit and opens
/// it in the device viewer; shows its own spinner while resolving and a
/// user-safe SnackBar on failure. The url is launched immediately, never logged.
class _DownloadResumeButton extends StatefulWidget {
  const _DownloadResumeButton();

  @override
  State<_DownloadResumeButton> createState() => _DownloadResumeButtonState();
}

class _DownloadResumeButtonState extends State<_DownloadResumeButton> {
  bool _loading = false;

  Future<void> _download() async {
    final ResumeCubit cubit = context.read<ResumeCubit>();
    setState(() => _loading = true);
    await openSignedPdf(context, resolve: cubit.resolveDownloadUrl);
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    return BbButton(
      label: 'PDF download karein',
      block: true,
      iconLeft: Icons.download_rounded,
      loading: _loading,
      onPressed: _download,
    );
  }
}
