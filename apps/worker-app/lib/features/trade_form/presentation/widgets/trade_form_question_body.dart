import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_searchable_multi_select.dart';
import '../../../voice_form/domain/voice_form_models.dart';
import '../../../voice_form/presentation/widgets/voice_choice_chips.dart';
import '../../domain/trade_form_models.dart';
import 'trade_form_text_field.dart';

// Copy. aap-form, no `!`, safe verbs only. Scanned by
// persona_neutrality_test.dart.
const String _kWhyLabel = 'Yeh kyun poochh rahe hain';
const String _kTextSubmit = 'Aage badhein';
const String _kTextHint = 'Yahan likhein';
const String _kDeclineLabel = 'Pata nahi';

/// Renders ONE `type: "question"` screen and reports the worker's answer.
///
/// - **not searchable** → [VoiceChoiceChips] directly (byte-identical
///   question shape, #1341) — a single-select/boolean tap submits
///   immediately; a multi-select accumulates behind its own "Aage badhein".
/// - **searchable** (`ui.searchable`, server-computed from option count) →
///   [BbSearchableMultiSelect]. For a genuinely multi-select question, picks
///   accumulate behind an explicit submit button (same shape as the
///   non-searchable multi path). For a single-select question that happens
///   to cross the search threshold, one tap settles it — the LAST tapped key
///   is submitted immediately, mirroring `VoiceChoiceChips`' own
///   one-tap-per-single-select rule, rather than adding a second selection
///   primitive.
/// - **open** (`text`/`number` `answer_type`) → neither chip widget applies
///   (no options ship with these questions); a plain text field with its own
///   submit button, enabled once non-empty (matching the server's
///   `text.trim().min(1)` rule).
///
/// EVERY branch also renders an explicit decline affordance — "nothing here
/// applies" is a real, settled answer (`{kind: declined}`), never a silent
/// skip, per #1341.
class TradeFormQuestionBody extends StatefulWidget {
  const TradeFormQuestionBody({
    super.key,
    required this.step,
    required this.enabled,
    required this.onSubmitChips,
    required this.onSubmitBoolean,
    required this.onSubmitText,
    required this.onDecline,
  });

  final TradeFormQuestionStep step;

  /// False while a submit is already in flight — every affordance below is
  /// disabled rather than allowing a second concurrent answer.
  final bool enabled;

  final ValueChanged<List<String>> onSubmitChips;
  final ValueChanged<bool> onSubmitBoolean;
  final ValueChanged<String> onSubmitText;
  final VoidCallback onDecline;

  @override
  State<TradeFormQuestionBody> createState() => _TradeFormQuestionBodyState();
}

class _TradeFormQuestionBodyState extends State<TradeFormQuestionBody> {
  @override
  Widget build(BuildContext context) {
    final VoiceQuestion q = widget.step.question;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(q.prompt, style: AppTypography.display(size: AppTypography.sizeLg)),
        if (q.whyText != null && q.whyText!.trim().isNotEmpty) ...<Widget>[
          const SizedBox(height: AppSpacing.s2),
          _WhyText(text: q.whyText!),
        ],
        const SizedBox(height: AppSpacing.s4),
        IgnorePointer(
          ignoring: !widget.enabled,
          child: Opacity(
            opacity: widget.enabled ? 1 : 0.5,
            child: _body(q),
          ),
        ),
        const SizedBox(height: AppSpacing.s3),
        BbButton(
          label: _kDeclineLabel,
          variant: BbButtonVariant.ghost,
          onPressed: widget.enabled ? widget.onDecline : null,
        ),
      ],
    );
  }

  Widget _body(VoiceQuestion q) {
    if (q.kind == VoiceQuestionKind.open) {
      return _OpenAnswerField(
        key: ValueKey<String>('${q.id}-text'),
        onSubmit: widget.onSubmitText,
      );
    }
    if (widget.step.searchable) {
      return _SearchableChoiceBody(
        key: ValueKey<String>('${q.id}-searchable'),
        step: widget.step,
        onSubmitChips: widget.onSubmitChips,
      );
    }
    return VoiceChoiceChips(
      key: ValueKey<String>('${q.id}-chips'),
      question: q,
      onChips: widget.onSubmitChips,
      onBoolean: widget.onSubmitBoolean,
    );
  }
}

class _WhyText extends StatelessWidget {
  const _WhyText({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: '$_kWhyLabel: $text',
      child: Text(
        text,
        style:
            AppTypography.body(size: AppTypography.sizeSm, color: AppColors.textMuted),
      ),
    );
  }
}

/// The `ui.searchable == true` branch: [BbSearchableMultiSelect] over the
/// question's options. See the class doc on [TradeFormQuestionBody] for the
/// single- vs multi-select handling.
class _SearchableChoiceBody extends StatefulWidget {
  const _SearchableChoiceBody({
    super.key,
    required this.step,
    required this.onSubmitChips,
  });

  final TradeFormQuestionStep step;
  final ValueChanged<List<String>> onSubmitChips;

  @override
  State<_SearchableChoiceBody> createState() => _SearchableChoiceBodyState();
}

class _SearchableChoiceBodyState extends State<_SearchableChoiceBody> {
  List<String> _selected = const <String>[];

  void _onChanged(List<String> next) {
    if (!widget.step.question.isMultiSelect) {
      // Single-select via a searchable list: one tap settles the question —
      // submit immediately with only the LAST tapped key, exactly like
      // VoiceChoiceChips' own single-select tap-to-submit.
      if (next.isNotEmpty) widget.onSubmitChips(<String>[next.last]);
      return;
    }
    setState(() => _selected = next);
  }

  @override
  Widget build(BuildContext context) {
    final VoiceQuestion q = widget.step.question;
    final List<BbSelectOption> options = <BbSelectOption>[
      for (final VoiceChoice c in q.options)
        BbSelectOption(key: c.key, label: c.label),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        BbSearchableMultiSelect(
          options: options,
          selectedKeys: _selected,
          onChanged: _onChanged,
          resetKey: q.id,
        ),
        if (q.isMultiSelect) ...<Widget>[
          const SizedBox(height: AppSpacing.s4),
          BbButton(
            label: kVoiceMultiSubmit,
            block: true,
            onPressed: _selected.isEmpty
                ? null
                : () => widget.onSubmitChips(List<String>.of(_selected)),
          ),
        ],
      ],
    );
  }
}

/// The `open` branch (`text`/`number` `answer_type`) — a plain text field;
/// neither chip widget applies since these questions ship no options.
class _OpenAnswerField extends StatefulWidget {
  const _OpenAnswerField({super.key, required this.onSubmit});
  final ValueChanged<String> onSubmit;

  @override
  State<_OpenAnswerField> createState() => _OpenAnswerFieldState();
}

class _OpenAnswerFieldState extends State<_OpenAnswerField> {
  final TextEditingController _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final String value = _controller.text.trim();
    if (value.isEmpty) return;
    widget.onSubmit(value);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        TradeFormTextField(
          controller: _controller,
          hint: _kTextHint,
          maxLines: 3,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => _submit(),
        ),
        const SizedBox(height: AppSpacing.s4),
        ValueListenableBuilder<TextEditingValue>(
          valueListenable: _controller,
          builder: (BuildContext context, TextEditingValue value, _) {
            return BbButton(
              label: _kTextSubmit,
              block: true,
              onPressed: value.text.trim().isEmpty ? null : _submit,
            );
          },
        ),
      ],
    );
  }
}
