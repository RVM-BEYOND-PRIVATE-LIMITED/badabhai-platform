import 'package:flutter/material.dart';

import '../../../../core/api/api_client.dart' show CityHubDto;
import '../../../../core/theme/onboarding_theme.dart';
import 'trade_form_text_field.dart';

/// CITY1 — the preferred-cities picker, drawn from
/// `assets/fonts/image/city1.png`.
///
/// RENDER ONLY. It owns no selection state and no resolution logic: every fact
/// is caller-supplied REAL data (the server's `states`, `cities` and — once the
/// backend serves it (#1634) — `city_hubs`), and every tap is a callback the
/// caller already owned. A null/absent list hides its section:
///
///  - [stateHubs] is empty until a state is picked; the caller then falls back
///    to rendering the selected state's real cities as plain cells (title
///    only, no industrial-area sub-label), so the picker is useful today and
///    simply gains its sub-labels when the catalogue lands.
///  - an empty [selectedCities] hides the picked chips and prints the mock's
///    "No cities selected yet" note.
  ///  - an empty [popularHubs] hides the whole "Other best places"
///    block (the catalogue fallback, empty until #1634 ships).
///
/// Below the question heading the page follows city1: a "Selected locations"
/// banner, a numbered "Choose State" card (dropdown sheet + popular-state
/// chips) and a numbered "Choose Cities" card (inline search, compact
/// checkbox grid, selected strip). Static chrome labels ("Selected
/// locations", "Clear all", "Choose State", "Choose Cities",
/// "POPULAR STATES", "Duty…", "100% Free • Verified Factory Jobs only") are
/// the design pattern itself, not per-worker data.
///
/// Two deliberate deltas from the mock, both behaviour-preserving: the mock's
/// second "Search city and select" nav row is omitted — typing in the ONE
/// inline search box IS the search (a tap on a card is the only add path, and
/// it carries the canonical value the server's catalogue accepts); and the
/// popular catalogue hubs render as the "other cities" rows. The question
/// heading itself is untouched.
class Design2CitiesPage extends StatelessWidget {
  const Design2CitiesPage({
    super.key,
    required this.maxCities,
    required this.selectedCities,
    required this.states,
    required this.selectedState,
    required this.stateHubs,
    required this.popularHubs,
    required this.searchResults,
    required this.searchController,
    required this.onSearchChanged,
    required this.onSelectState,
    required this.onToggleHub,
    required this.onRemoveCity,
    this.onClearAll,
    this.enabled = true,
  });

  final int maxCities;
  final List<String> selectedCities;
  final List<String> states;
  final String? selectedState;

  /// Hubs to show for [selectedState], already resolved by the caller.
  final List<Design2Hub> stateHubs;

  /// Hubs flagged popular, already resolved by the caller.
  final List<Design2Hub> popularHubs;

  /// Hub/city matches for the current search text, already resolved.
  final List<Design2Hub> searchResults;

  /// The browse box. TYPING IS THE SEARCH: every keystroke re-resolves
  /// [searchResults] and the matching cards appear under it, so there is no
  /// "Dhoondhein" button and no submit step to get wrong. A worker adds a city
  /// by TAPPING a card — the only path that can produce the canonical value the
  /// server's catalogue accepts.
  final TextEditingController searchController;
  final ValueChanged<String> onSearchChanged;

  final ValueChanged<String> onSelectState;

  /// Toggle a hub's canonical [Design2Hub.cityValue].
  final ValueChanged<String> onToggleHub;
  final ValueChanged<String> onRemoveCity;

  /// Clears every picked city at once (the banner's "Clear all"). Null keeps
  /// the banner working by removing the picked cities one by one through
  /// [onRemoveCity], so older call sites stay untouched.
  final VoidCallback? onClearAll;

  final bool enabled;

  static const String _kTitle = 'Kahan kaam karna chahte hain?';
  static const String _kSelectedTitle = 'Selected locations';
  static const String _kClearAll = 'Clear all';
  static const String _kChooseState = 'State Chunain';
  static const String _kSelectState = 'Select State';
  static const String _kPopularStates = 'POPULAR STATES';
  static const String _kChooseCities = 'Cities Chunain';
  static const String _kSearchHint = 'Search city...';
  static const String _kPopularCities = 'Popular cities from selected state';
  static const String _kSearchResults = 'SEARCH RESULTS';
  static const String _kOtherCities = 'Other best places';
  static const String _kSelectedCities = 'Selected cities';
  static const String _kNoCities = 'No cities selected yet';
  static const String _kPickStateHint =
      'Pehle state chunein — uske sheher yahan dikhenge.';
  static const String _kNoHubs = 'Is rajya ke sheher jald aa rahe hain.';
  static const String _kTrust = '100% Free • Verified Factory Jobs only';

