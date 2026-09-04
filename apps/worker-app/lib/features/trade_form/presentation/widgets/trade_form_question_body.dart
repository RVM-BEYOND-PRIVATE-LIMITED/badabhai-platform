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
    required this.isLastStep,
  });

  final TradeFormQuestionStep step;

  /// False while a submit is already in flight — every affordance below is
  /// disabled rather than allowing a second concurrent answer.
  final bool enabled;

  final ValueChanged<List<String>> onSubmitChips;
  final ValueChanged<bool> onSubmitBoolean;
  final ValueChanged<String> onSubmitText;
  final VoidCallback onDecline;

  /// #1384 item 3 — `TradeFormState.isLastStep`, threaded down so whichever
  /// sub-widget renders this question's actual submit BUTTON (a multi-select
  /// or open-answer question; single-select/boolean submit via a [BbChip]
  /// tap with no button surface to style — see [VoiceChoiceChips.isFinalStep]'s
  /// own doc) can show the green/[kVoiceFinalSubmit] treatment ONLY when
  /// this question is truly the walk's last step — #1376 made that a
  /// reliable signal (see `TradeFormCubit.answerQuestion`'s own doc on why).
  final bool isLastStep;

  @override
  State<TradeFormQuestionBody> createState() => _TradeFormQuestionBodyState();
}

class _TradeFormQuestionBodyState extends State<TradeFormQuestionBody> {
  @override
  Widget build(BuildContext context) {
    final VoiceQuestion q = widget.step.question;
    // A question whose OWN options already carry a none-of-above chip
    // (#1382's `isNoneOfAbove`) offers that identical "nothing here
    // applies" declaration inside the grid already — the standalone button
    // below would be a second, redundant way to say the same thing on the
    // same screen. Only ~7 of 17 CNC-turning questions carry one today (the
    // rest have no options at all, or an options set with no none-of-above
    // entry), so this check — NOT a blanket removal — is what keeps every
    // other question's only decline path intact (#1341's own "never a
    // silent skip" guarantee).
    final bool hasNoneOfAboveOption =
        q.options.any((VoiceChoice o) => o.isNoneOfAbove);
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
        if (!hasNoneOfAboveOption) ...<Widget>[
          const SizedBox(height: AppSpacing.s3),
          BbButton(
            label: _kDeclineLabel,
            variant: BbButtonVariant.ghost,
            onPressed: widget.enabled ? widget.onDecline : null,
          ),
        ],
      ],
    );
  }

  Widget _body(VoiceQuestion q) {
    if (q.kind == VoiceQuestionKind.open) {
      return _OpenAnswerField(
        key: ValueKey<String>('${q.id}-text'),
        // #1382 — a saved `text` answer pre-fills the field so a worker who
        // navigates back to an answered question does not see it blank.
        // Boolean/number answers never reach this branch (`answer_type` maps
        // them to `boolean`/never ships `number` — see `VoiceQuestionKind`'s
        // `_kind` mapping), so `text` is the only field this widget renders.
        initialText: widget.step.answer?.text,
        onSubmit: widget.onSubmitText,
        isLastStep: widget.isLastStep,
      );
    }
    if (widget.step.searchable) {
      return _SearchableChoiceBody(
        key: ValueKey<String>('${q.id}-searchable'),
        step: widget.step,
        onSubmitChips: widget.onSubmitChips,
        isLastStep: widget.isLastStep,
      );
    }
    return VoiceChoiceChips(
      key: ValueKey<String>('${q.id}-chips'),
      question: q,
      // #1382/#1384 — a saved multi-select answer pre-ticks its chips on
      // mount. Harmless for boolean/single-select, which never read this
      // list. See `_seedOptionKeys` for the declined/none-of-above case.
      initialSelected: _seedOptionKeys(widget.step.answer, q.options),
      onChips: widget.onSubmitChips,
      onBoolean: widget.onSubmitBoolean,
      // #1384 item 3 — only the MULTI-select submit button reads this (see
      // `VoiceChoiceChips.isFinalStep`'s own doc); harmless to pass on a
      // single-select/boolean question, which never renders that button.
      isFinalStep: widget.isLastStep,
    );
  }
}

