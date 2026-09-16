import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';
import '../../domain/finishing_models.dart';
import 'finishing_controls.dart';

// ---- Copy. aap-form, no `!`, safe verbs. Scanned by
// persona_neutrality_test.dart. ----
const String _kNameLabel = 'Company ka naam';
const String _kNameHint = 'Jaise: Sandhar Technologies';
const String _kRoleLabel = 'Aapka kaam / role';
// Trade-neutral (#1382). Duplicated verbatim in
// `trade_form/presentation/widgets/trade_form_employment_page.dart`; keep
// both in sync if this ever changes.
const String _kRoleHint = 'Jaise: Operator';
// Spec §3.21 / ruling R17: the work-history location labels name the field in
// Hinglish AND in English, because a worker who reads only one of the two must
// still know which box is which. The HINTS stay the bare words — a hint sits
// inside the box, where the label above it has already said the rest.
const String _kCityLabel = 'Sheher (City)';
const String _kStateLabel = 'State (Rajya)';
const String _kCityHint = 'Sheher';
const String _kStateHint = 'State';
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
const String _kRemove = 'Hataayein';

const int _kWorkDoneMax = 300;

const List<String> _kMonths = <String>[
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/// The kit's form-field label — Inter, muted, sentence case (these labels are
/// whole questions, so the kit's uppercase micro-label would hurt reading).
TextStyle finishingFieldLabelStyle() => OnboardingTypography.inter(
      size: 13,
      weight: FontWeight.w600,
      color: OnboardingColors.ink600,
    );

/// A themed text field for the finishing form, in the kit's input style: white,
/// 48px floor, 10 radius, `borderDefault` hairline, a navy focus ring. A
/// persistent [Semantics] label keeps TalkBack meaningful after the hint
/// disappears on input (low-literacy accessibility).
///
/// UI kit v3, decision D8: FOCUS is `shiftBlue` at 1.8 (the spec's only focus
/// rule, §3.3's OTP cell); safety yellow now means SELECTED and nothing else,
/// so a caret in a field cannot read as an answer already given.
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

  static OutlineInputBorder _border(Color color, double width) =>
      OutlineInputBorder(
        borderRadius: BorderRadius.circular(OnboardingRadii.nameField),
        borderSide: BorderSide(color: color, width: width),
      );

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
        cursorColor: OnboardingColors.shiftBlue,
        style: OnboardingTypography.inter(size: 14, weight: FontWeight.w500),
        decoration: InputDecoration(
          hintText: hint,
          filled: true,
          fillColor: OnboardingColors.paperWhite,
          counterText: maxLength == null ? null : '',
          hintStyle: OnboardingTypography.inter(
              size: 14, color: OnboardingColors.ink500),
          constraints: const BoxConstraints(
            minHeight: OnboardingLayout.tapTarget,
          ),
          contentPadding:
              const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
          border: _border(OnboardingColors.borderDefault, 1.2),
          enabledBorder: _border(OnboardingColors.borderDefault, 1.2),
          focusedBorder: _border(OnboardingColors.shiftBlue, 1.8),
        ),
      ),
    );
  }
}

