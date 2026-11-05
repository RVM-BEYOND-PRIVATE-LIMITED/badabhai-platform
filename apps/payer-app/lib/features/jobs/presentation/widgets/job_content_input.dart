import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show TextInputFormatter;

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_motion.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/util/number_input.dart';
import '../../../../core/util/pay_format.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../../../core/widgets/bb_field.dart';
import '../../../../core/widgets/bb_field_error.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_focus_chain.dart';

/// Shared rules + inputs for the WORKER-VISIBLE content of a posting — the
/// description and the benefits / requirements chips the worker's job card
/// renders VERBATIM, and the ₹ pay band + experience window boxes (#2595).
///
/// One copy for all three surfaces that enter it (post, agency edit, company
/// edit) so the caps and the PII screen can never drift apart between them.
/// Every rule here MIRRORS a server rule (`agency.dto.ts`,
/// `common/job-content.schemas.ts`): the server is the authority — this only
/// fails closed EARLIER, with an honest message, instead of letting a whole
/// post 400.
abstract final class JobContentLimits {
  /// `description` — max chars (server: `DESCRIPTION_MAX`).
  static const int descriptionChars = 2000;

  /// `benefits[]` / `requirements[]` — max items per list (server:
  /// `LIST_ITEMS_MAX`).
  static const int listItems = 12;

  /// One benefits/requirements chip — max chars (server: `LIST_ITEM_MAX`).
  static const int listItemChars = 80;

  /// `pay_min` / `pay_max` — the ₹/month ceiling (server: `PAY_MAX_INR`,
  /// ₹1 crore). The pay boxes refuse a digit past it.
  static const int payMaxInr = 10000000;

  /// `min/max_experience_years` — the ceiling (server:
  /// `EXPERIENCE_MAX_YEARS`). The experience boxes refuse a digit past it.
  static const int experienceMaxYears = 60;
}

// Client mirror of the server's `looksLikePii` (packages/validators): an email
// shape, or >=7 consecutive digits once common phone separators are stripped.
// Everything below rides the wire into a PII-screened, worker-visible field, so
// we refuse it AT ENTRY rather than let the server reject the whole write
// (CLAUDE.md §2 — privacy first, fail closed).
//
// The email shape is the LINEAR form (#1924/#1946): ONE character before the
// "@". `[^\s@]+@` is quadratic on a long run with no "@"; matching only the
// character before the "@" changes no verdict for a yes/no `hasMatch`, because a
// local part always ends in one.
final RegExp _emailLike = RegExp(r'[^\s@]@[^\s@]+\.[^\s@]+');
final RegExp _phoneSeparators = RegExp(r'[\s().+-]');
final RegExp _phoneDigitRun = RegExp(r'\d{7,}');

/// True when [s] looks like a phone number or an email address.
bool looksLikePostingPii(String s) =>
    _emailLike.hasMatch(s) ||
    _phoneDigitRun.hasMatch(s.replaceAll(_phoneSeparators, ''));

/// The honest reason a typed description cannot be sent, or null when it is
/// fine. An EMPTY description is fine — it is simply not sent. Mirrors the two
/// server rejections: the char cap and the fail-closed PII screen.
String? postingDescriptionError(String raw) {
  final String text = raw.trim();
  if (text.isEmpty) return null;
  if (text.length > JobContentLimits.descriptionChars) {
    return 'Keep the description under '
        '${JobContentLimits.descriptionChars} characters.';
  }
  if (looksLikePostingPii(text)) {
    return 'Leave phone numbers and email addresses out of the description.';
  }
  return null;
}

/// Why [phrase] cannot become a chip, or null when it can. Mirrors the server's
/// two item rules: the [maxChars] cap and the fail-closed PII screen. [noun]
/// names the list ("skill" / "benefit" / "requirement").
String? postingPhraseError(
  String phrase, {
  required String noun,
  required int maxChars,
}) {
  if (phrase.length > maxChars) {
    return 'Keep a $noun under $maxChars characters.';
  }
  if (looksLikePostingPii(phrase)) {
    return 'Leave phone numbers and email addresses out of a posting.';
  }
  return null;
}

