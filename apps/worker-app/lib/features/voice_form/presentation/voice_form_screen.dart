import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../voice/domain/voice_models.dart';
import '../domain/voice_form_models.dart';
import '../domain/voice_review_row.dart';
import 'cubit/voice_form_cubit.dart';
import 'voice_review_screen.dart';
import 'widgets/voice_choice_chips.dart';
import 'widgets/voice_dot_rail.dart';
import 'widgets/voice_level_meter.dart';

// Persona-clean copy (scanned by persona_neutrality_test.dart).
const String _kTitle = 'Aapka profile';
const String _kPreparing = 'Taiyaari ho rahi hai.';
const String _kSubmitting = 'Aapka profile bhej rahe hain.';
const String _kListening = 'Sun rahe hain';
const String _kNotListening = 'Ab nahi sun rahe';
const String _kWhyLabel = 'Yeh kyun poochh rahe hain';
const String _kReplayLabel = 'Sawaal dobara sunein';
const String _kNext = 'Aage badhein';
const String _kReRecord = 'Phir se bolein';
const String _kDontKnow = 'Nahi pata';
const String _kDontKnowValue = 'Nahi pata'; // literal text the engine → declined
const String _kMicFootnote = 'Mic sirf jawaab ke waqt chalu hota hai';

// Review-correction copy (#700), persona-clean (scanned by
// persona_neutrality_test.dart). Aap-form only, no vocative, no exclamation.
const String _kRebuildNotice = 'Aapka profile dobara ban raha hai.';
const String _kTypeTitle = 'Type karke likhein';
const String _kTypeHint = 'Yahan likhein';
const String _kSave = 'Theek hai';
const String _kCancel = 'Rehne dein';
const String _kSpeakTitle = 'Boliye';
const String _kStopRecording = 'Ho gaya';

/// The one-question-at-a-time voice-form screen (#629): dot-rail progress (no
/// numerals, can only grow), the question with a replay speaker and an inline
/// "why", chips for a choice question, a safety-critical mic-state row driven by
/// real amplitude, and the answer actions.
///
/// Route-agnostic: it is handed a built [VoiceFormCubit] (the session gateway is
/// still B6-frozen, so there is no locator binding yet) and reports terminal
/// transitions through callbacks.
class VoiceFormScreen extends StatefulWidget {
  const VoiceFormScreen({
    super.key,
    required this.cubit,
    this.onReview,
    this.onComplete,
    this.onExit,
  });

  final VoiceFormCubit cubit;
  final ValueChanged<List<VoiceAnswer>>? onReview;
  final VoidCallback? onComplete;
  final VoidCallback? onExit;

  @override
  State<VoiceFormScreen> createState() => _VoiceFormScreenState();
}

