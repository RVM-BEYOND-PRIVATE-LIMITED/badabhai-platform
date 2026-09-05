import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import 'bb_search_field.dart';

/// A closed, single-select dropdown field that opens a searchable bottom
/// sheet — the "pick one from a LONG list" primitive (state/city, and
/// anything else with too many options for a chip [Wrap] to stay usable).
///
/// Deliberately reads as a real dropdown, not a chip: a bordered box with a
/// trailing chevron (mirrors `_YearMonthField`'s own established look in
/// `trade_form_employment_page.dart`), showing [placeholder] until something
/// is picked, then the picked value in its place. Tapping it opens a modal
/// sheet with a search box on top and the matching options below — a
/// worker can type to filter a 30-state or 100-city list instead of
/// scrolling a wall of chips.
class BbSearchableDropdownField extends StatelessWidget {
  const BbSearchableDropdownField({
    super.key,
    required this.placeholder,
    required this.options,
    required this.selected,
    required this.onSelected,
    this.sheetTitle,
    this.searchHint = 'Type karke dhoondein',
    this.emptyHint = 'Koi option nahi mila. Doosra shabd try karein.',
    this.enabled = true,
  });

  /// Shown (muted) when nothing is picked yet — e.g. "STATE CHUNEIN".
  final String placeholder;

  /// The full option list (unfiltered) offered in the sheet.
  final List<String> options;

  /// The currently picked value, or null/empty for "nothing picked".
  final String? selected;

  final ValueChanged<String> onSelected;

  /// Sheet heading — defaults to [placeholder] when omitted.
  final String? sheetTitle;
  final String searchHint;
  final String emptyHint;

  /// False renders the closed, muted, non-interactive state (e.g. "pick a
  /// state first" for the city field) — same convention as [TextField]'s
  /// own `enabled: false`.
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final bool set = selected != null && selected!.isNotEmpty;
    return InkWell(
      onTap: enabled ? () => _open(context) : null,
      borderRadius: BorderRadius.circular(AppRadii.md),
      child: Container(
        constraints: const BoxConstraints(minHeight: AppSpacing.tap),
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.s3,
          vertical: AppSpacing.s3,
        ),
        decoration: BoxDecoration(
          color: enabled ? AppColors.surfaceCard : AppColors.disabled,
          borderRadius: BorderRadius.circular(AppRadii.md),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Text(
                set ? selected! : placeholder,
                style: AppTypography.body(
                  size: AppTypography.sizeBase,
                  color: set ? AppColors.textPrimary : AppColors.textFaint,
                ),
              ),
            ),
            Icon(
              Icons.arrow_drop_down_rounded,
              color: enabled ? AppColors.textMuted : AppColors.textFaint,
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _open(BuildContext context) async {
    final String? picked = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: AppColors.surfaceCard,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadii.lg)),
      ),
      builder: (BuildContext ctx) => _DropdownSearchSheet(
        title: sheetTitle ?? placeholder,
        options: options,
        searchHint: searchHint,
        emptyHint: emptyHint,
      ),
    );
    if (picked != null) onSelected(picked);
  }
}

class _DropdownSearchSheet extends StatefulWidget {
  const _DropdownSearchSheet({
    required this.title,
    required this.options,
    required this.searchHint,
    required this.emptyHint,
  });

  final String title;
  final List<String> options;
  final String searchHint;
  final String emptyHint;

  @override
  State<_DropdownSearchSheet> createState() => _DropdownSearchSheetState();
}

class _DropdownSearchSheetState extends State<_DropdownSearchSheet> {
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
    final List<String> visible = q.isEmpty
        ? widget.options
        : widget.options.where((String o) => o.toLowerCase().contains(q)).toList();

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: AppSpacing.gutter,
          right: AppSpacing.gutter,
          top: AppSpacing.s5,
          bottom: MediaQuery.of(context).viewInsets.bottom + AppSpacing.s5,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(widget.title, style: AppTypography.display(size: AppTypography.sizeLg)),
            const SizedBox(height: AppSpacing.s4),
            BbSearchField(
              controller: _search,
              hint: widget.searchHint,
              autofocus: true,
              onChanged: (String v) => setState(() => _query = v),
            ),
            const SizedBox(height: AppSpacing.s3),
            ConstrainedBox(
              constraints: BoxConstraints(
                maxHeight: MediaQuery.of(context).size.height * 0.4,
              ),
              child: visible.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s5),
                      child: Text(
                        widget.emptyHint,
                        style: AppTypography.body(
                          size: AppTypography.sizeSm,
                          color: AppColors.textFaint,
                        ),
                      ),
                    )
                  : ListView.separated(
                      shrinkWrap: true,
                      itemCount: visible.length,
                      separatorBuilder: (BuildContext context, int i) =>
                          const Divider(height: 1, color: AppColors.borderSubtle),
                      itemBuilder: (BuildContext context, int i) => ListTile(
                        title: Text(
                          visible[i],
                          style: AppTypography.body(size: AppTypography.sizeMd),
                        ),
                        onTap: () => Navigator.of(context).pop(visible[i]),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
