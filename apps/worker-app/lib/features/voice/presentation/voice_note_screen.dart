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
import '../../../core/widgets/bb_chat_bubble.dart';
import '../../../core/widgets/bb_chip.dart';
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

/// The post-confirmation leg: the approved transcript is on its way to chat.
const String _kSendingCaption =
    'Aapki baat bhej rahe hain… thoda intezaar karein.';

// ---- Confirm turn (Persona sheet, worked conversation #05) ----
// "The transcript is shown for confirmation, never guessed at." These four
// strings ARE that turn; the two chip labels and the prompt are specified copy.

/// Orients the worker: the bubble below is their own words, read back.
const String kVoiceConfirmHeading = 'Aapne yeh bola';

/// Bada bhai's question on the confirm turn — the exact prompt from the sheet.
const String kVoiceConfirmPrompt = 'Yeh theek hai?';

/// "Yes, send it" — the confirm chip from the sheet.
const String kVoiceConfirmYesLabel = 'Haan';

/// "It needs fixing" — the correct chip from the sheet. Opens re-record + edit.
const String kVoiceConfirmFixLabel = 'Sudhaarna hai';

/// Heading of the correction panel behind "Sudhaarna hai".
const String kVoiceEditHeading = 'Theek karke bhej dein';

/// Placeholder for the inline edit field.
const String kVoiceEditHint = 'Yahan sudhaar karein';

/// Throw the transcript away and speak again. Nothing was sent, so this is free.
const String kVoiceReRecordLabel = 'Dobara bolein';

/// Shown when a back press is held while the TRANSCRIBE leg is running (#373).
/// States the REAL reason the back did nothing — never a silent no-op.
const String kVoiceBackBlockedLabel =
    'Aapki baat likhi ja rahi hai — bas ek pal ruk jaayein.';

/// Shown when a back press is held while the CONFIRMED transcript is being sent.
/// This is the leg the #373 divergence actually lives on: the message reaches
/// the server chat session here, so leaving would strand it off-screen.
const String kVoiceBackBlockedSendingLabel =
    'Aapki baat bheji ja rahi hai — bas ek pal ruk jaayein.';
const String _kErrorTitle = 'Voice note nahi gaya.';
const String _kRetryLabel = 'Dobara try karein';
const String _kTypeInsteadLabel = 'Type karke bhejein';