/// Prompt for ONE real phrase for a chip list and return it, or null when the
/// payer cancelled or entered nothing.
///
/// #357: it ASKS for the phrase instead of inserting a placeholder, and it fails
/// closed at entry on the server's own two item rules ([postingPhraseError]) so
/// one bad chip can never 400 the whole write. #2595: a refused phrase is
/// explained INLINE under the box and the dialog stays open with the text, so
/// the payer fixes it instead of retyping it after a toast.
Future<String?> promptForPostingPhrase(
  BuildContext context, {
  required String noun,
  required int maxChars,
  required String title,
  required String hint,
  required Key fieldKey,
}) async {
  final String? entered = await showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    backgroundColor: AppColors.surfaceCard,
    sheetAnimationStyle: AppMotion.sheetStyle(context),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadii.xxl)),
    ),
    builder: (BuildContext _) => _AddPhraseSheet(
      title: title,
      hint: hint,
      fieldKey: fieldKey,
      validate: (String phrase) =>
          postingPhraseError(phrase, noun: noun, maxChars: maxChars),
    ),
  );
  if (entered == null || entered.isEmpty) return null;
  return entered;
}

/// The posting `description` input — a growing multiline [BbField] that shows
/// the honest reason it cannot be sent (over the cap, or contact details the
/// server screens fail-closed) AS THE PAYER TYPES, instead of waiting for a 400.
/// Rebuilt off the controller alone, so typing does not rebuild the whole form.
///
/// [errorText] is the form's own inline error for the box (#2595 — e.g. "Add
/// the description" on a refused submit); the live screen wins when both apply.
class JobDescriptionField extends StatelessWidget {
  const JobDescriptionField({
    super.key,
    required this.controller,
    this.label = 'Description (optional)',
    this.hint = 'What the work is, machines, shift timings…',
    this.errorText,
  });

  final TextEditingController controller;
  final String label;
  final String hint;
  final String? errorText;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: controller,
      builder: (BuildContext _, TextEditingValue value, Widget? __) {
        return BbField(
          label: label,
          controller: controller,
          hint: hint,
          minLines: 3,
          maxLines: 6,
          keyboardType: TextInputType.multiline,
          errorText: postingDescriptionError(value.text) ?? errorText,
        );
      },
    );
  }
}

/// The job PAY boxes (#2595) — what the worker's card prints as the ₹ band; NOT
/// payment information of any kind. Digits only behind a fixed `₹` prefix,
/// Indian-grouped as typed ("18,000"), and capped at the server's ceiling
/// ([JobContentLimits.payMaxInr]). Read the value with [parseWholeNumber];
/// prefill it with [formatPayInput].
class JobPayField extends StatelessWidget {
  const JobPayField({
    super.key,
    required this.label,
    required this.controller,
    this.hint,
    this.errorText,
    this.flow,
  });

  final String label;
  final TextEditingController controller;
  final String? hint;
  final String? errorText;
  final BbFieldFlow? flow;

  static const List<TextInputFormatter> _formatters = <TextInputFormatter>[
    WholeNumberInputFormatter(max: JobContentLimits.payMaxInr, grouped: true),
  ];

  @override
  Widget build(BuildContext context) {
    return BbField(
      label: label,
      controller: controller,
      hint: hint,
      keyboardType: TextInputType.number,
      mono: true,
      prefixText: '₹ ',
      inputFormatters: _formatters,
      errorText: errorText,
      flow: flow,
    );
  }
}

/// The experience boxes (#2595) — whole years, digits only, capped at the
/// server's ceiling ([JobContentLimits.experienceMaxYears]).
class JobExperienceField extends StatelessWidget {
  const JobExperienceField({
    super.key,
    required this.label,
    required this.controller,
    this.hint,
    this.errorText,
    this.flow,
  });

  final String label;
  final TextEditingController controller;
  final String? hint;
  final String? errorText;
  final BbFieldFlow? flow;

  static const List<TextInputFormatter> _formatters = <TextInputFormatter>[
    WholeNumberInputFormatter(max: JobContentLimits.experienceMaxYears),
  ];

  @override
  Widget build(BuildContext context) {
    return BbField(
      label: label,
      controller: controller,
      hint: hint,
      keyboardType: TextInputType.number,
      mono: true,
      inputFormatters: _formatters,
      errorText: errorText,
      flow: flow,
    );
  }
}

