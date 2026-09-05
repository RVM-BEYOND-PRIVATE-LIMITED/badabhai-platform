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
///   immediately; a multi-select accumulates behind the pinned submit button
///   below.
/// - **searchable** (`ui.searchable`, server-computed from option count) →
///   [BbSearchableMultiSelect]. For a genuinely multi-select question, picks
///   accumulate behind the same pinned submit button. For a single-select
///   question that happens to cross the search threshold, one tap settles it
///   — the LAST tapped key is submitted immediately, mirroring
///   `VoiceChoiceChips`' own one-tap-per-single-select rule, rather than
///   adding a second selection primitive.
/// - **open** (`text`/`number` `answer_type`) → neither chip widget applies
///   (no options ship with these questions); a plain text field, submit
///   enabled once non-empty (matching the server's `text.trim().min(1)`
///   rule).
///
/// An open-answer or multi-select question has a real "Aage badhein"/"Submit
/// karein" button to press — that button is PINNED at the bottom of the
/// screen (a fixed footer, sibling of the scrollable prompt/options above it)
/// so it never scrolls out of reach on a long question. A single-select/
/// boolean question submits on tap with no button to pin, so it renders no
/// footer at all.
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

  /// #1384 item 3 — `TradeFormState.isLastStep`, threaded down so the pinned
  /// submit footer (a multi-select or open-answer question; single-select/
  /// boolean submits via a [BbChip] tap with no button surface to style — see
  /// [VoiceChoiceChips.isFinalStep]'s own doc) can show the green/
  /// [kVoiceFinalSubmit] treatment ONLY when this question is truly the
  /// walk's last step — #1376 made that a reliable signal (see
  /// `TradeFormCubit.answerQuestion`'s own doc on why).
  final bool isLastStep;

  @override
  State<TradeFormQuestionBody> createState() => _TradeFormQuestionBodyState();
}

class _TradeFormQuestionBodyState extends State<TradeFormQuestionBody> {
  /// The live draft for an OPEN question — mirrors [_OpenAnswerField]'s own
  /// controller text, kept here too so the pinned footer (a SIBLING of the
  /// scrollable body, not a descendant of the field) can gate/act on it.
  String _text = '';

  /// The live draft for a MULTI-select question (chip or searchable) — same
  /// reasoning as [_text].
  List<String> _selected = const <String>[];

  @override
  void initState() {
    super.initState();
    // A fresh mount per question (the parent always supplies a new
    // `ValueKey` — see `trade_form_screen.dart`'s `_stepBody`), so seeding
    // once here from the saved answer is correct and never goes stale.
    final VoiceQuestion q = widget.step.question;
    if (q.kind == VoiceQuestionKind.open) {
      _text = widget.step.answer?.text ?? '';
    } else if (q.isMultiSelect) {
      _selected = _seedOptionKeys(widget.step.answer, q.options);
    }
  }

  bool get _hasSubmitButton {
    final VoiceQuestion q = widget.step.question;
    return q.kind == VoiceQuestionKind.open || q.isMultiSelect;
  }

  bool get _canSubmit => widget.step.question.kind == VoiceQuestionKind.open
      ? _text.trim().isNotEmpty
      : _selected.isNotEmpty;

