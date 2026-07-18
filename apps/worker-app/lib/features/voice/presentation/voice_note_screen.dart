import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../domain/voice_models.dart';
import 'cubit/voice_note_cubit.dart';

// ---- Hinglish copy (bada-bhai voice; client-side constants, PII-free) ----
const String _kTitle = 'Voice note';
const String _kIdleHeading = 'Bol kar batayein';
const String _kIdleBody =
    'Mic dabayein aur apne kaam ke baare mein bolein — 2 minute tak. '
    'Hum type kar denge.';
const String _kIdleHint = 'No test, just talk.';
const String _kMicSemanticLabel = 'Recording shuru karein';
const String _kRecordingLabel = 'Sun rahe hain…';
const String _kSendLabel = 'Bhej dein';
const String _kCancelLabel = 'Cancel karein';
const String _kProcessingCaption =
    'Aapki baat likh rahe hain… thoda intezaar karein.';

/// Shown when a back press is held during Processing (#373). States the REAL
/// reason the back did nothing — never a silent no-op.
const String kVoiceBackBlockedLabel =
    'Aapki baat bheji ja rahi hai — bas ek pal ruk jaayein.';
const String _kErrorTitle = 'Voice note nahi gaya.';
const String _kRetryLabel = 'Dobara try karein';
const String _kTypeInsteadLabel = 'Type karke bhejein';

/// Voice-note capture (A2, REAL): tap the mic → record (≤120s, live counter,
/// auto-stop at the cap) → stop → upload + transcribe + merge into chat → pop
/// back to chat with the [VoiceNoteOutcome] so both bubbles show immediately.
///
/// Errors are honest and worker-safe ([failureReason]); a denied mic permission
/// or a 503 (voice not enabled server-side) never dead-ends — the worker can
/// always fall back to typing.
///
/// Back is HELD while the pipeline is in flight (#373): leaving mid-Processing
/// still merged the transcript into the server chat session but dropped the
/// outcome, so the answer existed server-side and nowhere on screen.
class VoiceNoteScreen extends StatelessWidget {
  const VoiceNoteScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<VoiceNoteCubit>(
      create: (_) => locator<VoiceNoteCubit>(),
      child: const _VoiceNoteView(),
    );
  }
}

class _VoiceNoteView extends StatelessWidget {
  const _VoiceNoteView();

  @override
  Widget build(BuildContext context) {
    return BbScaffold(
      appBar: const BbAppBar(title: _kTitle),
      body: BlocConsumer<VoiceNoteCubit, VoiceNoteState>(
        listenWhen: (VoiceNoteState prev, VoiceNoteState curr) =>
            curr is VoiceNoteSuccess,
        listener: (BuildContext context, VoiceNoteState state) {
          // Pop back to chat with the transcript + reply; the chat screen
          // appends both bubbles (see ChatVoiceMerged).
          context.pop((state as VoiceNoteSuccess).outcome);
        },
        builder: (BuildContext context, VoiceNoteState state) {
          // #373 — once the pipeline is running the transcript is ALREADY on
          // its way into the SERVER chat session (the last leg is
          // `chat.sendMessage`), and the cubit closing does not cancel that
          // detached future. A back press here used to pop a null outcome, so
          // the answer landed server-side but never rendered in chat: the
          // worker re-typed it and extraction saw the same answer twice.
          // Hold the route until the pipeline is terminal. This is BOUNDED —
          // `awaitAiJob` caps its polling (~14s) and an error state releases
          // the back button immediately, with typing always open as a fallback.
          final bool pipelineInFlight =
              state is VoiceNoteProcessing || state is VoiceNoteSuccess;
          return PopScope<Object?>(
            canPop: !pipelineInFlight,
            onPopInvokedWithResult: (bool didPop, Object? result) {
              if (didPop) return;
              ScaffoldMessenger.of(context)
                ..hideCurrentSnackBar()
                ..showSnackBar(
                  const SnackBar(content: Text(kVoiceBackBlockedLabel)),
                );
            },
            child: switch (state) {
              VoiceNoteIdle() => _IdleView(
                  onStart: () =>
                      context.read<VoiceNoteCubit>().startRecording(),
                ),
              VoiceNoteRecording(:final int elapsedSeconds) => _RecordingView(
                  elapsedSeconds: elapsedSeconds,
                  maxSeconds: context.read<VoiceNoteCubit>().maxSeconds,
                  onSend: () => context.read<VoiceNoteCubit>().stopAndSend(),
                  onCancel: () =>
                      context.read<VoiceNoteCubit>().cancelRecording(),
                ),
              VoiceNoteProcessing() =>
                const BbStatusView.loading(caption: _kProcessingCaption),
              // Brief frame between success and the pop — keep the spinner up.
              VoiceNoteSuccess() => const BbStatusView.loading(),
              VoiceNoteError(:final Failure failure) => _ErrorView(
                  failure: failure,
                  onRetry: () => context.read<VoiceNoteCubit>().reset(),
                  onTypeInstead: () => context.pop(),
                ),
            },
          );
        },
      ),
    );
  }
}