/// A stored ₹ amount as a [JobPayField] shows it ("22,000"); empty when unset.
String formatPayInput(int? amount) =>
    amount == null ? '' : formatIndianGrouped(amount);

/// A labelled editor for a payer-typed chip list (Key skills / Benefits /
/// Requirements): one removable chip per entered phrase plus an '+ Add' chip
/// that DISAPPEARS at the server's item cap, rather than letting the payer enter
/// an item the contract would reject. An empty list renders just the add chip —
/// never a demo/placeholder chip (#357).
class JobChipListField extends StatelessWidget {
  const JobChipListField({
    super.key,
    required this.label,
    required this.values,
    required this.maxItems,
    required this.addLabel,
    required this.onAdd,
    required this.onRemove,
    this.errorText,
  });

  final String label;
  final List<String> values;
  final int maxItems;
  final String addLabel;

  /// Inline error under the chips (#2595 — e.g. "Add a benefit"), or null.
  final String? errorText;

  /// Opens the '+ Add' prompt. A `Future<void>` tear-off is fine — the caller
  /// owns the await (this is a fire-and-forget dialog, like the other sheet
  /// openers on these surfaces).
  final Future<void> Function() onAdd;

  final ValueChanged<String> onRemove;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          label,
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        Wrap(
          spacing: AppSpacing.chipGap,
          runSpacing: AppSpacing.chipGap,
          children: <Widget>[
            for (final String value in values)
              BbChip(
                label: value,
                selected: true,
                icon: Icons.close_rounded,
                onTap: () => onRemove(value),
              ),
            if (values.length < maxItems)
              BbChip(
                label: addLabel,
                // ignore: discarded_futures — fire-and-forget dialog opener.
                onTap: onAdd,
              ),
          ],
        ),
        BbFieldError(text: errorText),
      ],
    );
  }
}

/// #357 — the shared '+ Add …' prompt behind every chip row. A widget (not an
/// inline dialog) so it OWNS its [TextEditingController]: disposing one
/// alongside the awaited route future tears it down while the sheet is still
/// animating out, and the still-mounted [TextField] then throws "used after
/// being disposed". Pops the trimmed phrase, or null on cancel.
///
/// #2595 — [validate] runs on Add (and the keyboard's "done"): a refused
/// phrase keeps the sheet open with the reason under the box; typing clears
/// it. #2690 — it rides the ONE bottom-sheet surface (rule 4), not an
/// `AlertDialog`.
class _AddPhraseSheet extends StatefulWidget {
  const _AddPhraseSheet({
    required this.title,
    required this.hint,
    required this.fieldKey,
    required this.validate,
  });

  final String title;
  final String hint;
  final Key fieldKey;
  final String? Function(String phrase) validate;

  @override
  State<_AddPhraseSheet> createState() => _AddPhraseSheetState();
}

class _AddPhraseSheetState extends State<_AddPhraseSheet> {
  final TextEditingController _field = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _field.dispose();
    super.dispose();
  }

  void _submit() {
    final String phrase = _field.text.trim();
    final String? error = phrase.isEmpty ? null : widget.validate(phrase);
    if (error != null) {
      setState(() => _error = error);
      return;
    }
    Navigator.of(context).pop(phrase);
  }

  @override
  Widget build(BuildContext context) {
    final double bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s2,
        AppSpacing.gutter,
        AppSpacing.s5 + bottomInset,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text(
            widget.title,
            style: AppTypography.heading(
              size: AppTypography.sizeLg,
              weight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: AppSpacing.s4),
          BbField(
            controller: _field,
            hint: widget.hint,
            fieldKey: widget.fieldKey,
            errorText: _error,
            autofocus: true,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _submit(),
            onChanged: (_) {
              if (_error != null) setState(() => _error = null);
            },
          ),
          const SizedBox(height: AppSpacing.s5),
          Row(
            children: <Widget>[
              Expanded(
                child: BbButton(
                  label: 'Cancel',
                  variant: BbButtonVariant.secondary,
                  size: BbButtonSize.md,
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ),
              const SizedBox(width: AppSpacing.s3),
              Expanded(
                child: BbButton(
                  label: 'Add',
                  size: BbButtonSize.md,
                  onPressed: _submit,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