  /// The mock's popular-states row, in mock order, intersected with the
  /// server's real state list — so every chip is always a real state.
  static const List<String> _kPopularStateOrder = <String>[
    'Maharashtra',
    'Gujarat',
    'Karnataka',
    'Tamil Nadu',
    'Uttar Pradesh',
    'Rajasthan',
    'Delhi',
    'Madhya Pradesh',
  ];

  List<String> get _popularStates => <String>[
        for (final String s in _kPopularStateOrder)
          if (states.contains(s)) s,
      ];

  void _clearAll() {
    final VoidCallback? clear = onClearAll;
    if (clear != null) {
      clear();
      return;
    }
    for (final String c in selectedCities) {
      onRemoveCity(c);
    }
  }

  /// The "Select State" sheet: the full real state list, the picked one
  /// ticked. Re-tapping the picked state clears it — the sheet reports the
  /// tap and the caller's toggle owns the semantics, exactly like the chips.
  Future<void> _openStateSheet(BuildContext context) async {
    final String? picked = await showModalBottomSheet<String>(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (BuildContext sheetContext) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                child: Text(
                  _kSelectState,
                  style: OnboardingTypography.anek(
                    size: 16,
                    weight: FontWeight.w800,
                    color: OnboardingColors.ink900,
                  ),
                ),
              ),
              Flexible(
                child: ListView.builder(
                  key: const Key('statePickerList'),
                  shrinkWrap: true,
                  itemCount: states.length,
                  itemBuilder: (BuildContext context, int index) {
                    final String s = states[index];
                    final bool isSel = s == selectedState;
                    return ListTile(
                      title: Text(
                        s,
                        style: OnboardingTypography.inter(
                          size: 14,
                          weight: FontWeight.w600,
                          color: OnboardingColors.ink900,
                        ),
                      ),
                      trailing: isSel
                          ? const Icon(
                              Icons.check_rounded,
                              color: OnboardingColors.successGreen,
                            )
                          : null,
                      onTap: () => Navigator.of(sheetContext).pop(s),
                    );
                  },
                ),
              ),
            ],
          ),
        );
      },
    );
    if (picked != null) onSelectState(picked);
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      ignoring: !enabled,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _Heading(maxCities: maxCities, chosen: selectedCities.length),
          const SizedBox(height: FormFlowLayout.introToOptionsGap),
          _SelectedStrip(
            chosen: selectedCities.length,
            max: maxCities,
            onClear: _clearAll,
          ),
          const SizedBox(height: 10),
          _City1Card(child: _stateSection(context)),
          const SizedBox(height: 10),
          _City1Card(child: _citiesSection()),
          const SizedBox(height: 12),
          const _TrustFooter(text: _kTrust),
        ],
      ),
    );
  }

  /// Card 1 — the state step. Dropdown opens the full real list; the chips
  /// are the mock's popular-states shortcut into the same callback.
  Widget _stateSection(BuildContext context) {
    final List<String> popular = _popularStates;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        const _StepHead(
          number: '1',
          title: _kChooseState,
        ),
        const SizedBox(height: 10),
        _StateDropdownField(
          value: selectedState,
          onTap: () => _openStateSheet(context),
        ),
        if (popular.isNotEmpty) ...<Widget>[
          const SizedBox(height: 10),
          const _MicroLabel(_kPopularStates),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (final String s in popular)
                _SmallChip(
                  label: s,
                  selected: s == selectedState,
                  onTap: () => onSelectState(s),
                ),
            ],
          ),
        ],
      ],
    );
  }

  /// Card 2 — the cities step. The search results REPLACE the popular grid
  /// while a query matches (the cards ARE the answer, so there is no
  /// not-found error); with no state picked yet a hint holds the place.
  Widget _citiesSection() {
    final bool showingResults = searchResults.isNotEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        const _StepHead(
          number: '2',
          title: _kChooseCities,
        ),
        const SizedBox(height: 10),
        TradeFormTextField(
          controller: searchController,
          hint: _kSearchHint,
          label: _kSearchHint,
          textInputAction: TextInputAction.search,
          onChanged: onSearchChanged,
          prefixIcon: const Icon(
            Icons.search_rounded,
            size: 20,
            color: OnboardingColors.ink500,
          ),
        ),
        const SizedBox(height: 10),
        if (showingResults) ...<Widget>[
          const _MicroLabel(_kSearchResults),
          const SizedBox(height: 8),
          _CityGrid(hubs: searchResults, onToggle: onToggleHub),
        ] else if (selectedState != null) ...<Widget>[
          const _MicroLabel(_kPopularCities),
          const SizedBox(height: 8),
          if (stateHubs.isEmpty)
            Text(
              _kNoHubs,
              style: OnboardingTypography.formWhyText(),
            )
          else
            _CityGrid(hubs: stateHubs, onToggle: onToggleHub),
        ] else ...<Widget>[
          Text(
            _kPickStateHint,
            style: OnboardingTypography.formWhyText(),
          ),
        ],
        if (popularHubs.isNotEmpty) ...<Widget>[
          const SizedBox(height: 10),
          const _OrDivider(),
          const SizedBox(height: 10),
          Text(
            _kOtherCities,
            style: OnboardingTypography.inter(
              size: 13,
              weight: FontWeight.w700,
              color: OnboardingColors.ink900,
            ),
          ),
          const SizedBox(height: 8),
          _OtherCityRows(hubs: popularHubs, onToggle: onToggleHub),
        ],
        const SizedBox(height: 4),
        const Divider(color: OnboardingColors.borderDefault, height: 17),
        const SizedBox(height: 4),
        _SelectedCitiesBlock(
          cities: selectedCities,
          maxCities: maxCities,
          onRemove: onRemoveCity,
        ),
      ],
    );
  }
}

