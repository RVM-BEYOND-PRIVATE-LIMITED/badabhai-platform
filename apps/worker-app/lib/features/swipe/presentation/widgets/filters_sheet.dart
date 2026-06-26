import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_chip.dart';

/// The Feed filter selection (spec §5.7). Session-only — persistence (saved
/// filters) is a follow-up. Trades are multi-select; distance + shift single.
class FilterSelection {
  const FilterSelection({
    required this.trades,
    required this.distance,
    required this.shift,
  });

  final Set<String> trades;
  final String distance;
  final String shift;

  /// Spec defaults: CNC + VMC, 15 km, Day.
  static const FilterSelection initial = FilterSelection(
    trades: <String>{'CNC', 'VMC'},
    distance: '15 km',
    shift: 'Day',
  );

  FilterSelection copyWith({
    Set<String>? trades,
    String? distance,
    String? shift,
  }) {
    return FilterSelection(
      trades: trades ?? this.trades,
      distance: distance ?? this.distance,
      shift: shift ?? this.shift,
    );
  }
}

/// The "Filter jobs" bottom-sheet body (opened via `showBbBottomSheet` from the
/// Feed). Pops with the chosen [FilterSelection]; the live "Show N jobs" count
/// is a MOCK figure for the alpha (real filtered-feed query is a follow-up).
class FiltersSheet extends StatefulWidget {
  const FiltersSheet({super.key, required this.initial});

  final FilterSelection initial;

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
  static const List<String> _distances = <String>['5 km', '15 km', '30 km'];
  static const List<String> _shifts = <String>['Day', 'Night', 'Rotational'];

  late Set<String> _selectedTrades;
  late String _distance;
  late String _shift;

  @override
  void initState() {
    super.initState();
    _selectedTrades = <String>{...widget.initial.trades};
    _distance = widget.initial.distance;
    _shift = widget.initial.shift;
  }

  // MOCK count — a plausible figure that reacts to the selection. The real
  // filtered-feed query is a follow-up (§7).
  int get _count {
    if (_selectedTrades.isEmpty) return 0;
    final int base = 6 * _selectedTrades.length;
    final int byDistance = switch (_distance) {
      '30 km' => 8,
      '15 km' => 4,
      _ => 0,
    };
    return (base + byDistance).clamp(0, 99);
  }

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
          _group(
            'Distance',
            Wrap(
              spacing: AppSpacing.s2,
              runSpacing: AppSpacing.s2,
              children: <Widget>[
                for (final String d in _distances)
                  BbChip(
                    label: d,
                    selected: _distance == d,
                    onTap: () => setState(() => _distance = d),
                  ),
              ],
            ),
          ),
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
                distance: _distance,
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
