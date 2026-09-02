import 'package:flutter/material.dart';

import '../../../../core/theme/app_spacing.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../domain/voice_form_models.dart';

// Persona-clean chip copy (scanned by persona_neutrality_test.dart).
const String kVoiceBooleanYes = 'Haan';
const String kVoiceBooleanNo = 'Nahi';
const String kVoiceMultiSubmit = 'Aage badhein';

/// #1384 item 3 — the copy for the ONE true final-submit button of a walk
/// (trade form or, if ever wired, the voice form), when it lands on a
/// multi-select question rather than a marker screen. Reserved for a button
/// ALSO styled [BbButtonVariant.success] — never shown alongside
/// [kVoiceMultiSubmit]'s ordinary primary/haldi styling.
const String kVoiceFinalSubmit = 'Submit karein';

/// The "none of the above" tap rule (#1382), shared by every multi-select
/// selection surface that renders [VoiceChoice.isNoneOfAbove] options —
/// today [VoiceChoiceChips]' own `_multi` and the trade form's searchable
/// path (`_SearchableChoiceBody`, which owns its selection outside this
/// widget but applies the identical rule).
///
/// [current] is the selection BEFORE this tap; [key] is the option key that
/// was just tapped. Toggle-off is untouched — deselecting a pick can only
/// shrink the selection, never create a contradiction, so it is returned
/// unchanged. A NEW selection of a none-of-above option replaces the whole
/// selection with just that key; a new selection of anything else drops any
/// previously-selected none-of-above key(s) first. [options] is the
/// question's full option list, used only to look up which keys are
/// none-of-above.
List<String> applyNoneOfAboveRule({
  required List<String> current,
  required String key,
  required List<VoiceChoice> options,
}) {
  if (current.contains(key)) {
    return List<String>.of(current)..remove(key);
  }
  final bool tappedIsNoneOfAbove = options
      .where((VoiceChoice c) => c.key == key)
      .any((VoiceChoice c) => c.isNoneOfAbove);
  if (tappedIsNoneOfAbove) return <String>[key];
  final Set<String> noneOfAboveKeys = options
      .where((VoiceChoice c) => c.isNoneOfAbove)
      .map((VoiceChoice c) => c.key)
      .toSet();
  return <String>[
    ...current.where((String k) => !noneOfAboveKeys.contains(k)),
    key,
  ];
}

/// Chips for a choice question (#630). 85% of the pack is a choice question and
/// the capture layer has no fuzzy speech→option_key path, so chips are how a
/// worker's answer becomes an `option_key` at all.
///
/// Renders by kind:
///  - **boolean** → fixed [kVoiceBooleanYes] / [kVoiceBooleanNo] (the pack's
///    boolean items carry zero options, so the client owns these), submitted via
///    [onBoolean].
///  - **single-select** → one tap submits `[key]` via [onChips].
///  - **multi-select** → taps accumulate; a submit button sends the N selected
///    keys via [onChips].
///
/// Submits **option keys, never label text**. The mic stays armed alongside
/// (this is only the tap path) — a worker who would rather speak still can.
class VoiceChoiceChips extends StatefulWidget {
  const VoiceChoiceChips({
    super.key,
    required this.question,
    required this.onChips,
    required this.onBoolean,
    this.initialSelected,
    this.isFinalStep = false,
  });

  final VoiceQuestion question;

  /// Submit selected option [keys] (single = one, multi = N).
  final ValueChanged<List<String>> onChips;

  /// Submit a boolean answer (Haan = true / Nahi = false).
  final ValueChanged<bool> onBoolean;

  /// Pre-tick these keys on mount (#1382) — a saved multi-select answer, so
  /// a worker who navigates back to an already-answered question sees it
  /// filled in rather than blank. NULL/OMITTED means "start empty", today's
  /// behaviour for every existing caller (voice_form never had a saved
  /// answer to seed from).
  final List<String>? initialSelected;