  void _submit() {
    if (!_canSubmit) return;
    final VoiceQuestion q = widget.step.question;
    if (q.kind == VoiceQuestionKind.open) {
      widget.onSubmitText(_text.trim());
    } else {
      widget.onSubmitChips(List<String>.of(_selected));
    }
  }

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
      children: <Widget>[
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(AppSpacing.gutter,
                AppSpacing.s4, AppSpacing.gutter, AppSpacing.s4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(q.prompt,
                    style: AppTypography.display(size: AppTypography.sizeLg)),
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
            ),
          ),
        ),
        if (_hasSubmitButton) _submitFooter(),
      ],
    );
  }

  /// Pinned at the bottom, OUTSIDE the scroll view above — the button never
  /// scrolls out of reach on a long question. Mirrors `_MarkerBottomBar`'s
  /// container styling (`trade_form_screen.dart`) for visual consistency
  /// with the marker screens' own sticky footer.
  Widget _submitFooter() {
    return Container(
      padding: const EdgeInsets.fromLTRB(
          AppSpacing.gutter, AppSpacing.s3, AppSpacing.gutter, AppSpacing.s4),
      decoration: const BoxDecoration(
        color: AppColors.canvas,
        border: Border(top: BorderSide(color: AppColors.borderSubtle)),
      ),
      child: BbButton(
        // #1384 item 3 — the ONE true final-submit button of the whole walk
        // is green with distinct copy; every other submit (including on a
        // non-final question) is navy, not primary/haldi — haldi is
        // IDENTICAL to a selected BbChip's fill, so this nav button read as
        // just another option.
        label: widget.isLastStep ? kVoiceFinalSubmit : _kTextSubmit,
        variant:
            widget.isLastStep ? BbButtonVariant.success : BbButtonVariant.navy,
        block: true,
        onPressed: (widget.enabled && _canSubmit) ? _submit : null,
      ),
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
        onChanged: (String v) => setState(() => _text = v),
        onSubmitPressed: _submit,
      );
    }
    if (widget.step.searchable) {
      return _SearchableChoiceBody(
        key: ValueKey<String>('${q.id}-searchable'),
        step: widget.step,
        onSubmitChips: widget.onSubmitChips,
        onSelectionChanged: q.isMultiSelect
            ? (List<String> s) => setState(() => _selected = s)
            : null,
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
      // The trade form pins its OWN submit button below (see
      // `_submitFooter`) — VoiceChoiceChips' internal multi-select button
      // would be a redundant second one, so it stays hidden here.
      showSubmitButton: false,
      onMultiSelectionChanged: q.isMultiSelect
          ? (List<String> s) => setState(() => _selected = s)
          : null,
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
/// single- vs multi-select handling. The multi-select submit button lives in
/// the PARENT's pinned footer now — this widget only reports its live
/// selection up via [onSelectionChanged].
class _SearchableChoiceBody extends StatefulWidget {
  const _SearchableChoiceBody({
    super.key,
    required this.step,
    required this.onSubmitChips,
    required this.onSelectionChanged,
  });

  final TradeFormQuestionStep step;

  /// Single-select-via-search submits immediately (see [_onChanged]) — this
  /// is the only path that still calls it directly. Multi-select submits
  /// through the parent's pinned footer instead.
  final ValueChanged<List<String>> onSubmitChips;

  /// Reports the live selection up to [TradeFormQuestionBody] on every
  /// change — null for a single-select question (nothing to report; it
  /// submits immediately and has no button to gate).
  final ValueChanged<List<String>>? onSelectionChanged;

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
      widget.onSelectionChanged?.call(_selected);
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
    widget.onSelectionChanged?.call(_selected);
  }

  @override
  Widget build(BuildContext context) {
    final VoiceQuestion q = widget.step.question;
    final List<BbSelectOption> options = <BbSelectOption>[
      for (final VoiceChoice c in q.options)
        BbSelectOption(key: c.key, label: c.label),
    ];
    return BbSearchableMultiSelect(
      options: options,
      selectedKeys: _selected,
      onChanged: _onChanged,
      resetKey: q.id,
    );
  }
}

/// The `open` branch (`text`/`number` `answer_type`) — a plain text field;
/// neither chip widget applies since these questions ship no options. The
/// submit button lives in the PARENT's pinned footer — this widget only
/// reports its live text up via [onChanged], plus [onSubmitPressed] for the
/// keyboard's own "Done" action.
class _OpenAnswerField extends StatefulWidget {
  const _OpenAnswerField({
    super.key,
    required this.onChanged,
    required this.onSubmitPressed,
    this.initialText,
  });

  /// Reports the live (untrimmed) text up on every keystroke.
  final ValueChanged<String> onChanged;

  /// The keyboard's "Done" action — mirrors tapping the pinned submit button.
  final VoidCallback onSubmitPressed;

  /// A saved `text` answer to pre-fill (#1382) — null/omitted starts empty,
  /// today's behaviour.
  final String? initialText;

  @override
  State<_OpenAnswerField> createState() => _OpenAnswerFieldState();
}

class _OpenAnswerFieldState extends State<_OpenAnswerField> {
  // Same seed-from-widget-on-construction shape `_EmployerCardState` already
  // uses for its own text controllers (`trade_form_employment_page.dart`).
  late final TextEditingController _controller =
      TextEditingController(text: widget.initialText ?? '')
        ..addListener(() => widget.onChanged(_controller.text));

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TradeFormTextField(
      controller: _controller,
      hint: _kTextHint,
      maxLines: 3,
      textInputAction: TextInputAction.done,
      onSubmitted: (_) => widget.onSubmitPressed(),
    );
  }
}