/// The question heading with the live `n/5` badge (design: title left, a
/// yellow-tinted counter pill right, subtitle under).
///
/// UNTOUCHED by the city1 restyle — the header and the question stay exactly
/// as they were.
class _Heading extends StatelessWidget {
  const _Heading({required this.maxCities, required this.chosen});

  final int maxCities;
  final int chosen;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Expanded(
              child: Text(
                Design2CitiesPage._kTitle,
                style: OnboardingTypography.formQuestionHeadline(),
              ),
            ),
            const SizedBox(width: 10),
            // A chrome counter, not the question — clamp its scale like every
            // other pinned chip in the form flow, so at a 2.0 system font the
            // badge cannot push the headline off a 320dp handset.
            MediaQuery.withClampedTextScaling(
              maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
              child: _CountBadge(chosen: chosen, max: maxCities),
            ),
          ],
        ),
        const SizedBox(height: FormFlowLayout.headlineToWhyGap),
        Text(
          'Aap 1 se $maxCities sheher chun sakte hain.',
          style: OnboardingTypography.formWhyText(),
        ),
      ],
    );
  }
}

class _CountBadge extends StatelessWidget {
  const _CountBadge({required this.chosen, required this.max});

  final int chosen;
  final int max;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: OnboardingColors.selectedCardBg,
        borderRadius: BorderRadius.circular(OnboardingRadii.badge),
        border: Border.all(color: OnboardingColors.safetyYellow, width: 1.2),
      ),
      child: Text(
        '$chosen/$max Sheher Chune',
        style: OnboardingTypography.inter(
          size: 12,
          weight: FontWeight.w700,
          color: OnboardingColors.textOnYellow,
        ),
      ),
    );
  }
}

/// The mock's tinted "Selected locations" banner: pin, live count, and the
/// "Clear all" outline action. Always drawn — an empty pick reads "0/5".
class _SelectedStrip extends StatelessWidget {
  const _SelectedStrip({
    required this.chosen,
    required this.max,
    required this.onClear,
  });

