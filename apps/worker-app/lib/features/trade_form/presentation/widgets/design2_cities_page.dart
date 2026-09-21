import 'package:flutter/material.dart';

import '../../../../core/api/api_client.dart' show CityHubDto;
import '../../../../core/theme/onboarding_theme.dart';
import 'trade_form_kit.dart';
import 'trade_form_text_field.dart';

/// DESIGN2 — the preferred-cities picker, drawn from
/// `assets/fonts/image/DESIGN2.png`.
///
/// RENDER ONLY. It owns no selection state and no resolution logic: every fact
/// is caller-supplied REAL data (the server's `states`, `cities` and — once the
/// backend serves it (#1634) — `city_hubs`), and every tap is a callback the
/// caller already owned. A null/absent list hides its section:
///
///  - [stateHubs] / [popularHubs] are empty until `city_hubs` ships; the caller
///    then falls back to rendering the selected state's real cities as hub
///    cards (title only, no industrial-area sub-label), so the picker is useful
///    today and simply gains its sub-labels when the catalogue lands.
///  - an empty [selectedCities] hides the "CHUNE HUE SHEHER" strip.
///  - [searchError] is the caller's own resolution message (unknown city),
///    never padded or invented here.
///
/// Static chrome labels ("INDUSTRIAL STATES", "1-Tap Fast Select+", "Jodein",
/// "Chuna hua", "100% Free • Verified Factory Jobs only") are the design
/// pattern itself, not per-worker data.
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
    required this.onSearchSubmit,
    required this.cityController,
    required this.onCityChanged,
    required this.onCitySubmit,
    required this.onSelectState,
    required this.onToggleHub,
    required this.onRemoveCity,
    this.searchError,
    this.cityError,
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

  final TextEditingController searchController;
  final ValueChanged<String> onSearchChanged;

  /// Resolve the search box's exact/alias match and add it (or surface
  /// [searchError]).
  final VoidCallback onSearchSubmit;
  final String? searchError;

  /// The "Koi sheher?" exact-entry field.
  final TextEditingController cityController;
  final ValueChanged<String> onCityChanged;
  final VoidCallback onCitySubmit;
  final String? cityError;

  final ValueChanged<String> onSelectState;

  /// Toggle a hub's canonical [Design2Hub.cityValue].
  final ValueChanged<String> onToggleHub;
  final ValueChanged<String> onRemoveCity;
  final bool enabled;

  static const String _kTitle = 'Kahan kaam karna chahte hain?';
  static const String _kChosenLabel = 'CHUNE HUE SHEHER';
  static const String _kSearchHint = 'Sheher ya industrial area khojein';
  static const String _kSearchAction = 'Dhoondhein';
  static const String _kStatesLabel = 'INDUSTRIAL STATES';
  static const String _kFastSelect = '1-Tap Fast Select+';
  static const String _kPopularLabel = 'POPULAR FACTORY HUBS';
  static const String _kAnyCityLabel = 'Koi sheher?';
  static const String _kAnyCityHint = 'Apna sheher likhein';
  static const String _kTrust = '100% Free • Verified Factory Jobs only';
  static const String _kAdd = 'Jodein';
  static const String _kChosen = 'Chuna hua';
  static const String _kNoHubs = 'Is rajya ke sheher jald aa rahe hain.';

  @override
  Widget build(BuildContext context) {
    final int remaining = maxCities - selectedCities.length;
    return IgnorePointer(
      ignoring: !enabled,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _Heading(maxCities: maxCities, chosen: selectedCities.length),
          const SizedBox(height: FormFlowLayout.introToOptionsGap),
          if (selectedCities.isNotEmpty) ...<Widget>[
            _SectionHeader(
              label: _kChosenLabel,
              trailing: remaining > 0 ? '$remaining slots bache' : null,
            ),
            const SizedBox(height: 10),
            _ChosenCities(
              cities: selectedCities,
              onRemove: onRemoveCity,
            ),
            const SizedBox(height: 18),
          ],
          TradeFormTextField(
            controller: searchController,
            hint: _kSearchHint,
            label: _kSearchHint,
            textInputAction: TextInputAction.search,
            errorText: searchError,
            onChanged: onSearchChanged,
            onSubmitted: (_) => onSearchSubmit(),
          ),
          const SizedBox(height: 8),
          TradeFormSecondaryButton(
            label: _kSearchAction,
            icon: Icons.search_rounded,
            onPressed: onSearchSubmit,
          ),
          const SizedBox(height: 18),
          if (states.isNotEmpty) ...<Widget>[
            const _SectionHeader(label: _kStatesLabel),
            const SizedBox(height: 10),
            _StateChips(
              states: states,
              selected: selectedState,
              onSelect: onSelectState,
            ),
            const SizedBox(height: 18),
          ],
          if (searchResults.isNotEmpty) ...<Widget>[
            const _SectionHeader(label: 'SEARCH RESULTS'),
            const SizedBox(height: 10),
            _HubGrid(
              hubs: searchResults,
              onToggle: onToggleHub,
            ),
            const SizedBox(height: 18),
          ] else if (selectedState != null) ...<Widget>[
            _SectionHeader(
              label: '${selectedState!.toUpperCase()} HUBS',
              trailing: _kFastSelect,
            ),
            const SizedBox(height: 10),
            if (stateHubs.isEmpty)
              Text(
                _kNoHubs,
                style: OnboardingTypography.formWhyText(),
              )
            else
              _HubGrid(hubs: stateHubs, onToggle: onToggleHub),
            const SizedBox(height: 18),
          ],
          if (popularHubs.isNotEmpty) ...<Widget>[
            const _SectionHeader(label: _kPopularLabel),
            const SizedBox(height: 10),
            _PopularHubs(hubs: popularHubs, onToggle: onToggleHub),
            const SizedBox(height: 18),
          ],
          const TradeFormFieldLabel(_kAnyCityLabel),
          TradeFormTextField(
            controller: cityController,
            hint: _kAnyCityHint,
            label: _kAnyCityLabel,
            textInputAction: TextInputAction.done,
            errorText: cityError,
            onChanged: onCityChanged,
            onSubmitted: (_) => onCitySubmit(),
          ),
          const SizedBox(height: 18),
          const _TrustFooter(text: _kTrust),
        ],
      ),
    );
  }
}

