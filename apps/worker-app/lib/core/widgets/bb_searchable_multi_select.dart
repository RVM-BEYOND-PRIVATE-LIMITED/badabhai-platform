import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import 'bb_chip.dart';
import 'bb_search_field.dart';

/// One selectable option: the [key] a screen submits (never shown) and the
/// [label] rendered on the chip. Deliberately the same {key, label} shape
/// `VoiceChoice` (voice_form) already uses, so a caller can pass its own
/// option list straight through without re-shaping it — this widget has no
/// import on that feature, only the matching convention.
@immutable
class BbSelectOption {
  const BbSelectOption({required this.key, required this.label});

  final String key;
  final String label;
}

/// A [BbSearchField] over a [Wrap] of [BbChip]s — the reusable "pick several
/// from a long option list" primitive (#1342). The server, not this widget,
/// decides WHEN a list is long enough to need a search box (`ui.searchable`,
/// computed from option count); this widget just renders one when asked.
///
/// **Controlled selection.** [selectedKeys] is the single source of truth;
/// a tap computes the next list and reports it via [onChanged] — the widget
/// keeps no selection state of its own, so a caller (e.g. the trade-form
/// question screen, #1341) can hold it alongside the rest of its answer
/// state without the two ever drifting apart. New picks are appended, so the
/// reported order is tap order — the same convention `VoiceChoiceChips` uses
/// for its own accumulating `_selected` list.
///
/// **Submits keys, never labels** — [onChanged] always carries
/// [BbSelectOption.key] values, exactly like `VoiceChoiceChips.onChips`.
///
/// **Selected chips never disappear.** Filtering by [label_text] is a
/// convenience over the UNSELECTED options only — a worker who already
/// picked "Brass" and then types "alu" must still see the Brass chip (still
/// selected) alongside anything matching "alu"; losing sight of a prior pick
/// because it scrolled out of a filtered view would silently look like it
/// was un-picked.
///
/// **Resets its query, not its selection, on [resetKey] change.** This
/// widget does not know what a "question" is (only options + selection), so
/// it takes an opaque [resetKey] the caller changes when the underlying list
/// changes meaning (e.g. a new question) — mirroring how `VoiceChoiceChips`
/// clears ITS OWN state in `didUpdateWidget` when the question id changes.
/// Clearing selection on that same event is the caller's job (it owns
/// [selectedKeys]); this widget only ever clears the leftover search text,
/// so a worker never lands on a fresh list still filtered by a query typed
/// against the previous one.
class BbSearchableMultiSelect extends StatefulWidget {
  const BbSearchableMultiSelect({
    super.key,
    required this.options,
    required this.selectedKeys,
    required this.onChanged,
    this.resetKey,
    this.searchLabel = 'Search karein',
    this.searchHint = 'Type karke dhoondein',
    this.emptyHint = 'Koi option nahi mila. Doosra shabd try karein.',
  });

  /// The full option list (unfiltered). Order is preserved in the rendered
  /// [Wrap] — this widget never re-sorts by selection or match quality.
  final List<BbSelectOption> options;

  /// Currently selected option keys, in tap order. Owned by the caller.
  final List<String> selectedKeys;

  /// Fired with the FULL next selection (never just the delta) whenever a
  /// chip is tapped — mirrors `VoiceChoiceChips.onChips`.
  final ValueChanged<List<String>> onChanged;

  /// Changing this clears the search query — pass something that identifies
  /// "this is a new list" (a question id, a form-step key, ...).
  final Object? resetKey;

  /// Accessible name + placeholder for the search box.
  final String searchLabel;
  final String searchHint;

  /// Shown instead of the chip [Wrap] when nothing (selected or matching)
  /// remains to show.
  final String emptyHint;

  @override
  State<BbSearchableMultiSelect> createState() =>
      _BbSearchableMultiSelectState();
}

class _BbSearchableMultiSelectState extends State<BbSearchableMultiSelect> {
  final TextEditingController _searchController = TextEditingController();
  String _query = '';

  @override
  void didUpdateWidget(covariant BbSearchableMultiSelect oldWidget) {
    super.didUpdateWidget(oldWidget);
    // NEW LIST → CLEAR THE QUERY. Flutter reuses this State when the parent
    // rebuilds at the same tree position with a new option set; without this
    // a query typed against question N would silently keep filtering
    // question N+1's (unrelated) options, hiding chips a worker never meant
    // to search away.
    if (oldWidget.resetKey != widget.resetKey) {
      _searchController.clear();
      setState(() => _query = '');
    }
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  void _toggle(String key) {
    final List<String> next = List<String>.of(widget.selectedKeys);
    if (next.contains(key)) {
      next.remove(key);
    } else {
      next.add(key); // tap order — appended, never inserted
    }
    widget.onChanged(next);
  }

  @override
  Widget build(BuildContext context) {
    final String q = _query.trim().toLowerCase();
    final Set<String> selected = widget.selectedKeys.toSet();
    final List<BbSelectOption> visible = widget.options.where((option) {
      if (selected.contains(option.key)) return true; // never hide a pick
      if (q.isEmpty) return true;
      return option.label.toLowerCase().contains(q);
    }).toList();

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        BbSearchField(
          controller: _searchController,
          label: widget.searchLabel,
          hint: widget.searchHint,
          onChanged: (String value) => setState(() => _query = value),
        ),
        const SizedBox(height: AppSpacing.s3),
        if (visible.isEmpty)
          Text(
            widget.emptyHint,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textFaint,
            ),
          )
        else
          Wrap(
            spacing: AppSpacing.s2,
            runSpacing: AppSpacing.s2,
            children: <Widget>[
              for (final BbSelectOption option in visible)
                BbChip(
                  label: option.label,
                  selected: selected.contains(option.key),
                  onTap: () => _toggle(option.key),
                ),
            ],
          ),
      ],
    );
  }
}
