import 'package:flutter/material.dart';

import '../../../../core/theme/app_spacing.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../domain/voice_form_models.dart';

// Persona-clean chip copy (scanned by persona_neutrality_test.dart).
const String kVoiceBooleanYes = 'Haan';
const String kVoiceBooleanNo = 'Nahi';
const String kVoiceMultiSubmit = 'Aage badhein';

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
  });

  final VoiceQuestion question;

  /// Submit selected option [keys] (single = one, multi = N).
  final ValueChanged<List<String>> onChips;

  /// Submit a boolean answer (Haan = true / Nahi = false).
  final ValueChanged<bool> onBoolean;

  @override
  State<VoiceChoiceChips> createState() => _VoiceChoiceChipsState();
}

class _VoiceChoiceChipsState extends State<VoiceChoiceChips> {
  /// Selected keys for a multi-select question, in tap order.
  final List<String> _selected = <String>[];

  /// CLEAR ON QUESTION CHANGE. Flutter reuses this State when the parent
  /// rebuilds the widget at the same position with a new `question` — only
  /// `didUpdateWidget` fires, never `initState`. Without this, Q(n)'s selected
  /// keys survive into Q(n+1) and a worker who taps one new option submits it
  /// mixed with the previous question's answer, silently, against the wrong
  /// question. Not left to the caller to remember to pass a ValueKey.
  @override
  void didUpdateWidget(covariant VoiceChoiceChips oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.question.id != widget.question.id) _selected.clear();
  }

  void _toggle(String key) {
    setState(() {
      if (_selected.contains(key)) {
        _selected.remove(key);
      } else {
        _selected.add(key);
      }
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
          label: kVoiceMultiSubmit,
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
