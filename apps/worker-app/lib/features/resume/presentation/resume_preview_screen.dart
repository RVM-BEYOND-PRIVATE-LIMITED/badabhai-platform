import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/pdf_downloader.dart';
import '../../../core/util/resume_file_name.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../router.dart';
import '../domain/resume_edit_repository.dart';
import '../domain/resume_safe_fields.dart';
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

class _ResumeView extends StatefulWidget {
  const _ResumeView();

  @override
  State<_ResumeView> createState() => _ResumeViewState();
}

class _ResumeViewState extends State<_ResumeView> {
  /// Bumped every time the worker returns from the edit screen, and used as the
  /// [ResumePhotoHeader]'s key so a NEW State is built and the photo re-fetched.
  ///
  /// The header loads only in initState, so without this a photo the worker just
  /// added/removed never appeared on return — the preview kept showing the photo
  /// state from when the screen first mounted. Keyed rather than lifting the
  /// photo into ResumeCubit: the header is deliberately self-contained and
  /// fail-silent (the photo is garnish; it must never cost the worker their
  /// resume text), and a key keeps that property.
  int _photoNonce = 0;

  /// Returning from the editor: the photo may have changed either way, so always
  /// refetch it. Regenerate ONLY on a real name change — the name is baked in at
  /// generation time, and an unconditional regenerate would spend one of the
  /// worker's 5 daily generates and bin the rendered PDF.
  void _onEditReturned(bool nameChanged) {
    if (!mounted) return;
    setState(() => _photoNonce++);
    if (nameChanged) {
      context.read<ResumeCubit>().generate(force: true);
    }
  }

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
              // Keyed on the edit-return nonce so a photo the worker just
              // added/removed is re-fetched instead of showing mount-time state.
              ResumePhotoHeader(key: ValueKey<int>(_photoNonce)),
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
                    _EditResumeButton(onReturned: _onEditReturned),
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
/// "Edit resume" — opens the safe-field editor and, when the worker actually
/// CHANGED THEIR NAME, regenerates the resume on return.
///
/// The name is baked into the resume at generation time, so a PATCHed name was
/// invisible here: the editor popped a bare `null` and the preview kept showing
/// the old text (and downloaded a PDF titled with the old name, #398).
/// Regenerating rebuilds the text AND — because a generate resets the row to
/// render_status 'pending' server-side — re-enqueues the PDF render.
///
/// Gated on `changed == true` deliberately: an unconditional regenerate would
/// spend one of the worker's 5 daily generates and bin the rendered PDF on every
/// prefs-only save.
class _EditResumeButton extends StatelessWidget {
  const _EditResumeButton({required this.onReturned});

  /// Called when the editor pops, with TRUE when the worker's NAME changed.
  final ValueChanged<bool> onReturned;

  @override
  Widget build(BuildContext context) {
    return BbButton(
      label: 'Edit resume',
      block: true,
      variant: BbButtonVariant.ghost,
      iconLeft: Icons.edit_outlined,
      onPressed: () async {
        // The editor pops `true` only when the name actually changed; a
        // dismissed screen pops null.
        final bool? changed = await context.push<bool>(Routes.resumeEdit);
        onReturned(changed == true);
      },
    );
  }
}

/// How many times the download resolver re-checks a "still rendering" 409, and
/// how long it waits between checks.
///
/// ~6s total: generous for a render that is genuinely in flight, short enough
/// that a server with rendering DISABLED (where the PDF never arrives) still
/// gives the worker the honest "taiyaar ho rahi hai" quickly instead of an
/// endless spinner.
const int _kReadyMaxAttempts = 5;
const Duration _kReadyPollInterval = Duration(milliseconds: 1500);

class _DownloadResumeButton extends StatefulWidget {
  const _DownloadResumeButton();

  @override
  State<_DownloadResumeButton> createState() => _DownloadResumeButtonState();
}

class _DownloadResumeButtonState extends State<_DownloadResumeButton> {
  bool _loading = false;

  /// The saved-file name, derived from the worker's OWN name (§2 self-read, no
  /// LLM — see [resumeDownloadFileName]). PREFETCHED on mount so the tap adds no
  /// latency; it stays the generic [kFallbackResumeFileName] until (and unless)
  /// the name resolves. A name-fetch failure NEVER blocks the download — the
  /// worker's name on the file is a nicety, not a precondition.
  String _fileName = kFallbackResumeFileName;

  @override
  void initState() {
    super.initState();
    _prefetchFileName();
  }

  Future<void> _prefetchFileName() async {
    try {
      final ResumeSafeFields fields =
          await locator<ResumeEditRepository>().load();
      if (!mounted) return;
      setState(() => _fileName = resumeDownloadFileName(fields.displayName));
    } catch (_) {
      // Best-effort: keep the fallback name (offline / session gone / unset name).
    }
  }

  /// Resolves the signed url, tolerating the SHORT "still rendering" window.
  ///
  /// A generate resets the row to render_status 'pending' and re-enqueues the
  /// render, so right after an edit-driven regenerate the first download
  /// legitimately 409s (→ [ResumeNotReadyFailure]). One-shotting that told the
  /// worker their download failed when it was simply seconds early. Poll briefly
  /// instead — the button stays in its loading state, so this reads as
  /// "checking…" rather than a stall.
  ///
  /// Deliberately BOUNDED and short: when rendering is disabled server-side the
  /// PDF never arrives, and the worker must get the honest "taiyaar ho rahi hai"
  /// rather than an indefinite spinner. Only the not-ready case retries — every
  /// other failure surfaces immediately. The url handling itself is untouched
  /// (in-app fetch + MediaStore save; no url_launcher).
  Future<String?> _resolveWithReadyPoll(ResumeCubit cubit) async {
    for (int attempt = 0; attempt < _kReadyMaxAttempts; attempt++) {
      try {
        return await cubit.resolveDownloadUrl();
      } on ResumeNotReadyFailure {
        if (attempt == _kReadyMaxAttempts - 1) rethrow;
        await Future<void>.delayed(_kReadyPollInterval);
      }
    }
    return null; // unreachable: the last attempt either returns or rethrows.
  }

  Future<void> _download() async {
    final ResumeCubit cubit = context.read<ResumeCubit>();
    setState(() => _loading = true);
    await downloadSignedPdf(
      context,
      resolve: () => _resolveWithReadyPoll(cubit),
      fileName: _fileName,
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