class _VoiceFormScreenState extends State<VoiceFormScreen>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    // Forward lifecycle to the cubit (#636): a call / backgrounding pauses the
    // session; the cubit's handler is idempotent, so a single observer is enough
    // and repeated transitions never stack.
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    widget.cubit.handleLifecycle(state);
  }

  @override
  Widget build(BuildContext context) {
    return BlocProvider<VoiceFormCubit>.value(
      value: widget.cubit,
      child: BlocConsumer<VoiceFormCubit, VoiceFormState>(
        listener: (BuildContext context, VoiceFormState state) {
          if (state is VoiceFormReview) {
            widget.onReview?.call(state.answers); // back-compat
            // A failed correction stays on review and speaks its worker-safe
            // reason (#700); a successful one that rebuilt a built profile
            // shows a calm notice. Both are transient, never a block.
            final String? err = state.correctionError;
            if (err != null) {
              _showSnack(context, err);
            } else if (state.profileRebuildRequired) {
              _showSnack(context, _kRebuildNotice);
            }
          }
          if (state is VoiceFormComplete) widget.onComplete?.call();
        },
        builder: (BuildContext context, VoiceFormState state) {
          if (state is VoiceFormReview) {
            // The review screen IS the whole screen (its own app bar + submit),
            // reachable only after the engine is done. The ⟲ affordance is
            // finally wired here (#700): onCorrect routes chips/voice/typing
            // through the cubit.
            return VoiceReviewScreen(
              rows: state.rows,
              onSubmit: widget.cubit.submitReviewed,
              onCorrect: (String questionId, CorrectionMethod method) =>
                  _drive(context, questionId, method),
            );
          }
          return BbScaffold(
            appBar: const BbAppBar(title: _kTitle),
            body: _body(context, state),
          );
        },
      ),
    );
  }

  /// The worker tapped ⟲ on [questionId] and chose [method]: collect the matching
  /// [VoiceAnswer] and route it through [VoiceFormCubit.correctAnswer] (#700). The
  /// row is looked up by its STABLE id, never a list position — a refresh under
  /// the open sheet must not re-target the correction.
  Future<void> _drive(
      BuildContext context, String questionId, CorrectionMethod method) async {
    final VoiceFormState state = widget.cubit.state;
    if (state is! VoiceFormReview) return;
    VoiceReviewRow? found;
    for (final VoiceReviewRow r in state.rows) {
      if (r.questionId == questionId) {
        found = r;
        break;
      }
    }
    final VoiceReviewRow? row = found;
    if (row == null) return;

    // The picker is opened SYNCHRONOUSLY here (context is used before any await),
    // then its Future is awaited — so no BuildContext crosses an async gap.
    final Future<VoiceAnswer?> collecting;
    switch (method) {
      case CorrectionMethod.chips:
        collecting = _collectChips(context, row);
      case CorrectionMethod.typing:
        collecting = _collectTyping(context);
      case CorrectionMethod.voice:
        collecting = _collectVoice(context);
    }
    final VoiceAnswer? answer = await collecting;
    if (answer == null) return; // dismissed / empty — nothing to correct
    await widget.cubit.correctAnswer(answer, questionKey: questionId);
  }

  /// Chips → a picker built from the row's own options (no second fetch): the
  /// SAME [VoiceChoiceChips] the asking screen uses, so single/multi/boolean
  /// behave identically. Boolean's Haan/Nahi are client-rendered.
  Future<VoiceAnswer?> _collectChips(BuildContext context, VoiceReviewRow row) {
    final VoiceQuestion synthetic = VoiceQuestion(
      id: row.questionId,
      prompt: row.fieldLabel,
      kind: row.kind,
      options: row.options,
    );
    return showModalBottomSheet<VoiceAnswer>(
      context: context,
      builder: (BuildContext sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.s4),
          child: VoiceChoiceChips(
            question: synthetic,
            onChips: (List<String> keys) =>
                Navigator.of(sheetContext).pop(VoiceAnswer.chips(keys)),
            onBoolean: (bool value) =>
                Navigator.of(sheetContext).pop(VoiceAnswer.boolean(value)),
          ),
        ),
      ),
    );
  }

  /// Typing — the last resort for a worker who may not type well, so it is the
  /// last option offered. A blank entry is not a correction.
  Future<VoiceAnswer?> _collectTyping(BuildContext context) async {
    final String? text = await showDialog<String>(
      context: context,
      builder: (_) => const _TypingCorrectionDialog(),
    );
    final String trimmed = (text ?? '').trim();
    if (trimmed.isEmpty) return null;
    return VoiceAnswer.text(trimmed);
  }

  /// Voice — a one-shot capture through the cubit's recorder, then the SAME
  /// first-answer upload path. A registration failure stays on review with a
  /// worker-safe line rather than dead-ending.
  Future<VoiceAnswer?> _collectVoice(BuildContext context) async {
    final RecordedClip? clip = await showDialog<RecordedClip>(
      context: context,
      barrierDismissible: false,
      builder: (_) => _VoiceCorrectionDialog(cubit: widget.cubit),
    );
    if (clip == null) return null;
    try {
      final String voiceNoteId = await widget.cubit.registerCorrectionClip(clip);
      return VoiceAnswer.spoken(voiceNoteId);
    } on Failure catch (f) {
      if (context.mounted) _showSnack(context, f.message);
      return null;
    } catch (e) {
      if (context.mounted) _showSnack(context, mapError(e).message);
      return null;
    }
  }

  void _showSnack(BuildContext context, String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  Widget _body(BuildContext context, VoiceFormState state) {
    return switch (state) {
      VoiceFormIdle() || VoiceFormPreparing() =>
        const BbStatusView.loading(caption: _kPreparing),
      VoiceFormSubmitting() =>
        const BbStatusView.loading(caption: _kSubmitting),
      VoiceFormReview() || VoiceFormComplete() =>
        const BbStatusView.loading(caption: _kSubmitting),
      VoiceFormInterrupted() => _AskingView.interrupted(state),
      VoiceFormError(:final Failure failure) => BbStatusView(
          icon: Icons.error_outline,
          iconColor: AppColors.danger,
          title: _kTitle,
          subtitle: failure.message,
          action: BbButton(
            label: _kReRecord,
            variant: BbButtonVariant.outline,
            onPressed: widget.onExit,
          ),
        ),
      VoiceFormAsking() => _AskingView(state: state, cubit: widget.cubit),
    };
  }
}

