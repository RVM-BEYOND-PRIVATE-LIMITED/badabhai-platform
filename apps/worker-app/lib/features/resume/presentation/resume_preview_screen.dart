import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/pdf_downloader.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../router.dart';
import 'cubit/resume_cubit.dart';
import 'resume_photo_header.dart';

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
          body: switch (state.status) {
            ResumeStatus.loading =>
              const Center(child: CircularProgressIndicator()),
            ResumeStatus.noProfile => _buildNoProfile(context),
            ResumeStatus.failed => _buildFailed(context),
            ResumeStatus.ready => _buildResume(context, state.resumeText),
          },
        );
      },
    );
  }

  Widget _buildResume(BuildContext context, String resumeText) {
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s6),
      children: <Widget>[
        Card(
          // A clearer lift than the default card so the resume stands out on the
          // paper background.
          elevation: 6,
          shadowColor: AppColors.ink900.withValues(alpha: 0.18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              // ADR-0032: the worker's OWN photo — rendered ONLY when the
              // "Photo dikhayein" pref is on AND a photo exists (the toggle
              // finally gates something). Self-contained + fail-silent: works
              // on both entry paths (generate + Building handoff) and never
              // fabricates a placeholder into the resume itself.
              const ResumePhotoHeader(),
              Padding(
                padding: const EdgeInsets.all(AppSpacing.s4),
                child: Text(
                  resumeText,
                  style: AppTypography.body(size: AppTypography.sizeMd),
                ),
              ),
              const Divider(height: 1, color: AppColors.divider),
              // In-card actions: download the PDF (GET /resume/:id/download —
              // real, worker-authed) + the safe-field edit entry-point.
              Padding(
                padding: const EdgeInsets.all(AppSpacing.s4),
                child: Column(
                  children: <Widget>[
                    const _DownloadResumeButton(),
                    const SizedBox(height: AppSpacing.s2),
                    BbButton(
                      label: 'Edit resume',
                      block: true,
                      variant: BbButtonVariant.ghost,
                      iconLeft: Icons.edit_outlined,
                      onPressed: () => context.push(Routes.resumeEdit),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
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

/// "Download PDF" CTA. Resolves a short-lived signed url via the cubit and
/// downloads the PDF IN-APP into the device's Downloads — the worker stays on
/// this screen (started/complete SnackBars, "Kholein" opens the saved file).
/// The button stays busy (disabled) for the WHOLE download so a double-tap
/// can't produce double files. The url is fetched in memory, never logged.
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
    await downloadSignedPdf(
      context,
      resolve: cubit.resolveDownloadUrl,
      fileName: 'BadaBhai-Resume.pdf',
    );
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    return BbButton(
      label: 'Download Resume',
      block: true,
      iconLeft: Icons.download_rounded,
      loading: _loading,
      onPressed: _download,
    );
  }
}
