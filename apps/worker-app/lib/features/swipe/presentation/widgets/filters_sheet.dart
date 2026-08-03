import 'package:flutter/material.dart';

import '../../../../core/api/api_models.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../domain/job_filter.dart';

/// The "Filter jobs" bottom-sheet body (opened via `showBbBottomSheet` from the
/// Feed). Pops with the chosen [FilterSelection] — which lives in the DOMAIN
/// layer (`domain/job_filter.dart`), not here, so the sheet, the Feed's chip row
/// and the bloc all bind to ONE selection type.
///
/// Three groups, one per real filter dimension: Trade, City, Experience. The
/// live "Show N jobs" count is the REAL count over the loaded queue across ALL
/// THREE dimensions (see [jobs]), so the number never over-promises.
class FiltersSheet extends StatefulWidget {
  const FiltersSheet({
    super.key,
    required this.initial,
    this.jobs = const <FeedItem>[],
  });

  final FilterSelection initial;

  /// The loaded feed queue. Two jobs here: it makes "Show N jobs" the REAL
  /// filtered count (not a mock), and it DERIVES the City options — a city the
  /// queue doesn't contain is never offered. Defaults to empty for isolated
  /// widget tests.
  final List<FeedItem> jobs;

  @override
  State<FiltersSheet> createState() => _FiltersSheetState();
}

class _FiltersSheetState extends State<FiltersSheet> {
  /// Trade options are a fixed vocabulary — the labels [kTradeFilterKeywords]
  /// knows how to match. (Unlike cities, these are not derived: the keyword map
  /// is what gives a label meaning, so an underived label could not match.)
  static const List<String> _trades = <String>[
    'CNC',
    'VMC',
    'Welder',
    'Fitter',
    'QC'
  ];

  late Set<String> _selectedTrades;
  late Set<String> _selectedCities;
  late Set<String> _selectedBands;

  /// Shift + pay floor are SINGLE-value (a job has one shift; the floor is one
  /// number), so they are held as a nullable value, not a set. null = not
  /// filtered. [_selectedShift] is the RAW wire value ('day'|'night'|'rotational').
  late String? _selectedShift;
  late int? _selectedPayMin;

  /// City options DERIVED from the loaded queue's distinct cities — never a
  /// hardcoded list, which would invent options the feed cannot honour. The
  /// already-selected cities are unioned in so an active filter always keeps a
  /// chip to switch it off with, even once its jobs have drained from the queue.
  late final List<String> _cities =
      availableCities(widget.jobs, selected: widget.initial.cities);

  @override
  void initState() {
    super.initState();
    _selectedTrades = <String>{...widget.initial.trades};
    _selectedCities = <String>{...widget.initial.cities};
    _selectedBands = <String>{...widget.initial.experienceBands};
    _selectedShift = widget.initial.shift;
    _selectedPayMin = widget.initial.payMin;
  }

  FilterSelection get _selection => FilterSelection(
        trades: _selectedTrades,
        cities: _selectedCities,
        experienceBands: _selectedBands,
        shift: _selectedShift,
        payMin: _selectedPayMin,
      );

  // The REAL count over the loaded queue, across ALL THREE dimensions — so the
  // number is honest for every selection. An empty selection means "show all",
  // matching the feed's no-filter semantics.
  int get _count => applyJobFilters(widget.jobs, _selection).length;

  void _toggle(Set<String> set, String value) {
    setState(() => set.contains(value) ? set.remove(value) : set.add(value));
  }

  /// Single-select toggles: tapping the active chip clears the filter (back to
  /// "any"), tapping another switches to it. [wire] is already the raw wire value.
  void _selectShift(String wire) {
    setState(() => _selectedShift = _selectedShift == wire ? null : wire);
  }

  void _selectPayMin(int value) {
    setState(() => _selectedPayMin = _selectedPayMin == value ? null : value);
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text('Filter jobs',
              style: AppTypography.display(
                  size: AppTypography.sizeLg, weight: FontWeight.w800)),
          const SizedBox(height: AppSpacing.s4),
          _group(
            'Trade',
            _chipWrap(
              options: _trades,
              isSelected: _selectedTrades.contains,
              onTap: (String t) => _toggle(_selectedTrades, t),
            ),
          ),
          // TODO(location): re-add a location/distance filter when the location
          // feature lands. Removed for the alpha because the feed is LIBERAL (no
          // location filter) — a distance chip filtered nothing and misled the
          // worker. City below is the honest location control. Pairs with the
          // LOCATION SEAM in ApplicationsRepository.findOpenJobs. Location is PII
          // (§2/§6) → it needs a location plugin + runtime permission + DPDP
          // consent first.
          // Omitted entirely (not rendered empty) when the queue yields no
          // cities: an empty group reads as a broken filter.
          if (_cities.isNotEmpty)
            _group(
              'City',
              _chipWrap(
                options: _cities,
                isSelected: _selectedCities.contains,
                onTap: (String c) => _toggle(_selectedCities, c),
              ),
            ),
          _group(
            'Experience',
            _chipWrap(
              options: kExperienceBandLabels,
              isSelected: _selectedBands.contains,
              onTap: (String b) => _toggle(_selectedBands, b),
            ),
          ),
          // Shift + pay are single-select (a job has one shift; the floor is one
          // number). Both are REAL `/feed` fields now (ADR-0024 addendum) — the
          // chosen values narrow the deck client-side AND ride GET /feed.
          _group(
            'Shift',
            _chipWrap(
              options: kShiftFilterLabels.keys.toList(),
              isSelected: (String label) =>
                  _selectedShift == kShiftFilterLabels[label],
              onTap: (String label) => _selectShift(kShiftFilterLabels[label]!),
            ),
          ),
          _group(
            'Minimum pay',
            _chipWrap(
              options: kPayFloorOptions.keys.toList(),
              isSelected: (String label) =>
                  _selectedPayMin == kPayFloorOptions[label],
              onTap: (String label) => _selectPayMin(kPayFloorOptions[label]!),
            ),
          ),
          const SizedBox(height: AppSpacing.s5),
          BbButton(
            label: 'Show $_count jobs',
            block: true,
            onPressed: () => Navigator.of(context).pop(_selection),
          ),
        ],
      ),
    );
  }

  Widget _chipWrap({
    required List<String> options,
    required bool Function(String) isSelected,
    required void Function(String) onTap,
  }) {
    return Wrap(
      spacing: AppSpacing.s2,
      runSpacing: AppSpacing.s2,
      children: <Widget>[
        for (final String option in options)
          BbChip(
            label: option,
            selected: isSelected(option),
            onTap: () => onTap(option),
          ),
      ],
    );
  }

  Widget _group(String label, Widget body) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.s5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(label.toUpperCase(),
              style: AppTypography.body(
                  size: AppTypography.sizeXs,
                  weight: FontWeight.w700,
                  color: AppColors.textMuted)),
          const SizedBox(height: AppSpacing.s2),
          body,
        ],
      ),
    );
  }
}