/// One repeating employer card (#1296) — the only page with typing. Company name
/// + role are required; state/city, a month-only start/end, and a short work
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
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 16),
      decoration: BoxDecoration(
        color: OnboardingColors.paperWhite,
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
        border: Border.all(color: OnboardingColors.borderDefault, width: 1.2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // The first label shares its row with the remove control, so the 48px
          // remove target costs no extra height of its own.
          Row(
            children: <Widget>[
              Expanded(child: Text(_kNameLabel, style: finishingFieldLabelStyle())),
              IconButton(
                onPressed: widget.onRemove,
                icon: const Icon(Icons.close_rounded,
                    size: 20, color: OnboardingColors.ink600),
                tooltip: _kRemove,
                constraints: const BoxConstraints(
                  minWidth: OnboardingLayout.tapTarget,
                  minHeight: OnboardingLayout.tapTarget,
                ),
                padding: EdgeInsets.zero,
              ),
            ],
          ),
          // Everything below the header row keeps the card's 16px right inset
          // (the row above uses 8 so the close glyph sits near the corner).
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                FinishingTextField(
                  controller: _name,
                  hint: _kNameHint,
                  label: _kNameLabel,
                  onChanged: (v) => _push(e.copyWith(employerName: v)),
                ),
                const SizedBox(height: 14),
                _label(_kRoleLabel),
                FinishingTextField(
                  controller: _role,
                  hint: _kRoleHint,
                  label: _kRoleLabel,
                  onChanged: (v) => _push(e.copyWith(roleLabel: v)),
                ),
                const SizedBox(height: 14),
                // Master spec: State (Rajya) ALWAYS precedes Sheher (City).
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          _label(_kStateLabel),
                          FinishingTextField(
                            controller: _state,
                            hint: _kStateHint,
                            label: _kStateLabel,
                            onChanged: (v) =>
                                _push(e.copyWith(employerState: v)),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          _label(_kCityLabel),
                          FinishingTextField(
                            controller: _city,
                            hint: _kCityHint,
                            label: _kCityLabel,
                            // Last text field of the pair now, so it closes
                            // the keyboard (the next control is a picker).
                            textInputAction: TextInputAction.done,
                            onChanged: (v) =>
                                _push(e.copyWith(employerCity: v)),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                _label(_kStartLabel),
                _YearMonthField(
                  value: e.startYm,
                  onPicked: (String? ym) => _push(e.copyWith(startYm: ym)),
                ),
                const SizedBox(height: 14),
                FinishingToggleRow(
                  label: _kStillWorking,
                  value: _stillWorking,
                  color: OnboardingColors.chipBg,
                  onChanged: (bool on) {
                    setState(() => _stillWorking = on);
                    // "Still working" is end_ym: null; turning it off clears the
                    // end so the picker starts empty (a real end month, if given).
                    _push(e.copyWith(endYm: null));
                  },
                ),
                if (!_stillWorking) ...<Widget>[
                  const SizedBox(height: 14),
                  _label(_kEndLabel),
                  _YearMonthField(
                    value: e.endYm,
                    onPicked: (String? ym) => _push(e.copyWith(endYm: ym)),
                  ),
                ],
                const SizedBox(height: 14),
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
          ),
        ],
      ),
    );
  }

  Widget _label(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(text, style: finishingFieldLabelStyle()),
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
    final BorderRadius radius =
        BorderRadius.circular(OnboardingRadii.nameField);
    return Material(
      color: OnboardingColors.paperWhite,
      shape: RoundedRectangleBorder(
        borderRadius: radius,
        side: const BorderSide(color: OnboardingColors.borderDefault, width: 1.2),
      ),
      child: InkWell(
        onTap: () => _open(context),
        borderRadius: radius,
        child: ConstrainedBox(
          constraints:
              const BoxConstraints(minHeight: OnboardingLayout.tapTarget),
          child: Padding(
            padding: EdgeInsets.only(left: 14, right: set ? 0 : 14),
            child: Row(
              children: <Widget>[
                const Icon(Icons.event_outlined,
                    size: 20, color: OnboardingColors.ink600),
                const SizedBox(width: 10),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(
                      _display(),
                      style: set
                          ? OnboardingTypography.inter(
                              size: 14, weight: FontWeight.w500)
                          : OnboardingTypography.inter(
                              size: 14, color: OnboardingColors.ink500),
                    ),
                  ),
                ),
                if (set)
                  IconButton(
                    onPressed: () => onPicked(null),
                    tooltip: _kRemove,
                    icon: const Icon(Icons.close_rounded,
                        size: 18, color: OnboardingColors.ink600),
                    constraints: const BoxConstraints(
                      minWidth: OnboardingLayout.tapTarget,
                      minHeight: OnboardingLayout.tapTarget,
                    ),
                    padding: EdgeInsets.zero,
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _open(BuildContext context) async {
    final String? picked = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: OnboardingColors.paperWhite,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius:
            BorderRadius.vertical(top: Radius.circular(OnboardingRadii.card)),
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
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
        child: Center(
          heightFactor: 1,
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: OnboardingLayout.maxContentWidth,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Text(_year == null ? _kPickYear : _kPickMonth,
                    style: OnboardingTypography.anek(size: 18)),
                const SizedBox(height: 14),
                // 45 year chips are taller than a small handset: the grid
                // scrolls inside the sheet instead of overflowing it.
                Flexible(
                  child: SingleChildScrollView(
                    child: Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: <Widget>[
                        if (_year == null)
                          for (int y = _latestYear; y > _latestYear - _span; y--)
                            FinishingChip(
                              label: '$y',
                              // Spec §1.2: a year is a number, so it is set in
                              // Roboto Mono — and tabular figures keep the 45
                              // chips the same width instead of jittering.
                              labelStyle: OnboardingTypography.mono(
                                size: 14,
                                weight: FontWeight.w600,
                                color: OnboardingColors.ink900,
                              ),
                              onTap: () => setState(() => _year = y),
                            )
                        else
                          for (int m = 1; m <= 12; m++)
                            FinishingChip(
                              label: _kMonths[m - 1],
                              onTap: () => Navigator.of(context).pop(
                                  '${_year!}-${m.toString().padLeft(2, '0')}'),
                            ),
                      ],
                    ),
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
