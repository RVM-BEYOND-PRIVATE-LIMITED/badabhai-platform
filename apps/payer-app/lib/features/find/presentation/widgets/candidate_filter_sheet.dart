import 'package:flutter/material.dart';

import '../../../../core/data/candidate_search_models.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_motion.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../../../core/widgets/bb_field.dart';
import '../../../../core/widgets/bb_searchable_dropdown_field.dart';

/// Opens the all-candidates filter sheet over [filters], starting from
/// [current]. Resolves to the query to run, or null when dismissed.
Future<CandidateSearchQuery?> showCandidateFilterSheet(
  BuildContext context, {
  required CandidateFilters filters,
  required CandidateSearchQuery current,
}) {
  return showModalBottomSheet<CandidateSearchQuery>(
    context: context,
    sheetAnimationStyle: AppMotion.sheetStyle(context),
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    backgroundColor: AppColors.surfaceCard,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadii.xxl)),
    ),
    builder: (_) => CandidateFilterSheet(filters: filters, initial: current),
  );
}

/// The FULL filter set (owner rulings 2026-11-03): Role, Years in role,
/// Industry, Years in industry, City, and the explicit opt-in "Only show
/// matches". Every option comes from `GET /payer/candidates/filters` — the app
/// keeps no copy of the vocabulary. One Role at most (a single select).
///
/// #2593 — the Role list is long, so it is SEARCHABLE (the worker app's
/// dropdown, ported: [BbSearchableDropdownField]); and the "Show candidates"
/// row clears the system gesture bar instead of sitting under it.
///
/// Filters REORDER by default — matches lead, nobody is removed — so the
/// strict switch says plainly what it does, and that an unrecorded detail never
/// hides anyone (ADR-0040 Decisions 1, 2 and 4). It is off unless the payer
/// turns it on, and it does nothing without a filter.
class CandidateFilterSheet extends StatefulWidget {
  const CandidateFilterSheet({
    super.key,
    required this.filters,
    required this.initial,
  });

  final CandidateFilters filters;
  final CandidateSearchQuery initial;

  @override
  State<CandidateFilterSheet> createState() => _CandidateFilterSheetState();
}

class _CandidateFilterSheetState extends State<CandidateFilterSheet> {
  late String? _role =
      widget.initial.skillIds.isEmpty ? null : widget.initial.skillIds.first;
  late String? _experience = widget.initial.experience;
  late String? _industry = widget.initial.industryId;
  late String? _industryExperience = widget.initial.industryExperience;
  late String? _city = widget.initial.city;
  late bool _strict = widget.initial.strict;

  bool get _anyFilter =>
      _role != null ||
      _experience != null ||
      _industry != null ||
      _industryExperience != null ||
      _city != null;

  CandidateSearchQuery get _query => CandidateSearchQuery(
        skillIds: _role == null ? const <String>[] : <String>[_role!],
        experience: _experience,
        industryId: _industry,
        industryExperience: _industryExperience,
        city: _city,
        strict: _anyFilter && _strict,
      );

  void _clearAll() => setState(() {
        _role = null;
        _experience = null;
        _industry = null;
        _industryExperience = null;
        _city = null;
        _strict = false;
      });