  /// #1384 item 3 — true when THIS question is the true final step of the
  /// whole walk (only meaningful for the multi-select submit button; a
  /// single-select/boolean tap submits immediately via a [BbChip], which has
  /// no "final" surface to style). DEFAULT FALSE, unchanged everywhere else
  /// — [voice_form_screen.dart]'s two call sites never pass this (that
  /// screen is unwired dark code today, #1321, with no last-step concept of
  /// its own). Styles [BbButtonVariant.success] with [kVoiceFinalSubmit]'s
  /// copy instead of the ordinary [kVoiceMultiSubmit] "Aage badhein".
  final bool isFinalStep;

  @override
  State<VoiceChoiceChips> createState() => _VoiceChoiceChipsState();
}

class _VoiceChoiceChipsState extends State<VoiceChoiceChips> {
  /// Selected keys for a multi-select question, in tap order.
  final List<String> _selected = <String>[];

  @override
  void initState() {
    super.initState();
    _seed();
  }

  void _seed() {
    _selected
      ..clear()
      ..addAll(widget.initialSelected ?? const <String>[]);
  }

  /// CLEAR (OR RE-SEED) ON QUESTION CHANGE. Flutter reuses this State when
  /// the parent rebuilds the widget at the same position with a new
  /// `question` — only `didUpdateWidget` fires, never `initState`. Without
  /// this, Q(n)'s selected keys survive into Q(n+1) and a worker who taps
  /// one new option submits it mixed with the previous question's answer,
  /// silently, against the wrong question. Not left to the caller to
  /// remember to pass a ValueKey.
  @override
  void didUpdateWidget(covariant VoiceChoiceChips oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.question.id != widget.question.id) _seed();
  }

  void _toggle(String key) {
    // Computed from `_selected` BEFORE it is touched — a cascade that both
    // read and mutated the same list in one statement would hand
    // `applyNoneOfAboveRule` an already-cleared list.
    final List<String> next = applyNoneOfAboveRule(
      current: _selected,
      key: key,
      options: widget.question.options,
    );
    setState(() {
      _selected
        ..clear()
        ..addAll(next);
    });
  }

  @override
  Widget build(BuildContext context) {
    final VoiceQuestion q = widget.question;
    if (q.isBoolean) return _boolean();
    if (q.isMultiSelect) return _multi(q);
    return _single(q);
  }

  Widget _boolean() {
    return Wrap(
      spacing: AppSpacing.s2,
      runSpacing: AppSpacing.s2,
      children: <Widget>[
        BbChip(label: kVoiceBooleanYes, onTap: () => widget.onBoolean(true)),
        BbChip(label: kVoiceBooleanNo, onTap: () => widget.onBoolean(false)),
      ],
    );
  }

  Widget _single(VoiceQuestion q) {
    return Wrap(
      spacing: AppSpacing.s2,
      runSpacing: AppSpacing.s2,
      children: <Widget>[
        for (final VoiceChoice c in q.options)
          BbChip(
            label: c.label,
            onTap: () => widget.onChips(<String>[c.key]),
          ),
      ],
    );
  }

  Widget _multi(VoiceQuestion q) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Wrap(
          spacing: AppSpacing.s2,
          runSpacing: AppSpacing.s2,
          children: <Widget>[
            for (final VoiceChoice c in q.options)
              BbChip(
                label: c.label,
                selected: _selected.contains(c.key),
                onTap: () => _toggle(c.key),
              ),
          ],
        ),
        const SizedBox(height: AppSpacing.s4),
        BbButton(
          // #1384 item 3 — the ONE true final-submit button of the whole
          // walk is green with distinct copy; every other multi-select
          // submit (including on a non-final question) stays the ordinary
          // primary/haldi "Aage badhein".
          label: widget.isFinalStep ? kVoiceFinalSubmit : kVoiceMultiSubmit,
          variant: widget.isFinalStep
              ? BbButtonVariant.success
              : BbButtonVariant.primary,
          block: true,
          // Disabled until at least one option is chosen — a zero-key submit is
          // never a valid multi-select answer.
          onPressed: _selected.isEmpty
              ? null
              : () => widget.onChips(List<String>.of(_selected)),
        ),
      ],
    );
  }
}