/// The active-question layout. Its own widget so the ⓘ expand state is local.
class _AskingView extends StatelessWidget {
  const _AskingView({required this.state, required this.cubit});

  _AskingView.interrupted(VoiceFormInterrupted s)
      : state = VoiceFormAsking(
          question: s.question,
          index: s.index,
          total: s.total,
          micPhase: MicPhase.holding,
        ),
        cubit = null;

  final VoiceFormAsking state;
  final VoiceFormCubit? cubit;

  bool get _canAnswer =>
      state.micPhase == MicPhase.listening ||
      state.micPhase == MicPhase.holding;

  @override
  Widget build(BuildContext context) {
    final VoiceQuestion q = state.question;
    final VoiceFormCubit? c = cubit;
    return SingleChildScrollView(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          VoiceDotRail(filled: state.index, total: state.total),
          const SizedBox(height: AppSpacing.s6),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: Text(q.prompt, style: AppTypography.display(size: 22)),
              ),
              // ≥48px touch target (owner ruling on the whole screen).
              IconButton(
                iconSize: 26,
                constraints:
                    const BoxConstraints(minWidth: 48, minHeight: 48),
                tooltip: _kReplayLabel,
                onPressed: c?.replay,
                icon: const Icon(Icons.volume_up_outlined,
                    color: AppColors.blue),
              ),
            ],
          ),
          if (q.whyText != null) ...<Widget>[
            const SizedBox(height: AppSpacing.s2),
            _WhyText(whyText: q.whyText!),
          ],
          if (q.isChoice && c != null) ...<Widget>[
            const SizedBox(height: AppSpacing.s5),
            VoiceChoiceChips(
              question: q,
              onChips: c.answerByChips,
              onBoolean: c.answerByBoolean,
            ),
          ],
          const SizedBox(height: AppSpacing.s7),
          _micRow(c),
          const SizedBox(height: AppSpacing.s6),
          if (c != null) _actions(c),
          const SizedBox(height: AppSpacing.s4),
          Text(
            _kMicFootnote,
            style: AppTypography.body(size: 13, color: AppColors.textMuted),
          ),
        ],
      ),
    );
  }

  Widget _micRow(VoiceFormCubit? c) {
    final bool listening = state.micPhase == MicPhase.listening;
    return Row(
      children: <Widget>[
        Icon(Icons.circle,
            size: 10, color: listening ? AppColors.danger : AppColors.ink300),
        const SizedBox(width: AppSpacing.s2),
        Text(
          listening ? _kListening : _kNotListening,
          style: AppTypography.body(
              weight: FontWeight.w600,
              color: listening ? AppColors.textPrimary : AppColors.textMuted),
        ),
        const SizedBox(width: AppSpacing.s4),
        if (c != null)
          VoiceLevelMeter(levels: c.micLevels, active: listening),
      ],
    );
  }

  Widget _actions(VoiceFormCubit c) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: BbButton(
                label: _kNext,
                onPressed: _canAnswer ? c.answerBySpeaking : null,
              ),
            ),
            const SizedBox(width: AppSpacing.s3),
            Expanded(
              child: BbButton(
                label: _kReRecord,
                variant: BbButtonVariant.outline,
                onPressed: _canAnswer ? c.reRecord : null,
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.s3),
        BbButton(
          label: _kDontKnow,
          variant: BbButtonVariant.ghost,
          onPressed: _canAnswer ? () => c.answerByText(_kDontKnowValue) : null,
        ),
      ],
    );
  }
}

