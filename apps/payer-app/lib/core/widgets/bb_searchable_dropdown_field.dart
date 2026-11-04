import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_motion.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import 'bb_field.dart';

/// A closed, single-select dropdown field that opens a SEARCHABLE bottom sheet
/// (#2593) — the payer-app port of the worker app's `BbSearchableDropdownField`:
/// the same "pick one from a LONG list" primitive. The field reads as a real
/// dropdown (the theme's input box with a trailing chevron, like [BbSelect]
/// beside it), showing the picked option's label. Tapping it opens a modal
/// sheet with a search box on top and the matching options below, so a payer
/// types to filter a long list instead of scrolling a wall of options.
///
/// The sheet clears the system gesture bar and rises with the keyboard; its
/// list shrinks to fit rather than overflow on a short phone.
class BbSearchableDropdownField<T extends Object> extends StatelessWidget {
  const BbSearchableDropdownField({
    super.key,
    required this.label,
    required this.value,
    required this.options,
    required this.labelOf,
    required this.onSelected,
    this.sheetTitle,
    this.searchHint = 'Type to search',
    this.emptyHint = defaultEmptyHint,
  });

  /// What the list says when the search matches nothing (the default).
  static const String defaultEmptyHint = 'Nothing matches. Try another word.';

  /// The bold label above the field (as on [BbSelect]).
  final String label;

  /// The option shown in the closed field.
  final T value;

  /// The full option list (unfiltered) offered in the sheet.
  final List<T> options;
  final String Function(T) labelOf;
  final ValueChanged<T> onSelected;

  /// Sheet heading — defaults to [label].
  final String? sheetTitle;
  final String searchHint;
  final String emptyHint;

  /// Key of the sheet's search input (for widget tests).
  @visibleForTesting
  static const Key searchFieldKey = Key('bb_searchable_dropdown_search');

  Future<void> _open(BuildContext context) async {
    final T? picked = await showModalBottomSheet<T>(
      context: context,
      sheetAnimationStyle: AppMotion.sheetStyle(context),
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      backgroundColor: AppColors.surfaceCard,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadii.xxl)),
      ),
      builder: (_) => _SearchSheet<T>(
        title: sheetTitle ?? label,
        value: value,
        options: options,
        labelOf: labelOf,
        searchHint: searchHint,
        emptyHint: emptyHint,
      ),
    );
    if (picked != null) onSelected(picked);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(
          label,
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
            color: AppColors.textPrimary,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        Semantics(
          button: true,
          child: InkWell(
            onTap: () => _open(context),
            borderRadius: BorderRadius.circular(AppRadii.md),
            // The theme's own input chrome, so it matches the selects beside it.
            child: InputDecorator(
              decoration: const InputDecoration(
                suffixIcon: Icon(
                  Icons.expand_more_rounded,
                  color: AppColors.textMuted,
                ),
              ),
              child: Text(
                labelOf(value),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppTypography.body(size: AppTypography.sizeBase),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _SearchSheet<T extends Object> extends StatefulWidget {
  const _SearchSheet({
    required this.title,
    required this.value,
    required this.options,
    required this.labelOf,
    required this.searchHint,
    required this.emptyHint,
  });

  final String title;
  final T value;
  final List<T> options;
  final String Function(T) labelOf;
  final String searchHint;
  final String emptyHint;

  @override
  State<_SearchSheet<T>> createState() => _SearchSheetState<T>();
}

class _SearchSheetState<T extends Object> extends State<_SearchSheet<T>> {
  final TextEditingController _search = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final String q = _query.trim().toLowerCase();
    final List<T> visible = q.isEmpty
        ? widget.options
        : widget.options
            .where((T o) => widget.labelOf(o).toLowerCase().contains(q))
            .toList(growable: false);

    // SafeArea: the sheet's last row clears the gesture bar; the keyboard
    // inset lifts the whole sheet above the keyboard.
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: AppSpacing.gutter,
          right: AppSpacing.gutter,
          bottom: MediaQuery.viewInsetsOf(context).bottom + AppSpacing.s4,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(
              widget.title,
              style: AppTypography.heading(size: AppTypography.sizeLg),
            ),
            const SizedBox(height: AppSpacing.s3),
            BbField(
              fieldKey: BbSearchableDropdownField.searchFieldKey,
              controller: _search,
              hint: widget.searchHint,
              icon: Icons.search_rounded,
              autofocus: true,
              textInputAction: TextInputAction.search,
              onChanged: (String v) => setState(() => _query = v),
            ),
            const SizedBox(height: AppSpacing.s2),
            // Flexible: with the keyboard up the list gives way, never the sheet.
            Flexible(
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.sizeOf(context).height * 0.4,
                ),
                child: visible.isEmpty
                    ? Padding(
                        padding: const EdgeInsets.symmetric(
                          vertical: AppSpacing.s5,
                        ),
                        child: Text(
                          widget.emptyHint,
                          style: AppTypography.body(
                            size: AppTypography.sizeSm,
                            color: AppColors.textMuted,
                          ),
                        ),
                      )
                    : ListView.separated(
                        shrinkWrap: true,
                        itemCount: visible.length,
                        separatorBuilder: (BuildContext context, int i) =>
                            const Divider(height: 1, color: AppColors.border),
                        itemBuilder: (BuildContext context, int i) {
                          final T option = visible[i];
                          final bool picked = option == widget.value;
                          return ListTile(
                            title: Text(
                              widget.labelOf(option),
                              style: AppTypography.body(
                                size: AppTypography.sizeBase,
                                weight:
                                    picked ? FontWeight.w700 : FontWeight.w400,
                              ),
                            ),
                            trailing: picked
                                ? const Icon(
                                    Icons.check_rounded,
                                    color: AppColors.blue,
                                  )
                                : null,
                            onTap: () => Navigator.of(context).pop(option),
                          );
                        },
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
