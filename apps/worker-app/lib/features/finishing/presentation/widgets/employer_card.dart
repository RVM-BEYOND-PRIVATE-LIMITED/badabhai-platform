import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../../../core/widgets/bb_toggle.dart';
import '../../domain/finishing_models.dart';

// ---- Copy. aap-form, no `!`, safe verbs. Scanned by
// persona_neutrality_test.dart. ----
const String _kNameLabel = 'Company ka naam';
const String _kNameHint = 'Jaise: Sandhar Technologies';
const String _kRoleLabel = 'Aapka kaam / role';
// Trade-neutral (#1382). Duplicated verbatim in
// `trade_form/presentation/widgets/trade_form_employment_page.dart`; keep
// both in sync if this ever changes.
const String _kRoleHint = 'Jaise: Operator';
const String _kCityLabel = 'Sheher';
const String _kStateLabel = 'State';
const String _kStartLabel = 'Kab shuru kiya';
const String _kEndLabel = 'Kab tak';
const String _kStillWorking = 'Abhi yahin kaam kar rahe hain';
const String _kWorkLabel = 'Aap kya kaam karte the?';
// Trade-neutral (#1382). Duplicated verbatim in
// `trade_form/presentation/widgets/trade_form_employment_page.dart`; keep
// both in sync if this ever changes.
const String _kWorkHint = 'Jaise: Naye parts banate the aur quality check karte the';
const String _kNotStated = 'Nahi bataya';
const String _kPickYear = 'Saal chunein';
const String _kPickMonth = 'Mahina chunein';

const int _kWorkDoneMax = 300;

const List<String> _kMonths = <String>[
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/// A themed text field for the finishing form — the app has no wrapped field
/// widget, so this mirrors the shared filled-surface decoration used elsewhere.
/// A persistent [Semantics] label keeps TalkBack meaningful after the hint
/// disappears on input (low-literacy accessibility).
class FinishingTextField extends StatelessWidget {
  const FinishingTextField({
    super.key,
    required this.controller,
    required this.hint,
    this.label,
    this.onChanged,
    this.onSubmitted,
    this.textInputAction = TextInputAction.next,
    this.keyboardType,
    this.maxLength,
    this.maxLines = 1,
  });

  final TextEditingController controller;
  final String hint;
  final String? label;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final TextInputAction textInputAction;
  final TextInputType? keyboardType;
  final int? maxLength;
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label ?? hint,
      textField: true,
      child: TextField(
        controller: controller,
        onChanged: onChanged,
        onSubmitted: onSubmitted,
        textInputAction: textInputAction,
        keyboardType: keyboardType,
        maxLength: maxLength,
        maxLines: maxLines,
        style: AppTypography.body(size: AppTypography.sizeBase),
        decoration: InputDecoration(
          hintText: hint,
          filled: true,
          fillColor: AppColors.surfaceCard,
          counterText: maxLength == null ? null : '',
          hintStyle: AppTypography.body(
              size: AppTypography.sizeBase, color: AppColors.textFaint),
          contentPadding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.s3, vertical: AppSpacing.s3),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AppRadii.md),
            borderSide: const BorderSide(color: AppColors.borderSubtle),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AppRadii.md),
            borderSide: const BorderSide(color: AppColors.blue, width: 1.5),
          ),
        ),
      ),
    );
  }
}

/// One repeating employer card (#1296) — the only page with typing. Company name
/// + role are required; city/state, a month-only start/end, and a short work
/// summary are optional. "Abhi yahin kaam kar rahe hain" maps to `end_ym: null`
/// (current), never a missing answer.
class EmployerCard extends StatefulWidget {
  const EmployerCard({
    super.key,
    required this.entry,
    required this.onChanged,
    required this.onRemove,
  });

  final EmploymentEntry entry;
  final ValueChanged<EmploymentEntry> onChanged;
  final VoidCallback onRemove;

  @override
  State<EmployerCard> createState() => _EmployerCardState();
}

