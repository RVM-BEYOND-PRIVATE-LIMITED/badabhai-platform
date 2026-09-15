import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';

/// Key on the picker sheet's search box — tests type into it.
const Key kOnboardingPickerSearchKey = Key('onboarding_picker_search');

/// Key on the "use what I typed" row — present only for `allowCustom` pickers.
const Key kOnboardingPickerCustomKey = Key('onboarding_picker_custom');

/// The spec's dropdown field (48px, 10 radius, 1.2px hairline, Inter 14, a
/// chevron) — opening a searchable sheet instead of a Material
/// `DropdownButton`, which ASSERTS unless its value is one of its items. GPS
/// and saved data can hold values no list carries ("NCT of Delhi", a small
/// town), so a `DropdownButton` would crash; this field shows ANY value.
class OnboardingSelectField extends StatelessWidget {
  const OnboardingSelectField({
    super.key,
    required this.value,
    required this.hint,
    required this.onTap,
    this.enabled = true,
    this.semanticLabel,
  });

  final String value;
  final String hint;
  final VoidCallback onTap;
  final bool enabled;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final bool hasValue = value.isNotEmpty;
    return Semantics(
      button: true,
      enabled: enabled,
      label: semanticLabel,
      value: hasValue ? value : hint,
      child: Material(
        color: enabled ? OnboardingColors.paperWhite : OnboardingColors.canvasBg,
        borderRadius: BorderRadius.circular(OnboardingRadii.nameField),
        child: InkWell(
          onTap: enabled ? onTap : null,
          borderRadius: BorderRadius.circular(OnboardingRadii.nameField),
          child: Container(
            constraints: const BoxConstraints(minHeight: 48),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(OnboardingRadii.nameField),
              border: Border.all(color: OnboardingColors.borderDefault, width: 1.2),
            ),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    hasValue ? value : hint,
                    style: hasValue
                        ? OnboardingTypography.inter(size: 14, weight: FontWeight.w500)
                        : OnboardingTypography.inter(
                            size: 14, color: OnboardingColors.ink500),
                  ),
                ),
                Icon(
                  Icons.keyboard_arrow_down_rounded,
                  color: enabled ? OnboardingColors.ink900 : OnboardingColors.ink500,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Opens the searchable picker; resolves to the chosen value, or null when
/// closed. [allowCustom] adds a "use what I typed" row whenever the search text
/// is not already an option, so a worker is never refused the name of the place
/// they live (#1428). Typed values are capped at [customMaxLength].
Future<String?> showOnboardingPicker(
  BuildContext context, {
  required String title,
  required List<String> options,
  String? selected,
  bool allowCustom = false,
  int customMaxLength = 80,
  String searchHint = 'Type karke dhoondein',
  String emptyHint = 'Koi option nahi mila. Doosra shabd try karein.',
}) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    backgroundColor: OnboardingColors.paperWhite,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(OnboardingRadii.card)),
    ),
    builder: (BuildContext _) => _PickerSheet(
      title: title,
      options: options,
      selected: selected,
      allowCustom: allowCustom,
      customMaxLength: customMaxLength,
      searchHint: searchHint,
      emptyHint: emptyHint,
    ),
  );
}

class _PickerSheet extends StatefulWidget {
  const _PickerSheet({
    required this.title,
    required this.options,
    required this.selected,
    required this.allowCustom,
    required this.customMaxLength,
    required this.searchHint,
    required this.emptyHint,
  });

  final String title;
  final List<String> options;
  final String? selected;
  final bool allowCustom;
  final int customMaxLength;
  final String searchHint;
  final String emptyHint;

  @override
  State<_PickerSheet> createState() => _PickerSheetState();
}

class _PickerSheetState extends State<_PickerSheet> {
  final TextEditingController _search = TextEditingController();

  @override
  void initState() {
    super.initState();
    _search.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  static OutlineInputBorder _border(Color c, double w) => OutlineInputBorder(
        borderRadius: BorderRadius.circular(OnboardingRadii.nameField),
        borderSide: BorderSide(color: c, width: w),
      );

  @override
  Widget build(BuildContext context) {
    final String query = _search.text.trim();
    final String q = query.toLowerCase();
    final List<String> visible = q.isEmpty
        ? widget.options
        : widget.options.where((String o) => o.toLowerCase().contains(q)).toList();
    final bool exact = widget.options.any((String o) => o.toLowerCase() == q);
    final bool offerCustom = widget.allowCustom && query.isNotEmpty && !exact;

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
            20, 20, 20, MediaQuery.viewInsetsOf(context).bottom + 16),
        child: Center(
          heightFactor: 1,
          child: ConstrainedBox(
            constraints:
                const BoxConstraints(maxWidth: OnboardingLayout.maxContentWidth),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Text(widget.title, style: OnboardingTypography.anek(size: 18)),
                const SizedBox(height: 14),
                TextField(
                  key: kOnboardingPickerSearchKey,
                  controller: _search,
                  autofocus: true,
                  textCapitalization: TextCapitalization.words,
                  maxLength: widget.customMaxLength,
                  style: OnboardingTypography.inter(size: 14, weight: FontWeight.w500),
                  decoration: InputDecoration(
                    hintText: widget.searchHint,
                    hintStyle: OnboardingTypography.inter(
                        size: 14, color: OnboardingColors.ink500),
                    counterText: '',
                    filled: true,
                    fillColor: OnboardingColors.paperWhite,
                    isDense: true,
                    prefixIcon: const Icon(Icons.search_rounded,
                        color: OnboardingColors.ink600),
                    contentPadding:
                        const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                    enabledBorder: _border(OnboardingColors.borderDefault, 1.2),
                    focusedBorder: _border(OnboardingColors.borderActive, 1.5),
                  ),
                ),
                const SizedBox(height: 8),
                ConstrainedBox(
                  constraints: BoxConstraints(
                      maxHeight: MediaQuery.sizeOf(context).height * 0.45),
                  child: ListView(
                    shrinkWrap: true,
                    children: <Widget>[
                      if (offerCustom)
                        ListTile(
                          key: kOnboardingPickerCustomKey,
                          leading: const Icon(Icons.edit_location_alt_outlined,
                              color: OnboardingColors.shiftBlue),
                          title: Text(
                            '"$query" use karein',
                            style: OnboardingTypography.inter(
                                size: 14,
                                weight: FontWeight.w600,
                                color: OnboardingColors.shiftBlue),
                          ),
                          onTap: () => Navigator.of(context).pop(query),
                        ),
                      if (visible.isEmpty && !offerCustom)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 16),
                          child: Text(widget.emptyHint,
                              style: OnboardingTypography.bodyMuted()),
                        ),
                      for (final String option in visible)
                        ListTile(
                          title: Text(
                            option,
                            style: OnboardingTypography.inter(
                              size: 14,
                              weight: option == widget.selected
                                  ? FontWeight.w700
                                  : FontWeight.w400,
                            ),
                          ),
                          trailing: option == widget.selected
                              ? const Icon(Icons.check_rounded,
                                  color: OnboardingColors.shiftBlue)
                              : null,
                          onTap: () => Navigator.of(context).pop(option),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