/// Voice-note capture (A2, REAL): tap the mic → record (≤120s, live counter,
/// auto-stop at the cap) → stop → upload + transcribe → **show the transcript
/// and ask "Yeh theek hai?"** → on "Haan", merge into chat → pop back with the
/// [VoiceNoteOutcome] so both bubbles show immediately.
///
/// THE CONFIRM TURN IS THE POINT (Persona sheet, worked conversation #05). The
/// transcript used to be sent inside the pipeline, so the worker's answer of
/// record was whatever the recogniser heard — they saw it for the first time as
/// a sent bubble, already parsed. Now nothing reaches the chat session until
/// they say so, and "Sudhaarna hai" lets them re-record or fix the words first.
///
/// Errors are honest and worker-safe ([failureReason]); a denied mic permission
/// or a 503 (voice not enabled server-side) never dead-ends — the worker can
/// always fall back to typing.
///
/// Back is HELD while either leg is in flight (#373). It is NOT held on the
/// confirm turn: nothing has been sent there, so leaving costs the transcript
/// and desynchronises nothing.
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
          // #373 — hold the route while work is in flight. On the SENDING leg
          // the transcript is already on its way into the SERVER chat session
          // and the cubit closing does not cancel that detached future: a back
          // press used to pop a null outcome, so the answer landed server-side
          // but never rendered in chat, and the worker re-typed it. On the
          // TRANSCRIBE leg nothing has been sent, but the upload + poll are
          // running and leaving would silently bin them.
          //
          // NOT held on the confirm turn — that is a decision point, and a
          // worker who changes their mind there must be able to walk away.
          //
          // BOUNDED: `awaitAiJob` caps its polling (~14s) and an error state
          // releases back immediately, with typing always open as a fallback.
          final bool pipelineInFlight =
              state is VoiceNoteProcessing || state is VoiceNoteSuccess;
          final bool sendingLeg =
              state is VoiceNoteProcessing && state.sending;
          return PopScope<Object?>(
            canPop: !pipelineInFlight,
            onPopInvokedWithResult: (bool didPop, Object? result) {
              if (didPop) return;
              ScaffoldMessenger.of(context)
                ..hideCurrentSnackBar()
                ..showSnackBar(
                  SnackBar(
                    content: Text(sendingLeg
                        ? kVoiceBackBlockedSendingLabel
                        : kVoiceBackBlockedLabel),
                  ),
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
                  onSend: () =>
                      context.read<VoiceNoteCubit>().stopAndTranscribe(),
                  onCancel: () =>
                      context.read<VoiceNoteCubit>().cancelRecording(),
                ),
              VoiceNoteProcessing(:final bool sending) => BbStatusView.loading(
                  caption: sending ? _kSendingCaption : _kProcessingCaption,
                ),
              // The confirm turn — keyed on the transcript so an edit rebuilds
              // the panel with the corrected text instead of a stale controller.
              VoiceNoteTranscriptReady(:final String transcript) => _ConfirmView(
                  key: ValueKey<String>(transcript),
                  transcript: transcript,
                  onConfirm: () => context.read<VoiceNoteCubit>().confirm(),
                  onReRecord: () => context.read<VoiceNoteCubit>().reRecord(),
                  onEdit: (String text) =>
                      context.read<VoiceNoteCubit>().edit(text),
                ),
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
              // Kit mic language: the mic is the ONE haldi hero on this screen —
              // a solid haldi circle with a deep-blue glyph (on-haldi is always blue).
              color: AppColors.haldi,
              shape: const CircleBorder(),
              child: InkWell(
                customBorder: const CircleBorder(),
                onTap: onStart,
                child: const SizedBox(
                  // 2x the s12 token — a mitten-friendly hero target.
                  width: AppSpacing.s12,
                  height: AppSpacing.s12,
                  child: Icon(Icons.mic_rounded,
                      size: AppSpacing.s9, color: AppColors.onHaldi),
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
          SizedBox(
            width: AppSpacing.s12,
            height: AppSpacing.s12,
            child: Stack(
              alignment: Alignment.center,
              children: <Widget>[
                // DETERMINATE record ring — fills as the cap (maxSeconds)
                // approaches, so the record state shows real progress rather than
                // a bare/indeterminate spinner. The mono clock reads out the same.
                Positioned.fill(
                  child: CircularProgressIndicator(
                    value: maxSeconds > 0
                        ? (elapsedSeconds / maxSeconds).clamp(0.0, 1.0)
                        : 0.0,
                    strokeWidth: 4,
                    backgroundColor: AppColors.dangerTint,
                    valueColor:
                        const AlwaysStoppedAnimation<Color>(AppColors.danger),
                  ),
                ),
                Container(
                  width: AppSpacing.s11,
                  height: AppSpacing.s11,
                  alignment: Alignment.center,
                  decoration: const BoxDecoration(
                    color: AppColors.dangerTint,
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(Icons.mic_rounded,
                      size: AppSpacing.s8, color: AppColors.danger),
                ),
              ],
            ),
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

/// The CONFIRM TURN (Persona sheet, worked conversation #05).
///
/// Reads the transcript back in the worker's own bubble, then asks — in bada
/// bhai's voice, on the left — "Yeh theek hai?" with two chips. Nothing has been
/// sent to the chat session at this point and nothing will be until "Haan".
///
/// "Sudhaarna hai" opens the correction panel, which offers BOTH ways to fix it:
/// edit the words inline (for a small mis-hear) or re-record (when the whole
/// thing came out wrong). A low-literacy worker who cannot comfortably type
/// still has the mic; a worker in a noisy shop floor still has the keyboard.
class _ConfirmView extends StatefulWidget {
  const _ConfirmView({
    super.key,
    required this.transcript,
    required this.onConfirm,
    required this.onReRecord,
    required this.onEdit,
  });

  final String transcript;
  final VoidCallback onConfirm;
  final VoidCallback onReRecord;
  final ValueChanged<String> onEdit;

  @override
  State<_ConfirmView> createState() => _ConfirmViewState();
}

class _ConfirmViewState extends State<_ConfirmView> {
  /// True once "Sudhaarna hai" was tapped — swaps the chips for the correction
  /// panel. Local UI state: choosing to LOOK at the edit box is not a decision
  /// the cubit (or the server) needs to know about.
  bool _correcting = false;

  late final TextEditingController _controller =
      TextEditingController(text: widget.transcript);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// Apply the edit, then send — one tap, because "Bhej dein" in the correction
  /// panel means send, and making them confirm twice would be a trap.
  void _sendEdited() {
    final String text = _controller.text.trim();
    if (text.isEmpty) return;
    if (text != widget.transcript) widget.onEdit(text);
    widget.onConfirm();
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text(
            kVoiceConfirmHeading,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          ),
          const SizedBox(height: AppSpacing.s2),
          // The worker's own words, in the worker's own bubble.
          BbChatBubble(text: widget.transcript, fromWorker: true),
          const SizedBox(height: AppSpacing.s3),
          // Bada bhai asking. Left-aligned bot bubble, exactly as in chat.
          const BbChatBubble(text: kVoiceConfirmPrompt, fromWorker: false),
          const SizedBox(height: AppSpacing.s4),
          if (!_correcting) _chips() else _correctionPanel(),
        ],
      ),
    );
  }

  Widget _chips() {
    return Row(
      children: <Widget>[
        Expanded(
          child: BbChip(
            label: kVoiceConfirmYesLabel,
            selected: true,
            onTap: widget.onConfirm,
          ),
        ),
        const SizedBox(width: AppSpacing.s3),
        Expanded(
          child: BbChip(
            label: kVoiceConfirmFixLabel,
            onTap: () => setState(() => _correcting = true),
          ),
        ),
      ],
    );
  }

  Widget _correctionPanel() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(
          kVoiceEditHeading,
          style: AppTypography.body(
            size: AppTypography.sizeMd,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        TextField(
          controller: _controller,
          minLines: 3,
          maxLines: 6,
          autofocus: true,
          style: AppTypography.body(size: AppTypography.sizeSm),
          decoration: const InputDecoration(
            hintText: kVoiceEditHint,
            contentPadding: EdgeInsets.symmetric(
              horizontal: AppSpacing.s3,
              vertical: AppSpacing.s3,
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
        BbButton(
          label: _kSendLabel,
          block: true,
          iconLeft: Icons.send_rounded,
          onPressed: _sendEdited,
        ),
        const SizedBox(height: AppSpacing.s3),
        // The other half of "Sudhaarna hai": start over with the mic.
        BbButton(
          label: kVoiceReRecordLabel,
          variant: BbButtonVariant.ghost,
          block: true,
          iconLeft: Icons.mic_rounded,
          onPressed: widget.onReRecord,
        ),
      ],
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