class _EmployerCardState extends State<EmployerCard> {
  late final TextEditingController _name =
      TextEditingController(text: widget.entry.employerName);
  late final TextEditingController _role =
      TextEditingController(text: widget.entry.roleLabel);
  late final TextEditingController _city =
      TextEditingController(text: widget.entry.employerCity ?? '');
  late final TextEditingController _state =
      TextEditingController(text: widget.entry.employerState ?? '');
  late final TextEditingController _work =
      TextEditingController(text: widget.entry.workDone ?? '');

  /// Local so the end picker can show even before a value is chosen. Seeded from
  /// the entry (null end == currently working here).
  late bool _stillWorking = widget.entry.endYm == null;

  @override
  void didUpdateWidget(EmployerCard old) {
    super.didUpdateWidget(old);
    // Re-sync ONLY when the parent's value diverges from the field (e.g. a
    // sibling card was removed and this index now holds a different entry), so a
    // normal keystroke never fights the controller or jumps the cursor.
    _syncIfChanged(_name, widget.entry.employerName);
    _syncIfChanged(_role, widget.entry.roleLabel);
    _syncIfChanged(_city, widget.entry.employerCity ?? '');
    _syncIfChanged(_state, widget.entry.employerState ?? '');
    _syncIfChanged(_work, widget.entry.workDone ?? '');
  }

  void _syncIfChanged(TextEditingController c, String value) {
    if (c.text != value) c.text = value;
  }

  @override
  void dispose() {
    _name.dispose();
    _role.dispose();
    _city.dispose();
    _state.dispose();
    _work.dispose();
    super.dispose();
  }

  void _push(EmploymentEntry next) => widget.onChanged(next);

  @override
  Widget build(BuildContext context) {
    final EmploymentEntry e = widget.entry;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.s4),
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.sm),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Align(
            alignment: Alignment.centerRight,
            child: IconButton(
              onPressed: widget.onRemove,
              icon: const Icon(Icons.close, size: 20, color: AppColors.textMuted),
              tooltip: 'Hataayein',
              constraints:
                  const BoxConstraints(minWidth: AppSpacing.tap, minHeight: 32),
              padding: EdgeInsets.zero,
            ),
          ),
          _label(_kNameLabel),
          FinishingTextField(
            controller: _name,
            hint: _kNameHint,
            label: _kNameLabel,
            onChanged: (v) => _push(e.copyWith(employerName: v)),
          ),
          const SizedBox(height: AppSpacing.s3),
          _label(_kRoleLabel),
          FinishingTextField(
            controller: _role,
            hint: _kRoleHint,
            label: _kRoleLabel,
            onChanged: (v) => _push(e.copyWith(roleLabel: v)),
          ),
          const SizedBox(height: AppSpacing.s3),
          Row(
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    _label(_kCityLabel),
                    FinishingTextField(
                      controller: _city,
                      hint: _kCityLabel,
                      label: _kCityLabel,
                      onChanged: (v) => _push(e.copyWith(employerCity: v)),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    _label(_kStateLabel),
                    FinishingTextField(
                      controller: _state,
                      hint: _kStateLabel,
                      label: _kStateLabel,
                      textInputAction: TextInputAction.done,
                      onChanged: (v) => _push(e.copyWith(employerState: v)),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.s3),
          _label(_kStartLabel),
          _YearMonthField(
            value: e.startYm,
            onPicked: (String? ym) => _push(e.copyWith(startYm: ym)),
          ),
          const SizedBox(height: AppSpacing.s3),
          Row(
            children: <Widget>[
              Expanded(
                child: Text(_kStillWorking,
                    style: AppTypography.body(size: AppTypography.sizeSm)),
              ),
              BbToggle(
                value: _stillWorking,
                semanticLabel: _kStillWorking,
                onChanged: (bool on) {
                  setState(() => _stillWorking = on);
                  // "Still working" is end_ym: null; turning it off clears the
                  // end so the picker starts empty (a real end month, if given).
                  _push(e.copyWith(endYm: null));
                },
              ),
            ],
          ),
          if (!_stillWorking) ...<Widget>[
            const SizedBox(height: AppSpacing.s1),
            _label(_kEndLabel),
            _YearMonthField(
              value: e.endYm,
              onPicked: (String? ym) => _push(e.copyWith(endYm: ym)),
            ),
          ],
          const SizedBox(height: AppSpacing.s3),
          _label(_kWorkLabel),
          FinishingTextField(
            controller: _work,
            hint: _kWorkHint,
            label: _kWorkLabel,
            maxLength: _kWorkDoneMax,
            maxLines: 3,
            textInputAction: TextInputAction.newline,
            onChanged: (v) => _push(e.copyWith(workDone: v)),
          ),
        ],
      ),
    );
  }

  Widget _label(String text) => Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.s1),
        child: Text(text,
            style: AppTypography.body(
                size: AppTypography.sizeSm, weight: FontWeight.w700)),
      );
}

