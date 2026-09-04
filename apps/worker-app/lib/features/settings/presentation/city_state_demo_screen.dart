import 'package:flutter/material.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_blue_header.dart';
import '../../../core/widgets/bb_searchable_dropdown_field.dart';

/// A REAL, curated (not exhaustive) sample: 15 states, a handful of major
/// cities each. Stands in for the authoritative backend dataset #1429 asks
/// for — every city name here is real, but this list is nowhere near
/// complete (many states aren't listed at all, and listed states are
/// missing plenty of real towns). Swap this map for a backend call once
/// #1429 lands; nothing else on this screen needs to change.
const Map<String, List<String>> kDemoStateCities = <String, List<String>>{
  'Maharashtra': <String>[
    'Mumbai',
    'Pune',
    'Nagpur',
    'Nashik',
    'Aurangabad',
    'Kolhapur',
  ],
  'Gujarat': <String>[
    'Ahmedabad',
    'Surat',
    'Vadodara',
    'Rajkot',
    'Gandhinagar',
  ],
  'Haryana': <String>['Gurugram', 'Faridabad', 'Panipat', 'Hisar', 'Karnal'],
  'Uttar Pradesh': <String>[
    'Lucknow',
    'Kanpur',
    'Noida',
    'Ghaziabad',
    'Agra',
    'Varanasi',
  ],
  'Delhi': <String>['New Delhi'],
  'Punjab': <String>['Ludhiana', 'Amritsar', 'Jalandhar', 'Patiala'],
  'Rajasthan': <String>['Jaipur', 'Jodhpur', 'Kota', 'Udaipur', 'Bikaner'],
  'Tamil Nadu': <String>[
    'Chennai',
    'Coimbatore',
    'Madurai',
    'Tiruppur',
    'Salem',
  ],
  'Karnataka': <String>['Bengaluru', 'Mysuru', 'Hubballi', 'Mangaluru'],
  'Telangana': <String>['Hyderabad', 'Warangal', 'Nizamabad'],
  'Madhya Pradesh': <String>['Indore', 'Bhopal', 'Gwalior', 'Jabalpur'],
  'West Bengal': <String>['Kolkata', 'Howrah', 'Durgapur', 'Asansol'],
  'Bihar': <String>['Patna', 'Gaya', 'Bhagalpur', 'Muzaffarpur'],
  'Jharkhand': <String>['Ranchi', 'Jamshedpur', 'Dhanbad', 'Bokaro'],
  'Odisha': <String>['Bhubaneswar', 'Cuttack', 'Rourkela'],
};

/// PREVIEW ONLY — not part of the real onboarding/trade-form flow, and does
/// not write anything anywhere. Reachable from Settings so the team can show
/// stakeholders the intended "pick state, then get filtered cities" UX
/// (#1429) before the real backend-driven dataset exists. See
/// [kDemoStateCities]'s own doc — this is real city data, but a small,
/// hand-picked sample, not the authoritative gazetteer.
///
/// Once #1429 ships, the real fix lands in `trade_form_employment_page.dart`
/// (today's free-text employer city/state fields) — THIS screen stays as a
/// throwaway preview and can be deleted then.
class CityStateDemoScreen extends StatefulWidget {
  const CityStateDemoScreen({super.key});

  @override
  State<CityStateDemoScreen> createState() => _CityStateDemoScreenState();
}

class _CityStateDemoScreenState extends State<CityStateDemoScreen> {
  String? _state;
  String? _city;

  void _pickState(String state) {
    setState(() {
      _state = state;
      _city = null; // changing state always clears a stale city pick
    });
  }

  void _pickCity(String city) => setState(() => _city = city);

  void _reset() => setState(() {
    _state = null;
    _city = null;
  });

  @override
  Widget build(BuildContext context) {
    final List<String> cities = kDemoStateCities[_state] ?? const <String>[];
    return Scaffold(
      body: Column(
        children: <Widget>[
          BbBlueHeader(
            title: 'Sheher/State demo',
            subtitle:
                'Preview — asli data KP layenge (#1429). Yeh sirf demo hai.',
            onBack: () => Navigator.of(context).maybePop(),
          ),
          Expanded(
            child: SafeArea(
              top: false,
              // A plain Column, not ListView(children:...) — that variant
              // still lazily materializes elements outside the current
              // viewport (a sliver, same as .builder), so content added
              // after a setState (the city section) can end up with no
              // Element built at all until it scrolls into range. A Column
              // always builds every child eagerly.
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(AppSpacing.gutter),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Container(
                      padding: const EdgeInsets.all(AppSpacing.s3),
                      decoration: BoxDecoration(
                        color: AppColors.paper,
                        borderRadius: BorderRadius.circular(AppRadii.sm),
                        border: Border.all(color: AppColors.borderSubtle),
                      ),
                      child: Text(
                        'Yeh sirf ek preview hai — asli feature ka data '
                        '#1429 se aayega. Yahan chuni gayi state/sheher '
                        'kahin save nahi hoti.',
                        style: AppTypography.body(
                          size: AppTypography.sizeSm,
                          color: AppColors.textMuted,
                        ),
                      ),
                    ),
                    const SizedBox(height: AppSpacing.s5),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: <Widget>[
                              Text(
                                'STATE',
                                style: AppTypography.eyebrow(
                                  color: AppColors.textMuted,
                                ),
                              ),
                              const SizedBox(height: AppSpacing.s1),
                              BbSearchableDropdownField(
                                placeholder: 'STATE CHUNEIN',
                                options: kDemoStateCities.keys.toList(),
                                selected: _state,
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
                              Text(
                                'SHEHER',
                                style: AppTypography.eyebrow(
                                  color: AppColors.textMuted,
                                ),
                              ),
                              const SizedBox(height: AppSpacing.s1),
                              BbSearchableDropdownField(
                                placeholder: 'SHEHER CHUNEIN',
                                options: cities,
                                selected: _city,
                                enabled: _state != null,
                                onSelected: _pickCity,
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    if (_city != null) ...<Widget>[
                      const SizedBox(height: AppSpacing.s5),
                      Text(
                        'YEH DATA JAAYEGA (work-history "Sahar"/"State")',
                        style: AppTypography.eyebrow(
                          color: AppColors.textMuted,
                        ),
                      ),
                      const SizedBox(height: AppSpacing.s2),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.symmetric(
                          horizontal: AppSpacing.s3,
                          vertical: AppSpacing.s3,
                        ),
                        decoration: BoxDecoration(
                          color: AppColors.paper,
                          borderRadius: BorderRadius.circular(AppRadii.sm),
                          border: Border.all(color: AppColors.blue, width: 1.5),
                        ),
                        child: Row(
                          children: <Widget>[
                            const Icon(
                              Icons.location_on_rounded,
                              color: AppColors.blue,
                            ),
                            const SizedBox(width: AppSpacing.s2),
                            Expanded(
                              child: Text(
                                'Sheher: $_city  ·  State: $_state',
                                style: AppTypography.body(
                                  size: AppTypography.sizeMd,
                                  weight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: AppSpacing.s4),
                      TextButton(
                        onPressed: _reset,
                        child: const Text('Dobara try karein'),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