/// The ⓘ "why are we asking" affordance — collapsed by default, expands inline.
class _WhyText extends StatefulWidget {
  const _WhyText({required this.whyText});
  final String whyText;

  @override
  State<_WhyText> createState() => _WhyTextState();
}

class _WhyTextState extends State<_WhyText> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        InkWell(
          onTap: () => setState(() => _open = !_open),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.s2),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                const Icon(Icons.info_outline,
                    size: 18, color: AppColors.blue),
                const SizedBox(width: AppSpacing.s2),
                Text(_kWhyLabel,
                    style: AppTypography.body(
                        size: 14, color: AppColors.blue)),
                Icon(_open ? Icons.expand_less : Icons.expand_more,
                    size: 18, color: AppColors.blue),
              ],
            ),
          ),
        ),
        if (_open)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.s2),
            child: Text(widget.whyText,
                style:
                    AppTypography.body(size: 14, color: AppColors.textSecondary)),
          ),
      ],
    );
  }
}

/// A one-field typing correction (#700). A blank entry is discarded by the host,
/// so both buttons simply pop — the guard lives in `_collectTyping`.
class _TypingCorrectionDialog extends StatefulWidget {
  const _TypingCorrectionDialog();

  @override
  State<_TypingCorrectionDialog> createState() =>
      _TypingCorrectionDialogState();
}

class _TypingCorrectionDialogState extends State<_TypingCorrectionDialog> {
  final TextEditingController _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(_kTypeTitle, style: AppTypography.display(size: 18)),
      content: TextField(
        controller: _controller,
        autofocus: true,
        decoration: const InputDecoration(hintText: _kTypeHint),
        onSubmitted: (String value) => Navigator.of(context).pop(value),
      ),
      actions: <Widget>[
        BbButton(
          label: _kCancel,
          variant: BbButtonVariant.ghost,
          onPressed: () => Navigator.of(context).pop(),
        ),
        BbButton(
          label: _kSave,
          onPressed: () => Navigator.of(context).pop(_controller.text),
        ),
      ],
    );
  }
}

/// A one-shot voice correction (#700). Opens the mic on show through the cubit's
/// recorder (the interview is done, so it is idle) and returns the [RecordedClip]
/// on "Ho gaya"; cancel still stops so the mic is released. The host uploads it.
class _VoiceCorrectionDialog extends StatefulWidget {
  const _VoiceCorrectionDialog({required this.cubit});

  final VoiceFormCubit cubit;

  @override
  State<_VoiceCorrectionDialog> createState() => _VoiceCorrectionDialogState();
}

class _VoiceCorrectionDialogState extends State<_VoiceCorrectionDialog> {
  late final Future<void> _started;
  bool _finishing = false;

  @override
  void initState() {
    super.initState();
    _started = widget.cubit.startCorrectionCapture();
  }

  Future<void> _finish({required bool keep}) async {
    if (_finishing) return;
    _finishing = true;
    RecordedClip? clip;
    try {
      await _started; // never stop before start() has actually opened the mic
      clip = await widget.cubit.stopCorrectionCapture();
    } catch (_) {
      clip = null; // a failed capture ends the dialog cleanly, no clip
    }
    if (!mounted) return;
    Navigator.of(context).pop(keep ? clip : null);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(_kSpeakTitle, style: AppTypography.display(size: 18)),
      content: const Icon(Icons.mic, size: 48, color: AppColors.danger),
      actions: <Widget>[
        BbButton(
          label: _kCancel,
          variant: BbButtonVariant.ghost,
          onPressed: () => _finish(keep: false),
        ),
        BbButton(
          label: _kStopRecording,
          onPressed: () => _finish(keep: true),
        ),
      ],
    );
  }
}
