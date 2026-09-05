import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../../../core/widgets/bb_searchable_dropdown_field.dart';
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
const String _kPickStateLabel = 'STATE CHUNEIN';
const String _kPickCityLabel = 'SHEHER CHUNEIN';
const String _kManualEntryLink = 'Khud likhein';
const String _kBackToPickerLink = 'List se chunein';

/// TEMPORARY demo data (#1429 — the real state-tagged city gazetteer isn't
/// built yet, KP). Exactly 2 states, 2 cities each, as asked, so this flow
/// can be shown/demoed before the real backend dataset exists. Delete this
/// map (and [_EmployerLocationPicker]'s picker branch) once #1429 lands and
/// wire the real options through instead — [employerCity]/[employerState]
/// stay plain strings on the wire either way, so nothing downstream changes.
const Map<String, List<String>> _kDemoEmployerStateCities =
    <String, List<String>>{
      'Haryana': <String>['Gurugram', 'Faridabad'],
      'Maharashtra': <String>['Mumbai', 'Pune'],
    };
const String _kStartLabel = 'Kab shuru kiya';
const String _kEndLabel = 'Kab tak';
const String _kStillWorking = 'Abhi yahin kaam kar rahe hain';
const String _kWorkLabel = 'Aap kya kaam karte the?';
// Trade-neutral (#1382). Duplicated verbatim in
// `finishing/employer_card.dart`; keep both in sync if this ever changes.
const String _kWorkHint =
    'Jaise: Naye parts banate the aur quality check karte the';
const String _kNotStated = 'Nahi bataya';
const String _kPickYear = 'Saal chunein';
const String _kPickMonth = 'Mahina chunein';
const int _kWorkDoneMax = 300;
const String _kDateOrderError =
    'Khatam hone ki date shuru hone ke baad honi chahiye.';

