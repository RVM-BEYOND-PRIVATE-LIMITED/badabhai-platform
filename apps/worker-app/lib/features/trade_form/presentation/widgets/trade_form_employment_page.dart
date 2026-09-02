import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../../../core/widgets/bb_toggle.dart';
import '../../domain/trade_form_models.dart';
import 'trade_form_text_field.dart';

// Copy. aap-form, no `!`, safe verbs only. Scanned by
// persona_neutrality_test.dart.
const String _kTitle = 'Aapne pehle kahan kaam kiya?';
const String _kSubtitle = 'Zyada se zyada 4 jagah likh sakte hain.';
const String _kAddEmployer = 'Aur ek jagah jodein';
const String _kNameLabel = 'Company ka naam';
const String _kNameHint = 'Jaise: Sandhar Technologies';
const String _kRoleLabel = 'Aapka kaam / role';
// Trade-neutral (#1382 — this pack now scales across 21 trades, not just
// CNC turning). Duplicated verbatim in `finishing/employer_card.dart`; keep
// both in sync if this ever changes.
const String _kRoleHint = 'Jaise: Operator';
const String _kCityLabel = 'Sheher';
const String _kStateLabel = 'State';
const String _kStartLabel = 'Kab shuru kiya';
const String _kEndLabel = 'Kab tak';
const String _kStillWorking = 'Abhi yahin kaam kar rahe hain';
const String _kWorkLabel = 'Aap kya kaam karte the?';
// Trade-neutral (#1382). Duplicated verbatim in
// `finishing/employer_card.dart`; keep both in sync if this ever changes.
const String _kWorkHint = 'Jaise: Naye parts banate the aur quality check karte the';
const String _kNotStated = 'Nahi bataya';
const String _kPickYear = 'Saal chunein';
const String _kPickMonth = 'Mahina chunein';
const int _kWorkDoneMax = 300;
const String _kDateOrderError = 'Khatam hone ki date shuru hone ke baad honi chahiye.';

const List<String> _kMonths = <String>[
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/// The `type: "employment"` marker screen (#1341) — the repeat-card work
/// history `PUT /workers/me/employment` owns. Same flat single-role shape
/// `features/finishing` sends today; #1341 notes the endpoint now also
/// accepts nested `roles[]`, which is a follow-up, not a blocker (see
/// `trade_form_models.dart`'s doc on this file's deliberate duplication).
class TradeFormEmploymentPage extends StatefulWidget {
  const TradeFormEmploymentPage({
    super.key,
    required this.enabled,
    required this.onSave,
  });

  final bool enabled;
  final ValueChanged<List<TradeFormEmploymentEntry>> onSave;

  @override
  State<TradeFormEmploymentPage> createState() =>
      TradeFormEmploymentPageState();
}

class TradeFormEmploymentPageState extends State<TradeFormEmploymentPage> {
  List<TradeFormEmploymentEntry> _entries = const <TradeFormEmploymentEntry>[];

  void save() => widget.onSave(_entries);

  void _add() {
    if (_entries.length >= kTradeFormMaxEmployers) return;
    setState(() => _entries = <TradeFormEmploymentEntry>[
          ..._entries,
          const TradeFormEmploymentEntry(employerName: '', roleLabel: ''),
        ]);
  }

  void _update(int index, TradeFormEmploymentEntry entry) {
    final List<TradeFormEmploymentEntry> next =
        List<TradeFormEmploymentEntry>.of(_entries);
    next[index] = entry;
    setState(() => _entries = next);
  }

  void _remove(int index) {
    final List<TradeFormEmploymentEntry> next =
        List<TradeFormEmploymentEntry>.of(_entries)..removeAt(index);
    setState(() => _entries = next);
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      ignoring: !widget.enabled,
      child: Opacity(
        opacity: widget.enabled ? 1 : 0.5,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(_kTitle, style: AppTypography.display(size: AppTypography.sizeLg)),
            const SizedBox(height: AppSpacing.s2),
            Text(_kSubtitle,
                style: AppTypography.body(
                    size: AppTypography.sizeSm, color: AppColors.textMuted)),
            const SizedBox(height: AppSpacing.s4),
            for (int i = 0; i < _entries.length; i++) ...<Widget>[
              _EmployerCard(
                key: ValueKey<int>(i),
                entry: _entries[i],
                onChanged: (TradeFormEmploymentEntry e) => _update(i, e),
                onRemove: () => _remove(i),
              ),
              const SizedBox(height: AppSpacing.s3),
            ],
            if (_entries.length < kTradeFormMaxEmployers)
              BbButton(
                label: _kAddEmployer,
                variant: BbButtonVariant.outline,
                size: BbButtonSize.md,
                iconLeft: Icons.add,
                block: true,
                onPressed: _add,
              ),
          ],
        ),
      ),
    );
  }
}

