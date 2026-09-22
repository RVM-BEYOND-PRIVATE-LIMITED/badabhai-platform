import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../../../core/widgets/bb_field.dart';
import '../../../../core/widgets/bb_toast.dart';

/// Shared rules + inputs for the WORKER-VISIBLE free text on a posting — the
/// description and the benefits / requirements chips the worker's job card
/// renders VERBATIM.
///
/// One copy for all three surfaces that enter it (agency post, agency edit,
/// company edit) so the caps and the PII screen can never drift apart between
/// them. Every rule here MIRRORS a server rule (`agency.dto.ts`): the server is
/// the authority — this only fails closed EARLIER, with an honest message,
/// instead of letting a whole post 400.
abstract final class JobContentLimits {
  /// `description` — max chars (server: `DESCRIPTION_MAX`).
  static const int descriptionChars = 2000;

  /// `benefits[]` / `requirements[]` — max items per list (server:
  /// `LIST_ITEMS_MAX`).
  static const int listItems = 12;

  /// One benefits/requirements chip — max chars (server: `LIST_ITEM_MAX`).
  static const int listItemChars = 80;
}

// Client mirror of the server's `looksLikePii` (packages/validators): an email
// shape, or >=7 consecutive digits once common phone separators are stripped.
// Everything below rides the wire into a PII-screened, worker-visible field, so
// we refuse it AT ENTRY rather than let the server reject the whole write
// (CLAUDE.md §2 — privacy first, fail closed).
final RegExp _emailLike = RegExp(r'[^\s@]+@[^\s@]+\.[^\s@]+');
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

/// Prompt for ONE real phrase for a chip list and return it, or null when the
/// payer cancelled or the phrase was refused.
///
/// #357: it ASKS for the phrase instead of inserting a placeholder, and it fails
/// closed at entry on the server's own two item rules — the [maxChars] cap and
/// the PII screen — so one bad chip can never 400 the whole write. [noun] names
/// the list in every message ("skill" / "benefit" / "requirement").
Future<String?> promptForPostingPhrase(
  BuildContext context, {
  required String noun,
  required int maxChars,
  required String title,
  required String hint,
  required Key fieldKey,
}) async {
  final String? entered = await showDialog<String>(
    context: context,
    builder: (BuildContext _) =>
        _AddPhraseDialog(title: title, hint: hint, fieldKey: fieldKey),
  );

  if (!context.mounted || entered == null || entered.isEmpty) return null;
  if (entered.length > maxChars) {
    showBbToast(
      context,
      title: 'Too long',
      message: 'Keep a $noun under $maxChars characters.',
      icon: Icons.info_outline,
    );
    return null;
  }
  if (looksLikePostingPii(entered)) {
    showBbToast(
      context,
      title: 'Not a $noun',
      message: 'Leave phone numbers and email addresses out of a posting.',
      icon: Icons.info_outline,
    );
    return null;
  }
  return entered;
}

/// The posting `description` input — a growing multiline [BbField] that shows
/// the honest reason it cannot be sent (over the cap, or contact details the
/// server screens fail-closed) AS THE PAYER TYPES, instead of waiting for a 400.
/// Rebuilt off the controller alone, so typing does not rebuild the whole form.
class JobDescriptionField extends StatelessWidget {
  const JobDescriptionField({
    super.key,
    required this.controller,
    this.label = 'Description (optional)',
    this.hint = 'What the work is, machines, shift timings…',
  });

  final TextEditingController controller;
  final String label;
  final String hint;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: controller,
      builder: (BuildContext _, TextEditingValue value, Widget? __) {
        final String? error = postingDescriptionError(value.text);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            BbField(
              label: label,
              controller: controller,
              hint: hint,
              minLines: 3,
              maxLines: 6,
              keyboardType: TextInputType.multiline,
            ),
            if (error != null) ...<Widget>[
              const SizedBox(height: AppSpacing.s2),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  const Icon(
                    Icons.error_outline,
                    size: 16,
                    color: AppColors.danger,
                  ),
                  const SizedBox(width: AppSpacing.s2),
                  Expanded(
                    child: Text(
                      error,
                      style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        color: AppColors.danger,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ],
        );
      },
    );
  }
}

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
  });

  final String label;
  final List<String> values;
  final int maxItems;
  final String addLabel;

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
                icon: Icons.close,
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
      ],
    );
  }
}

/// #357 — the shared '+ Add …' prompt behind every chip row. A widget (not an
/// inline `AlertDialog`) so it OWNS its [TextEditingController]: disposing one
/// alongside the awaited `showDialog` future tears it down while the route is
/// still animating out, and the still-mounted [TextField] then throws "used
/// after being disposed". Pops the trimmed phrase, or null on cancel.
class _AddPhraseDialog extends StatefulWidget {
  const _AddPhraseDialog({
    required this.title,
    required this.hint,
    required this.fieldKey,
  });

  final String title;
  final String hint;
  final Key fieldKey;

  @override
  State<_AddPhraseDialog> createState() => _AddPhraseDialogState();
}

class _AddPhraseDialogState extends State<_AddPhraseDialog> {
  final TextEditingController _field = TextEditingController();

  @override
  void dispose() {
    _field.dispose();
    super.dispose();
  }

  void _submit() => Navigator.of(context).pop(_field.text.trim());

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppColors.surfaceCard,
      title: Text(
        widget.title,
        style: AppTypography.display(
          size: AppTypography.sizeMd,
          weight: FontWeight.w800,
        ),
      ),
      content: BbField(
        controller: _field,
        hint: widget.hint,
        fieldKey: widget.fieldKey,
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        TextButton(onPressed: _submit, child: const Text('Add')),
      ],
    );
  }
}
