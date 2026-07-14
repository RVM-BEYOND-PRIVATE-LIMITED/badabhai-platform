import 'package:flutter/material.dart';

import '../../../../core/api/api_models.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../domain/job_filter.dart';

/// The Feed filter selection (spec §5.7). Session-only — persistence (saved
/// filters) is a follow-up. Trades are multi-select; shift is single-select.
///
/// NOTE: there is deliberately NO distance/location field. The alpha feed is
/// LIBERAL — the backend returns every open job with no location filter — so a
/// distance chip would filter nothing and falsely imply location filtering. See
/// the TODO(location) marker in the sheet body and the LOCATION SEAM in
/// `ApplicationsRepository.findOpenJobs` for where it re-lands later.
class FilterSelection {
  const FilterSelection({
    required this.trades,
    required this.shift,
  });

  final Set<String> trades;
  final String shift;

  /// Default filter state = NO trade filter (empty). The alpha feed is LIBERAL —
  /// every open job shows until the worker actively narrows by trade — so the
  /// default must be "show all", not a pre-selected trade set. Keeping trades
  /// empty here stays in lock-step with the bloc's initial `tradeFilter` (also
  /// empty): the sheet never pre-selects trades the deck isn't actually narrowed
  /// to, so a no-op "Show jobs" apply can't silently drop jobs. Shift defaults to Day.
  static const FilterSelection initial = FilterSelection(
    trades: <String>{},
    shift: 'Day',
  );

  FilterSelection copyWith({
    Set<String>? trades,
    String? shift,
  }) {
    return FilterSelection(
      trades: trades ?? this.trades,
      shift: shift ?? this.shift,
    );
  }
}

/// The "Filter jobs" bottom-sheet body (opened via `showBbBottomSheet` from the
/// Feed). Pops with the chosen [FilterSelection]; the live "Show N jobs" count
/// is the REAL trade-filtered count over the loaded queue (see [jobs]).
class FiltersSheet extends StatefulWidget {
  const FiltersSheet({
    super.key,
    required this.initial,
    this.jobs = const <FeedItem>[],
  });

  final FilterSelection initial;

  /// The loaded feed queue, so "Show N jobs" reflects the REAL trade-filtered
  /// count (not a mock). Defaults to empty for isolated widget tests.
  final List<FeedItem> jobs;

  @override
  State<FiltersSheet> createState() => _FiltersSheetState();
}

class _FiltersSheetState extends State<FiltersSheet> {
  static const List<String> _trades = <String>[
    'CNC',
    'VMC',
    'Welder',
    'Fitter',
    'QC'
  ];
  static const List<String> _shifts = <String>['Day', 'Night', 'Rotational'];

  late Set<String> _selectedTrades;
  late String _shift;

  @override
  void initState() {
    super.initState();
    _selectedTrades = <String>{...widget.initial.trades};
    _shift = widget.initial.shift;
  }

  // Real count over the loaded queue: the trade filter is what actually narrows
  // the feed (shift is display-only; there is no location filter yet). An empty
  // trade selection means "show all" — matching the feed's no-filter semantics.
  int get _count => applyTradeFilter(widget.jobs, _selectedTrades).length;

  void _toggleTrade(String t) {
    setState(() => _selectedTrades.contains(t)
        ? _selectedTrades.remove(t)
        : _selectedTrades.add(t));
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
            Wrap(
              spacing: AppSpacing.s2,
              runSpacing: AppSpacing.s2,
              children: <Widget>[
                for (final String t in _trades)
                  BbChip(
                    label: t,
                    selected: _selectedTrades.contains(t),
                    onTap: () => _toggleTrade(t),
                  ),
              ],
            ),
          ),
          // TODO(location): re-add a location/distance filter when the location
          // feature lands. Removed for the alpha because the feed is LIBERAL (no
          // location filter) — a distance chip filtered nothing and misled the
          // worker. Pairs with the LOCATION SEAM in
          // ApplicationsRepository.findOpenJobs. Location is PII (§2/§6) → it
          // needs a location plugin + runtime permission + DPDP consent first.
          _group(
            'Shift',
            Wrap(
              spacing: AppSpacing.s2,
              runSpacing: AppSpacing.s2,
              children: <Widget>[
                for (final String s in _shifts)
                  BbChip(
                    label: s,
                    selected: _shift == s,
                    onTap: () => setState(() => _shift = s),
                  ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.s5),
          BbButton(
            label: 'Show $_count jobs',
            block: true,
            onPressed: () => Navigator.of(context).pop(
              FilterSelection(
                trades: _selectedTrades,
                shift: _shift,
              ),
            ),
          ),
        ],
      ),
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