/// The question heading with the live `n/5` badge (design: title left, a
/// yellow-tinted counter pill right, subtitle under).
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

/// An uppercase section label, with an optional muted trailing note.
class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.label, this.trailing});

  final String label;
  final String? trailing;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: <Widget>[
        Expanded(
          child: Text(
            label,
            style: OnboardingTypography.inter(
              size: 11,
              weight: FontWeight.w800,
              letterSpacing: 0.6,
              color: OnboardingColors.ink600,
            ),
          ),
        ),
        if (trailing != null)
          Flexible(
            child: Text(
              trailing!,
              textAlign: TextAlign.right,
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

/// The picked cities as removable pills, scrolling sideways so the strip never
/// stacks to a second line (the same convention as the app's filter rows).
class _ChosenCities extends StatelessWidget {
  const _ChosenCities({required this.cities, required this.onRemove});

  final List<String> cities;
  final ValueChanged<String> onRemove;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: OnboardingLayout.tapTarget,
      child: ListView.builder(
        scrollDirection: Axis.horizontal,
        itemCount: cities.length,
        itemBuilder: (BuildContext context, int index) {
          final String c = cities[index];
          final bool isLast = index == cities.length - 1;
          return Padding(
            padding: EdgeInsets.only(right: isLast ? 0 : 8),
            child: TradeFormPillChip(
              label: c,
              selected: true,
              trailingIcon: Icons.close_rounded,
              onTap: () => onRemove(c),
            ),
          );
        },
      ),
    );
  }
}

/// The state/UT chips — the state-then-hub cascade's first step (#1429). All
/// 36 fit in a horizontal scroll rather than a wrap.
class _StateChips extends StatelessWidget {
  const _StateChips({
    required this.states,
    required this.selected,
    required this.onSelect,
  });

  final List<String> states;
  final String? selected;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: OnboardingLayout.tapTarget,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: states.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (BuildContext context, int index) {
          final String state = states[index];
          final bool isSelected = state == selected;
          return TradeFormPillChip(
            label: state,
            selected: isSelected,
            onTap: () => onSelect(state),
            labelStyle: OnboardingTypography.inter(
              size: 14,
              weight: FontWeight.w700,
              color: isSelected
                  ? OnboardingColors.textOnYellow
                  : OnboardingColors.ink900,
            ),
          );
        },
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

/// The hub cards: two per row while each cell keeps its minimum width, one per
/// row once the worker's font scale or a narrow handset would squeeze them.
class _HubGrid extends StatelessWidget {
  const _HubGrid({required this.hubs, required this.onToggle});

  final List<Design2Hub> hubs;
  final ValueChanged<String> onToggle;

  static const double _minTwoUpWidth = 150;
  static const double _gap = 10;

  @override
  Widget build(BuildContext context) {
    Widget card(Design2Hub h) => _HubCard(
          hub: h,
          onTap: () => onToggle(h.cityValue),
        );
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double cell = (constraints.maxWidth - _gap) / 2;
        final bool twoUp =
            cell >= MediaQuery.textScalerOf(context).scale(_minTwoUpWidth);
        if (!twoUp) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              for (final Design2Hub h in hubs) ...<Widget>[
                card(h),
                const SizedBox(height: _gap),
              ],
            ],
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            for (int i = 0; i < hubs.length; i += 2)
              Padding(
                padding: const EdgeInsets.only(bottom: _gap),
                child: IntrinsicHeight(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      Expanded(child: card(hubs[i])),
                      const SizedBox(width: _gap),
                      Expanded(
                        child: i + 1 < hubs.length
                            ? card(hubs[i + 1])
                            : const SizedBox.shrink(),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _HubCard extends StatelessWidget {
  const _HubCard({required this.hub, required this.onTap});

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
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(OnboardingRadii.row),
              border: Border.all(
                color: hub.selected
                    ? OnboardingColors.safetyYellow
                    : OnboardingColors.borderDefault,
                width: hub.selected ? 1.8 : 1.2,
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  hub.title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: OnboardingTypography.anek(
                    size: 16,
                    weight: FontWeight.w800,
                    color: OnboardingColors.ink900,
                  ),
                ),
                if (hub.areas != null) ...<Widget>[
                  const SizedBox(height: 2),
                  Text(
                    hub.areas!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: OnboardingTypography.inter(
                      size: 11,
                      weight: FontWeight.w500,
                      color: OnboardingColors.ink500,
                    ),
                  ),
                ],
                const SizedBox(height: 10),
                _HubAction(selected: hub.selected),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The card's one-tap control: navy outline "Jodein" when unpicked, a green
/// "Chuna hua" tick when picked.
class _HubAction extends StatelessWidget {
  const _HubAction({required this.selected});

  final bool selected;

  @override
  Widget build(BuildContext context) {
    final Color fg = selected
        ? OnboardingColors.successGreen
        : OnboardingColors.shiftBlue;
    final Color bg = selected
        ? OnboardingColors.successBg
        : OnboardingColors.paperWhite;
    final Color border = selected
        ? OnboardingColors.successBorder
        : OnboardingColors.borderDefault;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(OnboardingRadii.badge),
        border: Border.all(color: border, width: 1.2),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(
            selected ? Icons.check_rounded : Icons.add_rounded,
            size: 16,
            color: fg,
          ),
          const SizedBox(width: 4),
          Flexible(
            child: Text(
              selected ? Design2CitiesPage._kChosen : Design2CitiesPage._kAdd,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: OnboardingTypography.inter(
                size: 12,
                weight: FontWeight.w700,
                color: fg,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The "POPULAR FACTORY HUBS" rows — full-width cards (the design's two-per-
/// row label pair) so a long hub name never collides.
class _PopularHubs extends StatelessWidget {
  const _PopularHubs({required this.hubs, required this.onToggle});

  final List<Design2Hub> hubs;
  final ValueChanged<String> onToggle;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final Design2Hub h in hubs) ...<Widget>[
          Material(
            color: OnboardingColors.paperWhite,
            borderRadius: BorderRadius.circular(OnboardingRadii.row),
            child: InkWell(
              onTap: () => onToggle(h.cityValue),
              borderRadius: BorderRadius.circular(OnboardingRadii.row),
              child: Container(
                constraints:
                    const BoxConstraints(minHeight: OnboardingLayout.tapTarget),
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(OnboardingRadii.row),
                  border: Border.all(
                    color: h.selected
                        ? OnboardingColors.safetyYellow
                        : OnboardingColors.borderDefault,
                    width: h.selected ? 1.8 : 1.2,
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
                          size: 13,
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
                      size: 22,
                      color: h.selected
                          ? OnboardingColors.successGreen
                          : OnboardingColors.ink500,
                    ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 10),
        ],
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
