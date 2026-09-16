import 'package:flutter/material.dart';

import '../../../../core/api/api_models.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/bb_search_field.dart';
import '../../../../core/widgets/kit/kit_select_chip.dart';
import '../../../../core/widgets/onboarding/primary_action_button.dart';
import '../../domain/job_filter.dart';

/// Which [FilterSelection] dimension a filter chip belongs to.
///
/// Public, and it lives here with [JobFilterOption] because the SHEET owns the
/// filter vocabulary: the sheet offers the options and the feed shows the
/// active ones as removable chips. One vocabulary means the key a suggestion
/// chip carries in the sheet and the key its removable twin carries on the feed
/// can never drift apart.
enum JobFilterDim { trade, city, experience, shift, pay }

/// What a worker reads before the value on a REMOVABLE chip. Trade and city are
/// self-evident; experience, shift and pay are not ("2-5 yrs" alone could be
/// anything), so every active chip names its dimension.
const Map<JobFilterDim, String> kJobFilterDimPrefix = <JobFilterDim, String>{
  JobFilterDim.trade: 'Trade',
  JobFilterDim.city: 'City',
  JobFilterDim.experience: 'Experience',
  JobFilterDim.shift: 'Shift',
  JobFilterDim.pay: 'Pay',
};

/// One filter value: which [dim] it narrows, the [value] that dimension stores
/// (a trade label, a city name, an experience-band label, a shift WIRE value or
/// a pay-floor DISPLAY key) and the [label] a worker reads.
///
/// Presentation-only — it never crosses into `job_filter.dart`'s matching rules,
/// it just labels and keys the same values those rules already use.
@immutable
class JobFilterOption {
  const JobFilterOption({
    required this.dim,
    required this.value,
    required this.label,
  });

  final JobFilterDim dim;
  final String value;
  final String label;

  /// The removable chip's text on the feed — "Trade: VMC".
  String get chipLabel => '${kJobFilterDimPrefix[dim]}: $label';

  /// The chip inside the sheet.
  Key get suggestionKey => Key('jobFilterSuggestion_${dim.name}_$value');

  /// Its removable twin on the feed.
  Key get activeChipKey => Key('jobFilterChip_${dim.name}_$value');
}

/// Every filter currently applied, for the feed's removable-chip row.
///
/// Built straight from [filters] rather than from the loaded queue, so an active
/// city whose jobs have all drained still keeps a chip to clear it with — a
/// filter you cannot see is a filter you cannot clear.
List<JobFilterOption> activeJobFilters(FilterSelection filters) {
  final List<JobFilterOption> chips = <JobFilterOption>[
    for (final String trade in filters.trades)
      JobFilterOption(dim: JobFilterDim.trade, value: trade, label: trade),
    for (final String city in filters.cities)
      JobFilterOption(dim: JobFilterDim.city, value: city, label: city),
    for (final String band in filters.experienceBands)
      JobFilterOption(dim: JobFilterDim.experience, value: band, label: band),
  ];
  final String? shift = filters.shift;
  if (shift != null) {
    // The selection stores the WIRE value; the chip reads the display name.
    final String label = kShiftFilterLabels.entries
        .firstWhere(
          (MapEntry<String, String> e) => e.value == shift,
          orElse: () => MapEntry<String, String>(shift, shift),
        )
        .key;
    chips.add(
      JobFilterOption(dim: JobFilterDim.shift, value: shift, label: label),
    );
  }
  final int? payMin = filters.payMin;
  if (payMin != null) {
    final String label = kPayFloorOptions.entries
        .firstWhere(
          (MapEntry<String, int> e) => e.value == payMin,
          orElse: () => MapEntry<String, int>('₹$payMin+', payMin),
        )
        .key;
    chips.add(
      JobFilterOption(dim: JobFilterDim.pay, value: label, label: label),
    );
  }
  return chips;
}