  final int chosen;
  final int max;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: OnboardingColors.selectedCardBg,
        borderRadius: BorderRadius.circular(OnboardingRadii.row),
      ),
      // Chrome, not the question — clamp its scale like the count badge and
      // every header lockup, so at a 2.0 system font the "Clear all" action
      // cannot starve the count text to zero width and stripe the row.
      child: MediaQuery.withClampedTextScaling(
        maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
        child: Row(
          children: <Widget>[
            Container(
              width: 34,
              height: 34,
              decoration: const BoxDecoration(
                color: OnboardingColors.safetyYellow,
                shape: BoxShape.circle,
              ),
              child: const Icon(
                Icons.place_rounded,
                size: 19,
                color: OnboardingColors.shiftBlue,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Text(
                    Design2CitiesPage._kSelectedTitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: OnboardingTypography.inter(
                      size: 14,
                      weight: FontWeight.w800,
                      color: OnboardingColors.ink900,
                    ),
                  ),
                  const SizedBox(height: 1),
                  Text(
                    '$chosen/$max locations selected',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: OnboardingTypography.inter(
                      size: 12,
                      weight: FontWeight.w500,
                      color: OnboardingColors.ink500,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Semantics(
              button: true,
              label: Design2CitiesPage._kClearAll,
              child: Material(
                type: MaterialType.transparency,
                child: InkWell(
                  onTap: onClear,
                  borderRadius: BorderRadius.circular(OnboardingRadii.badge),
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 8,
                    ),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(
                        OnboardingRadii.badge,
                      ),
                      border: Border.all(
                        color: OnboardingColors.safetyYellow,
                        width: 1.2,
                      ),
                    ),
                    child: Text(
                      Design2CitiesPage._kClearAll,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: OnboardingTypography.inter(
                        size: 12,
                        weight: FontWeight.w700,
                        color: OnboardingColors.shiftBlue,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The mock's white step card: hairline shell, compact inset so more content
/// stays above the fold.
class _City1Card extends StatelessWidget {
  const _City1Card({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: OnboardingColors.paperWhite,
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
        border: Border.all(
          color: OnboardingColors.borderDefault,
          width: 1.2,
        ),
      ),
      child: child,
    );
  }
}

/// A numbered step head: yellow number disc and a small title. The old
/// subtitle line is gone — the cards read without it and the fold shows
/// more cities.
class _StepHead extends StatelessWidget {
  const _StepHead({
    required this.number,
    required this.title,
  });

  final String number;
  final String title;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Container(
          width: 26,
          height: 26,
          decoration: const BoxDecoration(
            color: OnboardingColors.safetyYellow,
            shape: BoxShape.circle,
          ),
          child: Center(
            child: Text(
              number,
              style: OnboardingTypography.inter(
                size: 13,
                weight: FontWeight.w800,
                color: OnboardingColors.textOnYellow,
              ),
            ),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            title,
            style: OnboardingTypography.inter(
              size: 15,
              weight: FontWeight.w800,
              color: OnboardingColors.ink900,
            ),
          ),
        ),
      ],
    );
  }
}

/// An uppercase micro section label.
class _MicroLabel extends StatelessWidget {
  const _MicroLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: OnboardingTypography.inter(
        size: 11,
        weight: FontWeight.w800,
        letterSpacing: 0.6,
        color: OnboardingColors.ink600,
      ),
    );
  }
}

/// The "Select State" dropdown field: map glyph, picked state or hint, and a
/// chevron. Opens the full real state list in a sheet.
class _StateDropdownField extends StatelessWidget {
  const _StateDropdownField({required this.value, required this.onTap});

  final String? value;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final String? v = value;
    return Material(
      color: OnboardingColors.paperWhite,
      borderRadius: BorderRadius.circular(OnboardingRadii.row),
      child: InkWell(
        key: const Key('stateDropdownField'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(OnboardingRadii.row),
        child: Container(
          constraints: const BoxConstraints(
            minHeight: OnboardingLayout.tapTarget,
          ),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(OnboardingRadii.row),
            border: Border.all(
              color: OnboardingColors.borderDefault,
              width: 1.2,
            ),
          ),
          child: Row(
            children: <Widget>[
              const Icon(
                Icons.map_outlined,
                size: 22,
                color: OnboardingColors.shiftBlue,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  v ?? Design2CitiesPage._kSelectState,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: OnboardingTypography.inter(
                    size: 14,
                    weight: FontWeight.w500,
                    color: v == null
                        ? OnboardingColors.ink500
                        : OnboardingColors.ink900,
                  ),
                ),
              ),
              const Icon(
                Icons.keyboard_arrow_down_rounded,
                size: 24,
                color: OnboardingColors.ink500,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A compact popular-state chip — deliberately denser than the form's default
/// 48dp pill: eight of these share one card and the worker should see cities
/// without scrolling. Same compact density as the card's own duty chips.
class _SmallChip extends StatelessWidget {
  const _SmallChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: selected
            ? OnboardingColors.selectedCardBg
            : OnboardingColors.paperWhite,
        borderRadius: BorderRadius.circular(OnboardingRadii.badge),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(OnboardingRadii.badge),
          child: Container(
            constraints: const BoxConstraints(minHeight: 36),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(OnboardingRadii.badge),
              border: Border.all(
                color: selected
                    ? OnboardingColors.safetyYellow
                    : OnboardingColors.borderDefault,
                width: selected ? 1.5 : 1.2,
              ),
            ),
            child: Center(
              widthFactor: 1,
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: OnboardingTypography.inter(
                  size: 12,
                  weight: FontWeight.w700,
                  color: OnboardingColors.ink900,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// One place the worker can pick — a curated hub (with industrial areas) when
/// the catalogue exists, or a bare city otherwise.
class Design2Hub {
  const Design2Hub({
    required this.cityValue,
    required this.title,
    required this.selected,
    this.areas,
  });

  final String cityValue;
  final String title;

  /// Display-only industrial areas (e.g. `Chakan, Bhosari MIDC`); null hides
  /// the sub-label.
  final String? areas;
  final bool selected;
}

/// The mock's checkbox grid: three cells per row while each cell keeps its
/// minimum width, two per row once the worker's font scale or a narrow
/// handset would squeeze them.
class _CityGrid extends StatelessWidget {
  const _CityGrid({required this.hubs, required this.onToggle});

  final List<Design2Hub> hubs;
  final ValueChanged<String> onToggle;

  static const double _minThreeUpWidth = 96;
  static const double _gap = 8;

  @override
  Widget build(BuildContext context) {
    Widget card(Design2Hub h) => _CityCheckCard(
          hub: h,
          onTap: () => onToggle(h.cityValue),
        );
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double cell3 = (constraints.maxWidth - _gap * 2) / 3;
        final bool threeUp =
            cell3 >= MediaQuery.textScalerOf(context).scale(_minThreeUpWidth);
        final int cols = threeUp ? 3 : 2;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            for (int i = 0; i < hubs.length; i += cols)
              Padding(
                padding: EdgeInsets.only(
                  bottom: i + cols < hubs.length ? _gap : 0,
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    for (int j = 0; j < cols; j++)
                      if (i + j < hubs.length) ...<Widget>[
                        if (j > 0) const SizedBox(width: _gap),
                        Expanded(child: card(hubs[i + j])),
                      ] else ...<Widget>[
                        if (j > 0) const SizedBox(width: _gap),
                        const Expanded(child: SizedBox.shrink()),
                      ],
                  ],
                ),
              ),
          ],
        );
      },
    );
  }
}

/// One checkbox cell: the compact city title and the trailing checkbox. The
/// catalogue's industrial-area sub-label is deliberately NOT drawn — the cell
/// shows the city name only; TalkBack still announces the areas via the
/// semantics label.
class _CityCheckCard extends StatelessWidget {
  const _CityCheckCard({required this.hub, required this.onTap});

  final Design2Hub hub;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: hub.selected,
      label: hub.areas == null ? hub.title : '${hub.title}, ${hub.areas}',
      child: Material(
        color: hub.selected
            ? OnboardingColors.selectedCardBg
            : OnboardingColors.paperWhite,
        borderRadius: BorderRadius.circular(OnboardingRadii.row),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(OnboardingRadii.row),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(OnboardingRadii.row),
              border: Border.all(
                color: hub.selected
                    ? OnboardingColors.safetyYellow
                    : OnboardingColors.borderDefault,
                width: hub.selected ? 1.5 : 1.2,
              ),
            ),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    hub.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: OnboardingTypography.inter(
                      size: 12,
                      weight: FontWeight.w700,
                      color: OnboardingColors.ink900,
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                Icon(
                  hub.selected
                      ? Icons.check_box_rounded
                      : Icons.check_box_outline_blank_rounded,
                  size: 18,
                  color: hub.selected
                      ? OnboardingColors.successGreen
                      : OnboardingColors.ink500,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The "OR" divider between the state-scoped grid and the other-cities rows.
class _OrDivider extends StatelessWidget {
  const _OrDivider();

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        const Expanded(
          child: Divider(color: OnboardingColors.borderDefault),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Text(
            'OR',
            style: OnboardingTypography.inter(
              size: 11,
              weight: FontWeight.w700,
              color: OnboardingColors.ink500,
            ),
          ),
        ),
        const Expanded(
          child: Divider(color: OnboardingColors.borderDefault),
        ),
      ],
    );
  }
}

/// The catalogue's popular hubs as full-width toggle rows — cities the worker
/// can add without picking their state first.
class _OtherCityRows extends StatelessWidget {
  const _OtherCityRows({required this.hubs, required this.onToggle});

  final List<Design2Hub> hubs;
  final ValueChanged<String> onToggle;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final Design2Hub h in hubs) ...<Widget>[
          Material(
            color: h.selected
                ? OnboardingColors.selectedCardBg
                : OnboardingColors.paperWhite,
            borderRadius: BorderRadius.circular(OnboardingRadii.row),
            child: InkWell(
              onTap: () => onToggle(h.cityValue),
              borderRadius: BorderRadius.circular(OnboardingRadii.row),
              child: Container(
                constraints: const BoxConstraints(minHeight: 44),
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 9,
                ),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(OnboardingRadii.row),
                  border: Border.all(
                    color: h.selected
                        ? OnboardingColors.safetyYellow
                        : OnboardingColors.borderDefault,
                    width: h.selected ? 1.5 : 1.2,
                  ),
                ),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: Text(
                        h.areas == null ? h.title : '${h.title}: ${h.areas}',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: OnboardingTypography.inter(
                          size: 12,
                          weight: FontWeight.w600,
                          color: OnboardingColors.ink900,
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Icon(
                      h.selected
                          ? Icons.check_box_rounded
                          : Icons.check_box_outline_blank_rounded,
                      size: 20,
                      color: h.selected
                          ? OnboardingColors.successGreen
                          : OnboardingColors.ink500,
                    ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 8),
        ],
      ],
    );
  }
}

/// The mock's "Selected cities (max 5)" strip: live count, removable compact
/// chips, or the honest empty note.
class _SelectedCitiesBlock extends StatelessWidget {
  const _SelectedCitiesBlock({
    required this.cities,
    required this.maxCities,
    required this.onRemove,
  });

  final List<String> cities;
  final int maxCities;
  final ValueChanged<String> onRemove;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: Text(
                '${Design2CitiesPage._kSelectedCities} (max $maxCities)',
                style: OnboardingTypography.inter(
                  size: 12,
                  weight: FontWeight.w700,
                  color: OnboardingColors.ink600,
                ),
              ),
            ),
            Text(
              '${cities.length}/$maxCities',
              style: OnboardingTypography.inter(
                size: 12,
                weight: FontWeight.w600,
                color: OnboardingColors.ink500,
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        if (cities.isEmpty)
          Text(
            Design2CitiesPage._kNoCities,
            style: OnboardingTypography.inter(
              size: 12,
              weight: FontWeight.w500,
              color: OnboardingColors.ink500,
            ).copyWith(fontStyle: FontStyle.italic),
          )
        else
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (final String c in cities)
                Semantics(
                  button: true,
                  label: c,
                  child: Material(
                    color: OnboardingColors.selectedCardBg,
                    borderRadius: BorderRadius.circular(
                      OnboardingRadii.badge,
                    ),
                    child: InkWell(
                      onTap: () => onRemove(c),
                      borderRadius: BorderRadius.circular(
                        OnboardingRadii.badge,
                      ),
                      child: Container(
                        constraints: const BoxConstraints(minHeight: 34),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 6,
                        ),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(
                            OnboardingRadii.badge,
                          ),
                          border: Border.all(
                            color: OnboardingColors.safetyYellow,
                            width: 1.5,
                          ),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: <Widget>[
                            Flexible(
                              child: Text(
                                c,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: OnboardingTypography.inter(
                                  size: 12,
                                  weight: FontWeight.w700,
                                  color: OnboardingColors.ink900,
                                ),
                              ),
                            ),
                            const SizedBox(width: 4),
                            const Icon(
                              Icons.close_rounded,
                              size: 16,
                              color: OnboardingColors.shiftBlue,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
      ],
    );
  }
}

class _TrustFooter extends StatelessWidget {
  const _TrustFooter({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        const Icon(
          Icons.verified_user_outlined,
          size: 15,
          color: OnboardingColors.ink500,
        ),
        const SizedBox(width: 6),
        Flexible(
          child: Text(
            text,
            textAlign: TextAlign.center,
            style: OnboardingTypography.inter(
              size: 11,
              weight: FontWeight.w600,
              color: OnboardingColors.ink500,
            ),
          ),
        ),
      ],
    );
  }
}

/// Caller-side helpers: turn the options' hubs (or, as a fallback, a state's
/// cities) into the card view-model, so the page itself stays render-only.
extension Design2HubBuilders on CityHubDto {
  Design2Hub toView({required bool selected}) => Design2Hub(
        cityValue: cityValue,
        title: display.isEmpty ? cityValue : display,
        areas: areas.isEmpty ? null : areas.join(', '),
        selected: selected,
      );
}