const List<String> _kMonths = <String>[
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// The `type: "employment"` marker screen (#1341) — the repeat-card work
/// history `PUT /workers/me/employment` owns. Same flat single-role shape
/// `features/finishing` sends today; #1341 notes the endpoint now also
/// accepts nested `roles[]`, which is a follow-up, not a blocker (see
/// `trade_form_models.dart`'s doc on this file's deliberate duplication).
///
/// #1384 item 2 — paginated INTERNALLY, one employer per page, rather than
/// all up to [kTradeFormMaxEmployers] cards stacked on one scroll. A worker
/// with zero employers still gets exactly ONE page (title + the "add" outline
/// button, no card) — the same thing this widget rendered before pagination
/// when [_entries] was empty, so skipping employment entirely needs no more
/// taps than it did before.
class TradeFormEmploymentPage extends StatefulWidget {
  const TradeFormEmploymentPage({
    super.key,
    required this.enabled,
    required this.onSave,
    this.initialEntries,
    this.onPageChanged,
  });

  final bool enabled;
  final ValueChanged<List<TradeFormEmploymentEntry>> onSave;

  /// The cubit's own memory of the last successful save for THIS marker
  /// (#1384 item 1, `TradeFormState.savedEmployment`) — see the doc on
  /// `TradeFormPreferencesPage.initialPreferences` for why a `GlobalKey`
  /// alone cannot carry this across a `goBack()`.
  final List<TradeFormEmploymentEntry>? initialEntries;

  /// #1384 item 2 — see `TradeFormPreferencesPage.onPageChanged`'s doc; the
  /// same contract, reported here off [pageCount] (which — unlike
  /// preferences' fixed 4 — changes at runtime as employer cards are
  /// added/removed).
  final void Function(int page, int pageCount)? onPageChanged;

  @override
  State<TradeFormEmploymentPage> createState() =>
      TradeFormEmploymentPageState();
}

class TradeFormEmploymentPageState extends State<TradeFormEmploymentPage> {
  late List<TradeFormEmploymentEntry> _entries =
      List<TradeFormEmploymentEntry>.of(
        widget.initialEntries ?? const <TradeFormEmploymentEntry>[],
      );

  int _page = 0;

  /// At least 1 (an empty-employer "add or skip" page) — never 0, so there
  /// is always exactly one page to render even with no employers yet.
  int get pageCount => _entries.isEmpty ? 1 : _entries.length;
  bool get isFirstPage => _page <= 0;
  bool get isLastPage => _page >= pageCount - 1;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      widget.onPageChanged?.call(_page, pageCount);
    });
  }

  /// Called by the screen's sticky bottom bar ONLY on this marker's LAST
  /// internal page — see `_WizardScaffoldState`'s routing.
  void save() => widget.onSave(_entries);

  /// Always null: the year/month fields here come from a bounded PICKER
  /// SHEET (`_YearMonthSheet`), not free text, so an invalid or future date
  /// cannot be entered in the first place — nothing to block. Present only
  /// so `_WizardScaffoldState` can check every marker's validity the same
  /// way; see `TradeFormPreferencesPageState.currentPageError`'s doc for
  /// why this check exists at all.
  String? currentPageError() => null;

  void goToNextPage() {
    if (isLastPage) return;
    setState(() => _page += 1);
    widget.onPageChanged?.call(_page, pageCount);
  }

  void goToPreviousPage() {
    if (isFirstPage) return;
    setState(() => _page -= 1);
    widget.onPageChanged?.call(_page, pageCount);
  }

  void _add() {
    if (_entries.length >= kTradeFormMaxEmployers) return;
    setState(() {
      _entries = <TradeFormEmploymentEntry>[
        ..._entries,
        const TradeFormEmploymentEntry(employerName: '', roleLabel: ''),
      ];
      _page = _entries.length - 1; // land on the newly-added card
    });
    widget.onPageChanged?.call(_page, pageCount);
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
    setState(() {
      _entries = next;
      final int maxPage = pageCount - 1; // recomputed off the NEW _entries
      if (_page > maxPage) _page = maxPage;
    });
    widget.onPageChanged?.call(_page, pageCount);
  }

  @override
  Widget build(BuildContext context) {
    final List<Widget> children = <Widget>[];
    if (_page == 0) {
      children.addAll(<Widget>[
        Text(_kTitle, style: AppTypography.display(size: AppTypography.sizeLg)),
        const SizedBox(height: AppSpacing.s2),
        Text(
          _kSubtitle,
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            color: AppColors.textMuted,
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
      ]);
    }
    if (_entries.isNotEmpty) {
      final int i = _page;
      children.add(
        _EmployerCard(
          key: ValueKey<int>(i),
          entry: _entries[i],
          onChanged: (TradeFormEmploymentEntry e) => _update(i, e),
          onRemove: () => _remove(i),
        ),
      );
    }
    if (isLastPage && _entries.length < kTradeFormMaxEmployers) {
      if (_entries.isNotEmpty) {
        children.add(const SizedBox(height: AppSpacing.s3));
      }
      children.add(
        BbButton(
          label: _kAddEmployer,
          variant: BbButtonVariant.outline,
          size: BbButtonSize.md,
          iconLeft: Icons.add,
          block: true,
          onPressed: _add,
        ),
      );
    }
    return IgnorePointer(
      ignoring: !widget.enabled,
      child: Opacity(
        opacity: widget.enabled ? 1 : 0.5,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: children,
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
  late final TextEditingController _name = TextEditingController(
    text: widget.entry.employerName,
  );
  late final TextEditingController _role = TextEditingController(
    text: widget.entry.roleLabel,
  );
  late final TextEditingController _work = TextEditingController(
    text: widget.entry.workDone ?? '',
  );

  late bool _stillWorking = widget.entry.endYm == null;

  @override
  void dispose() {
    _name.dispose();
    _role.dispose();
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
              icon: const Icon(
                Icons.close,
                size: 20,
                color: AppColors.textMuted,
              ),
              tooltip: 'Hataayein',
              constraints: const BoxConstraints(
                minWidth: AppSpacing.tap,
                minHeight: 32,
              ),
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
          _EmployerLocationPicker(
            initialCity: e.employerCity,
            initialState: e.employerState,
            onChanged: (String? city, String? state) =>
                _push(e.copyWith(employerCity: city, employerState: state)),
          ),
          const SizedBox(height: AppSpacing.s3),
          _label(_kStartLabel),
          _YearMonthField(
            value: e.startYm,
            onPicked: (String? ym) {
              if (ym != null &&
                  e.endYm != null &&
                  _compareYearMonth(ym, e.endYm) > 0) {
                ScaffoldMessenger.of(
                  context,
                ).showSnackBar(const SnackBar(content: Text(_kDateOrderError)));
                return;
              }
              _push(e.copyWith(startYm: ym));
            },
          ),
          const SizedBox(height: AppSpacing.s3),
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  _kStillWorking,
                  style: AppTypography.body(size: AppTypography.sizeSm),
                ),
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
                if (ym != null &&
                    e.startYm != null &&
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
    child: Text(
      text,
      style: AppTypography.body(
        size: AppTypography.sizeSm,
        weight: FontWeight.w700,
      ),
    ),
  );
}

/// Employer city/state — a two-step "pick state, then pick a city filtered
/// to it" picker, backed by [_kDemoEmployerStateCities], with a "Khud
/// likhein" fallback to the ORIGINAL free-text fields so a real employer
/// outside the 2-state demo set is never unenterable. TEMPORARY: once #1429
/// ships the real backend dataset, replace the demo map with the real
/// options and delete the manual-fallback toggle (or keep it — that's the
/// call to make then, not now).
class _EmployerLocationPicker extends StatefulWidget {
  const _EmployerLocationPicker({
    required this.initialCity,
    required this.initialState,
    required this.onChanged,
  });

  final String? initialCity;
  final String? initialState;

  /// Fires on every change, city and state independently nullable — mirrors
  /// the two free-text fields this replaces (either can be filled alone).
  final void Function(String? city, String? state) onChanged;

  @override
  State<_EmployerLocationPicker> createState() =>
      _EmployerLocationPickerState();
}

class _EmployerLocationPickerState extends State<_EmployerLocationPicker> {
  late bool _manual;
  String? _pickedState;
  late final TextEditingController _cityController = TextEditingController(
    text: widget.initialCity ?? '',
  );
  late final TextEditingController _stateController = TextEditingController(
    text: widget.initialState ?? '',
  );

  @override
  void initState() {
    super.initState();
    _manual = !_matchesDemoData(widget.initialCity, widget.initialState);
    _pickedState = _kDemoEmployerStateCities.containsKey(widget.initialState)
        ? widget.initialState
        : null;
  }

  /// True for a BLANK entry (nothing typed yet — default to the picker, the
  /// preferred path) or a value that already matches the demo set. False for
  /// pre-existing free text that doesn't match it — that data is preserved
  /// via the manual fields rather than silently hidden.
  static bool _matchesDemoData(String? city, String? state) {
    if ((city == null || city.isEmpty) && (state == null || state.isEmpty)) {
      return true;
    }
    final List<String>? cities = _kDemoEmployerStateCities[state];
    return cities != null && cities.contains(city);
  }

  @override
  void dispose() {
    _cityController.dispose();
    _stateController.dispose();
    super.dispose();
  }

  void _pickState(String state) {
    setState(() {
      _pickedState = state;
      _cityController.clear();
    });
    widget.onChanged(null, state);
  }

  void _pickCity(String city) {
    _cityController.text = city;
    setState(() {});
    widget.onChanged(city, _pickedState);
  }

  void _switchToManual() {
    setState(() {
      _manual = true;
      _cityController.text = widget.initialCity ?? _cityController.text;
      _stateController.text = widget.initialState ?? _stateController.text;
    });
  }

  void _switchToPicker() {
    setState(() {
      _manual = false;
      _pickedState = null;
      _cityController.clear();
    });
    widget.onChanged(null, null);
  }

  @override
  Widget build(BuildContext context) {
    if (_manual) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    _fieldLabel(_kCityLabel),
                    TradeFormTextField(
                      controller: _cityController,
                      hint: _kCityLabel,
                      label: _kCityLabel,
                      onChanged: (String v) =>
                          widget.onChanged(v, _stateController.text),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    _fieldLabel(_kStateLabel),
                    TradeFormTextField(
                      controller: _stateController,
                      hint: _kStateLabel,
                      label: _kStateLabel,
                      textInputAction: TextInputAction.done,
                      onChanged: (String v) =>
                          widget.onChanged(_cityController.text, v),
                    ),
                  ],
                ),
              ),
            ],
          ),
          TextButton(
            onPressed: _switchToPicker,
            child: const Text(_kBackToPickerLink),
          ),
        ],
      );
    }

    final List<String> cities =
        _kDemoEmployerStateCities[_pickedState] ?? const <String>[];
    final String? cityValue = _cityController.text.isEmpty ? null : _cityController.text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  _fieldLabel(_kStateLabel),
                  BbSearchableDropdownField(
                    placeholder: _kPickStateLabel,
                    options: _kDemoEmployerStateCities.keys.toList(),
                    selected: _pickedState,
                    onSelected: _pickState,
                  ),
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.s2),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  _fieldLabel(_kCityLabel),
                  BbSearchableDropdownField(
                    placeholder: _kPickCityLabel,
                    options: cities,
                    selected: cityValue,
                    enabled: _pickedState != null,
                    onSelected: _pickCity,
                  ),
                ],
              ),
            ),
          ],
        ),
        TextButton(
          onPressed: _switchToManual,
          child: const Text(_kManualEntryLink),
        ),
      ],
    );
  }

  Widget _fieldLabel(String text) => Padding(
    padding: const EdgeInsets.only(bottom: AppSpacing.s1),
    child: Text(
      text,
      style: AppTypography.body(
        size: AppTypography.sizeSm,
        weight: FontWeight.w700,
      ),
    ),
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
    final String month = (m != null && m >= 1 && m <= 12)
        ? _kMonths[m - 1]
        : parts[1];
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
          horizontal: AppSpacing.s3,
          vertical: AppSpacing.s3,
        ),
        decoration: BoxDecoration(
          color: AppColors.surfaceCard,
          borderRadius: BorderRadius.circular(AppRadii.md),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        child: Row(
          children: <Widget>[
            const Icon(
              Icons.event_outlined,
              size: 20,
              color: AppColors.textMuted,
            ),
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
                child: const Icon(
                  Icons.close,
                  size: 18,
                  color: AppColors.textMuted,
                ),
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
          AppSpacing.gutter,
          AppSpacing.s5,
          AppSpacing.gutter,
          AppSpacing.s5,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              _year == null ? _kPickYear : _kPickMonth,
              style: AppTypography.display(size: AppTypography.sizeLg),
            ),
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
                      onTap: () => Navigator.of(
                        context,
                      ).pop('${_year!}-${m.toString().padLeft(2, '0')}'),
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}