/// A month-precision date field: shows the current "MMM YYYY" (or a "not stated"
/// hint) and opens a two-step chip sheet — year chips, then month chips — so a
/// low-literacy worker never meets a calendar keyboard. Returns "YYYY-MM".
class _YearMonthField extends StatelessWidget {
  const _YearMonthField({required this.value, required this.onPicked});

  final String? value;
  final ValueChanged<String?> onPicked;

  String _display() {
    final String? v = value;
    if (v == null) return _kNotStated;
    final List<String> parts = v.split('-');
    if (parts.length != 2) return _kNotStated;
    final int? m = int.tryParse(parts[1]);
    final String month =
        (m != null && m >= 1 && m <= 12) ? _kMonths[m - 1] : parts[1];
    return '$month ${parts[0]}';
  }

  @override
  Widget build(BuildContext context) {
    final bool set = value != null;
    return InkWell(
      onTap: () => _open(context),
      borderRadius: BorderRadius.circular(AppRadii.md),
      child: Container(
        constraints: const BoxConstraints(minHeight: AppSpacing.tap),
        padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.s3, vertical: AppSpacing.s3),
        decoration: BoxDecoration(
          color: AppColors.surfaceCard,
          borderRadius: BorderRadius.circular(AppRadii.md),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        child: Row(
          children: <Widget>[
            const Icon(Icons.event_outlined,
                size: 20, color: AppColors.textMuted),
            const SizedBox(width: AppSpacing.s2),
            Expanded(
              child: Text(
                _display(),
                style: AppTypography.body(
                  size: AppTypography.sizeBase,
                  color: set ? AppColors.textPrimary : AppColors.textFaint,
                ),
              ),
            ),
            if (set)
              GestureDetector(
                onTap: () => onPicked(null),
                child: const Icon(Icons.close,
                    size: 18, color: AppColors.textMuted),
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
      builder: (BuildContext ctx) => const _YearMonthSheet(),
    );
    // A non-null result is a complete "YYYY-MM"; dismissing keeps the old value.
    if (picked != null) onPicked(picked);
  }
}

class _YearMonthSheet extends StatefulWidget {
  const _YearMonthSheet();
  @override
  State<_YearMonthSheet> createState() => _YearMonthSheetState();
}

class _YearMonthSheetState extends State<_YearMonthSheet> {
  int? _year;

  /// A fixed span of recent years (newest first) — no dependence on the wall
  /// clock, which the test harness pins; 45 years back covers any career.
  static const int _latestYear = 2026;
  static const int _span = 45;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(AppSpacing.gutter, AppSpacing.s5,
            AppSpacing.gutter, AppSpacing.s5),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(_year == null ? _kPickYear : _kPickMonth,
                style: AppTypography.display(size: AppTypography.sizeLg)),
            const SizedBox(height: AppSpacing.s4),
            if (_year == null)
              Wrap(
                spacing: AppSpacing.s2,
                runSpacing: AppSpacing.s2,
                children: <Widget>[
                  for (int y = _latestYear; y > _latestYear - _span; y--)
                    BbChip(
                      label: '$y',
                      onTap: () => setState(() => _year = y),
                    ),
                ],
              )
            else
              Wrap(
                spacing: AppSpacing.s2,
                runSpacing: AppSpacing.s2,
                children: <Widget>[
                  for (int m = 1; m <= 12; m++)
                    BbChip(
                      label: _kMonths[m - 1],
                      onTap: () => Navigator.of(context).pop(
                          '${_year!}-${m.toString().padLeft(2, '0')}'),
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}