/// [filters] with [option] removed — the inverse of picking it.
///
/// [FilterSelection.copyWith] cannot null out `shift`/`payMin` (by design — see
/// its own doc), so those two branches rebuild the selection directly.
FilterSelection withoutJobFilter(
  FilterSelection filters,
  JobFilterOption option,
) {
  switch (option.dim) {
    case JobFilterDim.trade:
      return filters.copyWith(
        trades: <String>{...filters.trades}..remove(option.value),
      );
    case JobFilterDim.city:
      return filters.copyWith(
        cities: <String>{...filters.cities}..remove(option.value),
      );
    case JobFilterDim.experience:
      return filters.copyWith(
        experienceBands: <String>{...filters.experienceBands}
          ..remove(option.value),
      );
    case JobFilterDim.shift:
      return FilterSelection(
        trades: filters.trades,
        cities: filters.cities,
        experienceBands: filters.experienceBands,
        payMin: filters.payMin,
      );
    case JobFilterDim.pay:
      return FilterSelection(
        trades: filters.trades,
        cities: filters.cities,
        experienceBands: filters.experienceBands,
        shift: filters.shift,
      );
  }
}

/// The "Filter jobs" bottom-sheet body (opened via `showBbBottomSheet` from the
/// Feed). Pops with the chosen [FilterSelection] — which lives in the DOMAIN
/// layer (`domain/job_filter.dart`), not here, so the sheet, the Feed's chip row
/// and the bloc all bind to ONE selection type.
///
/// Five groups, one per real filter dimension: Trade, City, Experience, Shift
/// and a pay floor. The live "Show N jobs" count is the REAL count over the
/// loaded queue across ALL dimensions (see [jobs]), so the number never
/// over-promises.
///
/// THE TYPED SEARCH LIVES HERE, not on the feed. It used to sit in the navy feed
/// header, where the field, up to eight suggestion chips and the active-chip row
/// stacked 190-430dp of chrome above the deck and squeezed the card off a
/// 320x568 screen. Here it narrows the option chips in place, the deck keeps its
/// height, and the feed keeps only the removable chips for what is applied.
///
/// The CTA is DOCKED below the scroll area: on a 568dp screen the sheet caps at
/// 80% of the height, and a CTA at the end of the scroll was something a worker
/// had to go looking for.
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
  /// Trade options are a fixed vocabulary — DERIVED from the keyword map that
  /// gives a label its meaning ([kTradeFilterKeywords]), in the same order, so
  /// the sheet can never offer a label nothing knows how to match. (Unlike
  /// cities, these are not derived from the queue.)
  static final List<String> _trades = kTradeFilterKeywords.keys.toList();

  late Set<String> _selectedTrades;
  late Set<String> _selectedCities;
  late Set<String> _selectedBands;

  /// Shift + pay floor are SINGLE-value (a job has one shift; the floor is one
  /// number), so they are held as a nullable value, not a set. null = not
  /// filtered. [_selectedShift] is the RAW wire value ('day'|'night'|'rotational').
  late String? _selectedShift;
  late int? _selectedPayMin;

  final TextEditingController _searchController = TextEditingController();
  String _query = '';

  /// City options DERIVED from the loaded queue's distinct cities — never a
  /// hardcoded list, which would invent options the feed cannot honour. The
  /// already-selected cities are unioned in so an active filter always keeps a
  /// chip to switch it off with, even once its jobs have drained from the queue.
  late final List<String> _cities = availableCities(
    widget.jobs,
    selected: widget.initial.cities,
  );

  @override
  void initState() {
    super.initState();
    _selectedTrades = <String>{...widget.initial.trades};
    _selectedCities = <String>{...widget.initial.cities};
    _selectedBands = <String>{...widget.initial.experienceBands};
    _selectedShift = widget.initial.shift;
    _selectedPayMin = widget.initial.payMin;
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  FilterSelection get _selection => FilterSelection(
    trades: _selectedTrades,
    cities: _selectedCities,
    experienceBands: _selectedBands,
    shift: _selectedShift,
    payMin: _selectedPayMin,
  );

  // The REAL count over the loaded queue, across ALL dimensions — so the number
  // is honest for every selection. An empty selection means "show all",
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

  /// Whether [option] survives the typed query. Matched against the dimension
  /// name too ("trade: vmc"), so typing "shift" surfaces every shift option —
  /// the same universe the old header search offered.
  bool _matches(JobFilterOption option) {
    final String q = _query.trim().toLowerCase();
    if (q.isEmpty) return true;
    return option.chipLabel.toLowerCase().contains(q);
  }

  @override
  Widget build(BuildContext context) {
    final List<Widget> groups = <Widget>[
      ..._group(
        'Trade',
        <JobFilterOption>[
          for (final String trade in _trades)
            JobFilterOption(
              dim: JobFilterDim.trade,
              value: trade,
              label: trade,
            ),
        ],
        isSelected: (JobFilterOption o) => _selectedTrades.contains(o.value),
        onTap: (JobFilterOption o) => _toggle(_selectedTrades, o.value),
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
        ..._group(
          'City',
          <JobFilterOption>[
            for (final String city in _cities)
              JobFilterOption(dim: JobFilterDim.city, value: city, label: city),
          ],
          isSelected: (JobFilterOption o) => _selectedCities.contains(o.value),
          onTap: (JobFilterOption o) => _toggle(_selectedCities, o.value),
        ),
      ..._group(
        'Experience',
        <JobFilterOption>[
          for (final String band in kExperienceBandLabels)
            JobFilterOption(
              dim: JobFilterDim.experience,
              value: band,
              label: band,
            ),
        ],
        isSelected: (JobFilterOption o) => _selectedBands.contains(o.value),
        onTap: (JobFilterOption o) => _toggle(_selectedBands, o.value),
      ),
      // Shift + pay are single-select (a job has one shift; the floor is one
      // number). Both are REAL `/feed` fields now (ADR-0024 addendum) — the
      // chosen values narrow the deck client-side AND ride GET /feed.
      ..._group(
        'Shift',
        <JobFilterOption>[
          for (final MapEntry<String, String> e in kShiftFilterLabels.entries)
            JobFilterOption(
              dim: JobFilterDim.shift,
              value: e.value,
              label: e.key,
            ),
        ],
        isSelected: (JobFilterOption o) => _selectedShift == o.value,
        onTap: (JobFilterOption o) => _selectShift(o.value),
      ),
      ..._group(
        'Minimum pay',
        <JobFilterOption>[
          for (final String label in kPayFloorOptions.keys)
            JobFilterOption(dim: JobFilterDim.pay, value: label, label: label),
        ],
        isSelected: (JobFilterOption o) =>
            _selectedPayMin == kPayFloorOptions[o.value],
        onTap: (JobFilterOption o) => _selectPayMin(kPayFloorOptions[o.value]!),
      ),
    ];

    return SizedBox(
      width: double.infinity,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text('Filter jobs', style: OnboardingTypography.questionHeadline()),
          const SizedBox(height: 12),
          BbSearchField(
            fieldKey: const Key('jobFilterSearchField'),
            controller: _searchController,
            label: 'Filter search karein',
            hint: 'Trade, city, shift, pay dhoondein',
            onChanged: (String v) => setState(() => _query = v),
          ),
          const SizedBox(height: 14),
          // Flexible, not Expanded: on a tall screen the sheet still sizes to
          // its content; on a short one the option list shrinks and scrolls
          // while the CTA below stays put.
          Flexible(
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: groups,
              ),
            ),
          ),
          _footer(context),
        ],
      ),
    );
  }

  /// One labelled group of chips, or NOTHING when the query filtered every
  /// option out of it — a group label over an empty space reads as broken.
  List<Widget> _group(
    String label,
    List<JobFilterOption> options, {
    required bool Function(JobFilterOption) isSelected,
    required void Function(JobFilterOption) onTap,
  }) {
    final List<JobFilterOption> visible = options.where(_matches).toList();
    if (visible.isEmpty) return const <Widget>[];
    return <Widget>[
      Padding(
        padding: const EdgeInsets.only(bottom: 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              label.toUpperCase(),
              style: OnboardingTypography.fieldMicroLabel(),
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                for (final JobFilterOption option in visible)
                  KitSelectChip(
                    key: option.suggestionKey,
                    label: option.label,
                    selected: isSelected(option),
                    onTap: () => onTap(option),
                  ),
              ],
            ),
          ],
        ),
      ),
    ];
  }

  /// The docked CTA. A hairline and its own top padding rather than a
  /// [KitDockedBar]: the sheet already owns the side gutter and the safe-area
  /// inset, and a bar inside a modal would publish a bottom-bar inset for the
  /// page underneath it.
  Widget _footer(BuildContext context) {
    return Container(
      padding: const EdgeInsets.only(top: 12),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: OnboardingColors.borderDefault)),
      ),
      child: PrimaryActionButton(
        label: 'Show $_count jobs',
        showArrow: false,
        onPressed: () => Navigator.of(context).pop(_selection),
      ),
    );
  }
}