  @override
  Widget build(BuildContext context) {
    final CandidateFilters f = widget.filters;
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.88,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.gutter,
              0,
              AppSpacing.s2,
              AppSpacing.s2,
            ),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    'Filter candidates',
                    style: AppTypography.heading(size: AppTypography.sizeLg),
                  ),
                ),
                BbButton(
                  key: const Key('filters_clear_all'),
                  label: 'Clear all',
                  variant: BbButtonVariant.ghost,
                  size: BbButtonSize.sm,
                  onPressed: _anyFilter || _strict ? _clearAll : null,
                ),
              ],
            ),
          ),
          Flexible(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.gutter,
                0,
                AppSpacing.gutter,
                AppSpacing.s4,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  _OptionSelect(
                    key: const Key('filter_role'),
                    label: 'Role',
                    anyLabel: 'Any role',
                    searchHint: 'Search roles',
                    emptyHint: 'No role matches. Try another word.',
                    value: _role,
                    options: <LabelledId>[
                      for (final CandidateRoleOption r in f.roles)
                        LabelledId(id: r.id, label: r.label),
                    ],
                    onChanged: (String? v) => setState(() => _role = v),
                  ),
                  const SizedBox(height: AppSpacing.s4),
                  _BucketChips(
                    groupKey: 'filter_experience',
                    label: 'Years in role',
                    buckets: f.experienceBuckets,
                    value: _experience,
                    onChanged: (String? v) => setState(() => _experience = v),
                  ),
                  const SizedBox(height: AppSpacing.s4),
                  _OptionSelect(
                    key: const Key('filter_industry'),
                    label: 'Industry',
                    anyLabel: 'Any industry',
                    value: _industry,
                    options: f.industries,
                    onChanged: (String? v) => setState(() => _industry = v),
                  ),
                  const SizedBox(height: AppSpacing.s4),
                  _BucketChips(
                    groupKey: 'filter_industry_experience',
                    label: 'Years in industry',
                    buckets: f.experienceBuckets,
                    value: _industryExperience,
                    onChanged: (String? v) =>
                        setState(() => _industryExperience = v),
                  ),
                  const SizedBox(height: AppSpacing.s4),
                  if (f.cities.isEmpty && _city == null)
                    Text(
                      'City — no cities recorded yet',
                      style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        color: AppColors.textMuted,
                      ),
                    )
                  else
                    _OptionSelect(
                      key: const Key('filter_city'),
                      label: 'City',
                      anyLabel: 'Any city',
                      value: _city,
                      options: <LabelledId>[
                        for (final String c in f.cities)
                          LabelledId(id: c, label: c),
                      ],
                      onChanged: (String? v) => setState(() => _city = v),
                    ),
                  const SizedBox(height: AppSpacing.s5),
                  _StrictSwitch(
                    value: _anyFilter && _strict,
                    enabled: _anyFilter,
                    onChanged: (bool v) => setState(() => _strict = v),
                  ),
                ],
              ),
            ),
          ),
          // The sheet's safe area leaves the bottom inset alone, so this row
          // clears the gesture bar itself.
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.gutter,
                AppSpacing.s2,
                AppSpacing.gutter,
                AppSpacing.s4,
              ),
              child: BbButton(
                key: const Key('filters_apply'),
                label: 'Show candidates',
                iconLeft: Icons.search_rounded,
                block: true,
                onPressed: () => Navigator.of(context).pop(_query),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// A single-select dropdown over closed-vocabulary options, "Any …" first.
///
/// [BbSelect] seeds its field from `initialValue`, so the KEY carries the
/// value: "Clear all" (or any outside change) rebuilds the field showing the
/// new value instead of the stale one. A value missing from [options] (a city
/// that left the pool since the last read) stays listed under its own name —
/// reopening the sheet never silently drops a filter the payer set.
///
/// With a [searchHint] it is SEARCHABLE ([BbSearchableDropdownField], #2593).
class _OptionSelect extends StatelessWidget {
  const _OptionSelect({
    super.key,
    required this.label,
    required this.anyLabel,
    required this.value,
    required this.options,
    required this.onChanged,
    this.searchHint,
    this.emptyHint,
  });

  final String label;
  final String anyLabel;
  final String? value;
  final List<LabelledId> options;
  final ValueChanged<String?> onChanged;

  /// The search box's hint; non-null makes the select searchable.
  final String? searchHint;

  /// What the searchable list says when nothing matches.
  final String? emptyHint;

  /// The "Any …" sentinel — every real option id is non-empty.
  static const String _any = '';

  @override
  Widget build(BuildContext context) {
    final Map<String, String> labels = <String, String>{
      for (final LabelledId o in options) o.id: o.label,
    };
    final String current = value ?? _any;
    final List<String> ids = <String>[
      _any,
      ...labels.keys,
      if (current != _any && !labels.containsKey(current)) current,
    ];
    String labelOf(String id) => id == _any ? anyLabel : (labels[id] ?? id);
    final String? hint = searchHint;
    if (hint != null) {
      // Stateless: it reads [current] on every build, so it needs no key.
      return BbSearchableDropdownField<String>(
        label: label,
        value: current,
        options: ids,
        labelOf: labelOf,
        searchHint: hint,
        emptyHint: emptyHint ?? BbSearchableDropdownField.defaultEmptyHint,
        onSelected: (String id) => onChanged(id == _any ? null : id),
      );
    }
    return BbSelect<String>(
      key: ValueKey<String>(current),
      label: label,
      value: current,
      items: ids,
      labelOf: labelOf,
      onChanged: (String? id) =>
          onChanged(id == null || id == _any ? null : id),
    );
  }
}

/// The experience buckets as single-select chips, "Any" first. Tapping the
/// selected bucket again clears it.
class _BucketChips extends StatelessWidget {
  const _BucketChips({
    required this.groupKey,
    required this.label,
    required this.buckets,
    required this.value,
    required this.onChanged,
  });

  final String groupKey;
  final String label;
  final List<LabelledId> buckets;
  final String? value;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          label,
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        Wrap(
          spacing: AppSpacing.s2,
          runSpacing: AppSpacing.s2,
          children: <Widget>[
            BbChip(
              key: Key('$groupKey:any'),
              label: 'Any',
              selected: value == null,
              onTap: () => onChanged(null),
            ),
            for (final LabelledId b in buckets)
              BbChip(
                key: Key('$groupKey:${b.id}'),
                label: b.label,
                selected: value == b.id,
                onTap: () => onChanged(value == b.id ? null : b.id),
              ),
          ],
        ),
      ],
    );
  }
}

class _StrictSwitch extends StatelessWidget {
  const _StrictSwitch({
    required this.value,
    required this.enabled,
    required this.onChanged,
  });

  final bool value;
  final bool enabled;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return MergeSemantics(
      child: InkWell(
        onTap: enabled ? () => onChanged(!value) : null,
        borderRadius: BorderRadius.circular(AppRadii.md),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: AppSpacing.tap),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      'Only show matches',
                      style: AppTypography.body(
                        weight: FontWeight.w700,
                        color: enabled
                            ? AppColors.textPrimary
                            : AppColors.textMuted,
                      ),
                    ),
                    Text(
                      enabled
                          ? "Hides anyone who doesn't match. A detail that "
                              "isn't recorded never hides anyone."
                          : 'Pick a filter first — with none, everyone matches.',
                      style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        color: AppColors.textMuted,
                        height: 1.35,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.s3),
              Switch(
                key: const Key('filter_strict'),
                value: value,
                onChanged: enabled ? onChanged : null,
                activeThumbColor: AppColors.onBlue,
                activeTrackColor: AppColors.blue,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