class _EmployerCard extends StatefulWidget {
  const _EmployerCard({
    super.key,
    required this.entry,
    required this.onChanged,
    required this.onRemove,
  });

  final TradeFormEmploymentEntry entry;
  final ValueChanged<TradeFormEmploymentEntry> onChanged;
  final VoidCallback onRemove;

  @override
  State<_EmployerCard> createState() => _EmployerCardState();
}

/// Returns -1, 0, or 1 for `a` before, equal, or after `b` in "YYYY-MM" order.
int _compareYearMonth(String? a, String? b) {
  if (a == null || b == null) return 0;
  final List<String> pa = a.split('-');
  final List<String> pb = b.split('-');
  if (pa.length != 2 || pb.length != 2) return 0;
  final int ya = int.tryParse(pa[0]) ?? 0;
  final int yb = int.tryParse(pb[0]) ?? 0;
  if (ya != yb) return ya.compareTo(yb);
  final int ma = int.tryParse(pa[1]) ?? 0;
  final int mb = int.tryParse(pb[1]) ?? 0;
  return ma.compareTo(mb);
}

class _EmployerCardState extends State<_EmployerCard> {
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

  late bool _stillWorking = widget.entry.endYm == null;

  @override
  void dispose() {
    _name.dispose();
    _role.dispose();
    _city.dispose();
    _state.dispose();
    _work.dispose();
    super.dispose();
  }

  void _push(TradeFormEmploymentEntry next) => widget.onChanged(next);

  @override
  Widget build(BuildContext context) {
    final TradeFormEmploymentEntry e = widget.entry;
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
          TradeFormTextField(
            controller: _name,
            hint: _kNameHint,
            label: _kNameLabel,
            onChanged: (String v) => _push(e.copyWith(employerName: v)),
          ),
          const SizedBox(height: AppSpacing.s3),
          _label(_kRoleLabel),
          TradeFormTextField(
            controller: _role,
            hint: _kRoleHint,
            label: _kRoleLabel,
            onChanged: (String v) => _push(e.copyWith(roleLabel: v)),
          ),
          const SizedBox(height: AppSpacing.s3),
          Row(
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    _label(_kCityLabel),
                    TradeFormTextField(
                      controller: _city,
                      hint: _kCityLabel,
                      label: _kCityLabel,
                      onChanged: (String v) => _push(e.copyWith(employerCity: v)),
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
                    TradeFormTextField(
                      controller: _state,
                      hint: _kStateLabel,
                      label: _kStateLabel,
                      textInputAction: TextInputAction.done,
                      onChanged: (String v) => _push(e.copyWith(employerState: v)),
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
            onPicked: (String? ym) {
              if (ym != null && e.endYm != null &&
                  _compareYearMonth(ym, e.endYm) > 0) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text(_kDateOrderError)),
                );
                return;
              }
              _push(e.copyWith(startYm: ym));
            },
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
              onPicked: (String? ym) {
                if (ym != null && e.startYm != null &&
                    _compareYearMonth(ym, e.startYm) < 0) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text(_kDateOrderError)),
                  );
                  return;
                }
                _push(e.copyWith(endYm: ym));
              },
            ),
          ],
          const SizedBox(height: AppSpacing.s3),
          _label(_kWorkLabel),
          TradeFormTextField(
            controller: _work,
            hint: _kWorkHint,
            label: _kWorkLabel,
            maxLength: _kWorkDoneMax,
            maxLines: 3,
            textInputAction: TextInputAction.newline,
            onChanged: (String v) => _push(e.copyWith(workDone: v)),
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

/// A month-precision date field, identical in behaviour to
/// `features/finishing`'s own `_YearMonthField` (a scoped duplicate — see
/// this file's class doc).
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
            const Icon(Icons.event_outlined, size: 20, color: AppColors.textMuted),
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
                child: const Icon(Icons.close, size: 18, color: AppColors.textMuted),
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

  /// A fixed span of recent years (newest first) — no wall-clock dependence.
  static const int _latestYear = 2026;
  static const int _span = 45;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter, AppSpacing.s5, AppSpacing.gutter, AppSpacing.s5),
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
                    BbChip(label: '$y', onTap: () => setState(() => _year = y)),
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
                      onTap: () => Navigator.of(context)
                          .pop('${_year!}-${m.toString().padLeft(2, '0')}'),
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}