/// #1384 item 2 — the pre-fill seed for a saved answer's option keys.
///
/// A saved answer with [TradeFormSavedAnswer.isDeclined] is a REAL, SETTLED
/// choice ("nothing here applies"), not silence — see the doc on
/// [TradeFormAnswerStatus.declined] (`trade_form_models.dart`): it covers
/// BOTH the explicit "Pata nahi" decline AND a multi-select where the worker
/// tapped the none-of-above chip, which the server ALSO records as a
/// declined save with an empty `option_keys`. Re-seeding blank in that case
/// would render the none-of-above chip unselected — indistinguishable from a
/// genuinely untouched question. So: when [answer] is declined AND the
/// question offers a none-of-above option, seed THAT option's key. A
/// question with no none-of-above option (or a genuinely-answered save) has
/// nothing special to do and falls back to the raw saved [optionKeys].
List<String> _seedOptionKeys(
  TradeFormSavedAnswer? answer,
  List<VoiceChoice> options,
) {
  if (answer == null) return const <String>[];
  if (!answer.isDeclined) return answer.optionKeys;
  for (final VoiceChoice option in options) {
    if (option.isNoneOfAbove) return <String>[option.key];
  }
  return answer.optionKeys;
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
    required this.isLastStep,
  });

  final TradeFormQuestionStep step;
  final ValueChanged<List<String>> onSubmitChips;

  /// #1384 item 3 — see `TradeFormQuestionBody.isLastStep`'s doc; only the
  /// MULTI-select submit button below reads this (a single-select tap
  /// submits immediately via [_onChanged], no button to style).
  final bool isLastStep;

  @override
  State<_SearchableChoiceBody> createState() => _SearchableChoiceBodyState();
}

class _SearchableChoiceBodyState extends State<_SearchableChoiceBody> {
  List<String> _selected = const <String>[];

  @override
  void initState() {
    super.initState();
    // #1382/#1384 — a saved multi-select answer pre-ticks its chips on
    // mount, the same guarantee VoiceChoiceChips gives the non-searchable
    // path (see `_seedOptionKeys` for the declined/none-of-above case). This
    // widget is rebuilt fresh (a new `ValueKey` per question — see the
    // parent's `_body`), so `initState` runs on every question change; no
    // `didUpdateWidget` re-seed is needed the way `VoiceChoiceChips` needs
    // one for its own, key-less, voice_form call site.
    _selected = _seedOptionKeys(widget.step.answer, widget.step.question.options);
  }

  void _onChanged(List<String> next) {
    final VoiceQuestion q = widget.step.question;
    if (!q.isMultiSelect) {
      // Single-select via a searchable list: one tap settles the question —
      // submit immediately with only the LAST tapped key, exactly like
      // VoiceChoiceChips' own single-select tap-to-submit.
      if (next.isNotEmpty) widget.onSubmitChips(<String>[next.last]);
      return;
    }
    if (next.length <= _selected.length) {
      // A deselect (or no-op) — never needs the none-of-above exclusion
      // rule (see `applyNoneOfAboveRule`'s own doc), so `next` is accepted
      // as-is.
      setState(() => _selected = next);
      return;
    }
    // A select — BbSearchableMultiSelect always APPENDS a new pick, so the
    // just-tapped key is the last element of `next` (see its own doc on
    // "Selected chips never disappear" / tap-order accumulation).
    setState(() => _selected = applyNoneOfAboveRule(
          current: _selected,
          key: next.last,
          options: q.options,
        ));
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
            // #1384 item 3 — see `VoiceChoiceChips`'s own identical
            // treatment; this is the searchable-question equivalent of that
            // same button.
            label: widget.isLastStep ? kVoiceFinalSubmit : kVoiceMultiSubmit,
            variant: widget.isLastStep
                ? BbButtonVariant.success
                : BbButtonVariant.primary,
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
  const _OpenAnswerField({
    super.key,
    required this.onSubmit,
    this.initialText,
    required this.isLastStep,
  });
  final ValueChanged<String> onSubmit;

  /// A saved `text` answer to pre-fill (#1382) — null/omitted starts empty,
  /// today's behaviour.
  final String? initialText;

  /// #1384 item 3 — see `TradeFormQuestionBody.isLastStep`'s doc.
  final bool isLastStep;

  @override
  State<_OpenAnswerField> createState() => _OpenAnswerFieldState();
}

class _OpenAnswerFieldState extends State<_OpenAnswerField> {
  // Same seed-from-widget-on-construction shape `_EmployerCardState` already
  // uses for its own text controllers (`trade_form_employment_page.dart`).
  late final TextEditingController _controller =
      TextEditingController(text: widget.initialText ?? '');

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
              // #1384 item 3 — same green/final treatment as the two chip
              // submit buttons, for the open-answer question type.
              label: widget.isLastStep ? kVoiceFinalSubmit : _kTextSubmit,
              variant: widget.isLastStep
                  ? BbButtonVariant.success
                  : BbButtonVariant.primary,
              block: true,
              onPressed: value.text.trim().isEmpty ? null : _submit,
            );
          },
        ),
      ],
    );
  }
}
