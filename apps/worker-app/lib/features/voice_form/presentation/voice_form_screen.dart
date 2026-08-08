import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/error/failure.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../domain/voice_form_models.dart';
import 'cubit/voice_form_cubit.dart';
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

/// The one-question-at-a-time voice-form screen (#629): dot-rail progress (no
/// numerals, can only grow), the question with a replay speaker and an inline
/// "why", chips for a choice question, a safety-critical mic-state row driven by
/// real amplitude, and the answer actions.
///
/// Route-agnostic: it is handed a built [VoiceFormCubit] (the session gateway is
/// still B6-frozen, so there is no locator binding yet) and reports terminal
/// transitions through callbacks.
class VoiceFormScreen extends StatelessWidget {
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
  Widget build(BuildContext context) {
    return BlocProvider<VoiceFormCubit>.value(
      value: cubit,
      child: BbScaffold(
        appBar: const BbAppBar(title: _kTitle),
        body: BlocConsumer<VoiceFormCubit, VoiceFormState>(
          listener: (BuildContext context, VoiceFormState state) {
            if (state is VoiceFormReview) onReview?.call(state.answers);
            if (state is VoiceFormComplete) onComplete?.call();
          },
          builder: (BuildContext context, VoiceFormState state) =>
              _body(context, state),
        ),
      ),
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
            onPressed: onExit,
          ),
        ),
      VoiceFormAsking() => _AskingView(state: state, cubit: cubit),
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