/// Idle: one big warm mic (well above the 48px tap floor) + minimal copy.
class _IdleView extends StatelessWidget {
  const _IdleView({required this.onStart});

  final VoidCallback onStart;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Semantics(
            button: true,
            label: _kMicSemanticLabel,
            child: Material(
              color: AppColors.saffron50,
              shape: const CircleBorder(),
              child: InkWell(
                customBorder: const CircleBorder(),
                onTap: onStart,
                child: const SizedBox(
                  // 2x the s12 token — a mitten-friendly hero target.
                  width: AppSpacing.s12,
                  height: AppSpacing.s12,
                  child: Icon(Icons.mic_rounded,
                      size: AppSpacing.s9, color: AppColors.saffronDeep),
                ),
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.s5),
          Text(
            _kIdleHeading,
            textAlign: TextAlign.center,
            style: AppTypography.display(
                size: AppTypography.sizeXl, weight: FontWeight.w800),
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            _kIdleBody,
            textAlign: TextAlign.center,
            style: AppTypography.body(
              size: AppTypography.sizeMd,
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            _kIdleHint,
            textAlign: TextAlign.center,
            style: AppTypography.body(color: AppColors.textMuted),
          ),
        ],
      ),
    );
  }
}

/// Recording: live counter (mono — it's data), red "listening" pulse dot,
/// a primary send CTA and a quiet cancel.
class _RecordingView extends StatelessWidget {
  const _RecordingView({
    required this.elapsedSeconds,
    required this.maxSeconds,
    required this.onSend,
    required this.onCancel,
  });

  final int elapsedSeconds;
  final int maxSeconds;
  final VoidCallback onSend;
  final VoidCallback onCancel;

  static String _clock(int seconds) {
    final int m = seconds ~/ 60;
    final int s = seconds % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Container(
            width: AppSpacing.s12,
            height: AppSpacing.s12,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: AppColors.dangerTint,
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.mic_rounded,
                size: AppSpacing.s9, color: AppColors.danger),
          ),
          const SizedBox(height: AppSpacing.s5),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Icon(Icons.fiber_manual_record_rounded,
                  size: 14, color: AppColors.danger),
              const SizedBox(width: AppSpacing.s2),
              Text(
                _kRecordingLabel,
                style: AppTypography.body(
                  size: AppTypography.sizeMd,
                  weight: FontWeight.w700,
                  color: AppColors.textSecondary,
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            '${_clock(elapsedSeconds)} / ${_clock(maxSeconds)}',
            style: AppTypography.mono(size: AppTypography.sizeXl),
          ),
          const SizedBox(height: AppSpacing.s7),
          BbButton(
            label: _kSendLabel,
            block: true,
            iconLeft: Icons.send_rounded,
            onPressed: onSend,
          ),
          const SizedBox(height: AppSpacing.s3),
          BbButton(
            label: _kCancelLabel,
            variant: BbButtonVariant.ghost,
            block: true,
            iconLeft: Icons.close_rounded,
            onPressed: onCancel,
          ),
        ],
      ),
    );
  }
}

/// Error: the honest reason + retry, with typing as the always-open fallback.
class _ErrorView extends StatelessWidget {
  const _ErrorView({
    required this.failure,
    required this.onRetry,
    required this.onTypeInstead,
  });

  final Failure failure;
  final VoidCallback onRetry;
  final VoidCallback onTypeInstead;

  @override
  Widget build(BuildContext context) {
    final ({IconData icon, String reason}) why = failureReason(failure);
    return BbStatusView(
      icon: why.icon,
      title: _kErrorTitle,
      subtitle: why.reason,
      action: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          BbButton(
            label: _kRetryLabel,
            iconLeft: Icons.refresh_rounded,
            onPressed: onRetry,
          ),
          const SizedBox(height: AppSpacing.s3),
          BbButton(
            label: _kTypeInsteadLabel,
            variant: BbButtonVariant.ghost,
            iconLeft: Icons.keyboard_alt_outlined,
            onPressed: onTypeInstead,
          ),
        ],
      ),
    );
  }
}
