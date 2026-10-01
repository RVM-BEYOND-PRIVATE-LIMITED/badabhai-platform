import 'package:flutter/material.dart';

import '../../../../core/di/locator.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/onboarding/onboarding_select_field.dart';
import '../../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../name/domain/indian_locations.dart';
import '../../../name/domain/location_lookup.dart';

/// ADR-0048 — THE WHOLE LOCATION, ANSWERED ONCE, INSIDE THE CHAT.
///
/// WHY THIS REPLACED TWO CHIP ROWS. The intake asks state and city as two
/// separate turns, and the app first answered each with the chat's horizontal
/// chip scroller. For a closed list of 36 states that is the wrong instrument:
/// a worker scrolls sideways through three dozen chips to find one, then
/// repeats it for the city, with no way to correct the state once past it and
/// no sight of the pair they are actually giving. `/name` never did that to
/// them — it showed both pickers and a GPS button on one screen — and moving
/// the question into the chat must not cost them that.
///
/// ONE CARD, ONE "Theek hai". Both pickers, the GPS trigger and the confirm
/// live together, and the chat does not move on until the worker presses it.
/// The two wire answers are still sent one after the other, because the SERVER
/// still asks two questions — it holds the state until the city arrives and
/// writes `current_state`/`current_city` together (`identity-intake.ts`), so a
/// pair answered in one breath lands exactly as the form's single PATCH did.
///
/// GPS FILLS, IT NEVER DECIDES. A fix drops into both pickers and stays
/// editable; every failure says what actually went wrong — the phone's location
/// is off, the permission was refused, nothing resolved — and leaves the
/// pickers to be used by hand. That is `/name`'s #1462 rule, kept: the two ways
/// are never rival modes, and a refusal is never a dead end.
///
/// FREE TEXT SURVIVES. The city picker allows a typed value (`allowCustom`),
/// because the city lists are suggestions and the server canonicalises whatever
/// is sent — "never refuses the name of the place they actually live in".
class ChatLocationCard extends StatefulWidget {
  const ChatLocationCard({
    super.key,
    required this.askCity,
    required this.askState,
    required this.onSubmit,
    this.knownState,
    this.lookup,
  });

  /// Whether this card must collect the STATE. False when the worker's record
  /// already has one and only the city is missing.
  final bool askState;

  /// Whether this card must collect the CITY.
  final bool askCity;

  /// The state already on the record, used to seed the city list when only the
  /// city is being asked.
  final String? knownState;

  /// Called once, on "Theek hai", with whatever the card collected. A value it
  /// was not asked for comes back null.
  final void Function({String? state, String? city}) onSubmit;

  /// Injectable ONLY so a widget test can supply a fake; production resolves the
  /// registered one. The plugin graph is never touched until the worker presses
  /// the GPS button.
  final LocationLookup? lookup;

  @override
  State<ChatLocationCard> createState() => _ChatLocationCardState();
}

class _ChatLocationCardState extends State<ChatLocationCard> {
  String _state = '';
  String _city = '';
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _state = widget.knownState ?? '';
  }

  LocationLookup? get _lookup {
    final LocationLookup? injected = widget.lookup;
    if (injected != null) return injected;
    return locator.isRegistered<LocationLookup>()
        ? locator<LocationLookup>()
        : null;
  }

  /// "Abhi ki location lein" — one fix, into both pickers.
  Future<void> _useCurrentLocation() async {
    final LocationLookup? lookup = _lookup;
    if (lookup == null || _loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final ResolvedLocation location = await lookup.resolveCurrent();
      if (!mounted) return;
      setState(() {
        _state = location.state;
        _city = location.city;
        _loading = false;
      });
    } on LocationLookupFailure catch (failure) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = kChatLocationGpsErrors[failure.reason];
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = kChatLocationGpsErrors[LocationLookupFailureReason.unknown];
      });
    }
  }

  Future<void> _pickState() async {
    final String? picked = await showOnboardingPicker(
      context,
      title: 'State chunein',
      options: kIndianStates,
      selected: _state.isEmpty ? null : _state,
    );
    if (picked == null || !mounted) return;
    setState(() {
      // A new state invalidates the city under it — silently keeping the old
      // one is how a worker ends up filed under a city their state has not got.
      if (picked != _state) _city = '';
      _state = picked;
      _error = null;
    });
  }

  Future<void> _pickCity() async {
    final String? picked = await showOnboardingPicker(
      context,
      title: 'Sheher chunein',
      options: citiesForIndianState(_state),
      selected: _city.isEmpty ? null : _city,
      // The lists are suggestions, never a gate (#1428).
      allowCustom: true,
    );
    if (picked == null || !mounted) return;
    setState(() {
      _city = picked;
      _error = null;
    });
  }

  /// Everything this card was asked for has an answer.
  bool get _complete =>
      (!widget.askState || _state.trim().isNotEmpty) &&
      (!widget.askCity || _city.trim().isNotEmpty);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s1,
        AppSpacing.s4,
        AppSpacing.s2,
      ),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: OnboardingColors.paperWhite,
          borderRadius: BorderRadius.circular(OnboardingRadii.card),
          border: Border.all(color: OnboardingColors.borderCard),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            // BOTH WAYS ARE ON SCREEN AT ONCE (#1462): a worker who refuses the
            // permission still has the pickers, and one who grants it later
            // still has the button.
            OutlinedButton.icon(
              onPressed: _loading ? null : _useCurrentLocation,
              icon: _loading
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.my_location, size: 18),
              label: Text(
                _loading ? kChatLocationGpsBusy : kChatLocationGpsCta,
                style: OnboardingTypography.buttonLabel(
                  color: OnboardingColors.shiftBlue,
                ),
              ),
              style: OutlinedButton.styleFrom(
                foregroundColor: OnboardingColors.shiftBlue,
                side: const BorderSide(
                  color: OnboardingColors.shiftBlue,
                  width: 1.5,
                ),
                minimumSize: const Size(double.infinity, 48),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(OnboardingRadii.button),
                ),
              ),
            ),
            if (_error != null) ...<Widget>[
              const SizedBox(height: 8),
              Text(
                _error!,
                style: OnboardingTypography.inter(
                  size: 12,
                  height: 1.35,
                  color: OnboardingColors.errorRed,
                ),
              ),
            ],
            const SizedBox(height: 14),
            Text(
              kChatLocationOrLabel,
              style: OnboardingTypography.inter(
                size: 12,
                color: OnboardingColors.ink500,
              ),
            ),
            const SizedBox(height: 10),
            if (widget.askState) ...<Widget>[
              Text(
                kChatLocationStateLabel,
                style: OnboardingTypography.inter(
                  size: 11,
                  weight: FontWeight.w700,
                  color: OnboardingColors.ink600,
                ),
              ),
              const SizedBox(height: 6),
              OnboardingSelectField(
                value: _state,
                hint: 'State chunein',
                semanticLabel: 'State',
                onTap: _pickState,
              ),
              const SizedBox(height: 14),
            ],
            if (widget.askCity) ...<Widget>[
              Text(
                kChatLocationCityLabel,
                style: OnboardingTypography.inter(
                  size: 11,
                  weight: FontWeight.w700,
                  color: OnboardingColors.ink600,
                ),
              ),
              const SizedBox(height: 6),
              OnboardingSelectField(
                value: _city,
                hint: 'Sheher chunein',
                semanticLabel: 'Sheher',
                // A city list only means something inside a state.
                enabled: _state.trim().isNotEmpty,
                onTap: _pickCity,
              ),
              const SizedBox(height: 14),
            ],
            // NOTHING IS SENT UNTIL THIS IS PRESSED. The chat's next question
            // waits on it, so a worker can change their mind about the state
            // after choosing a city — which the two-chip-rows version made
            // impossible.
            PrimaryActionButton(
              label: kChatLocationConfirm,
              showArrow: false,
              onPressed: _complete
                  ? () => widget.onSubmit(
                        state: widget.askState ? _state.trim() : null,
                        city: widget.askCity ? _city.trim() : null,
                      )
                  : null,
            ),
          ],
        ),
      ),
    );
  }
}

/// The card's copy. Hinglish, aap-form, like the rest of the chat.
const String kChatLocationGpsCta = 'Abhi ki location lein';
const String kChatLocationGpsBusy = 'Location dhoondh rahe hain…';
const String kChatLocationOrLabel = 'Ya khud chunein';
const String kChatLocationStateLabel = 'STATE (RAJYA)';
const String kChatLocationCityLabel = 'SHEHER (CITY)';
const String kChatLocationConfirm = 'Theek hai';

/// What each GPS failure says — the REAL cause, never "check your internet",
/// and always with the way forward (the pickers are right below it).
const Map<LocationLookupFailureReason, String> kChatLocationGpsErrors =
    <LocationLookupFailureReason, String>{
  LocationLookupFailureReason.serviceDisabled:
      'Phone ki location on nahi hai. Neeche khud chunein.',
  LocationLookupFailureReason.permissionDenied:
      'Location ki permission nahi mili. Neeche khud chunein.',
  LocationLookupFailureReason.permissionDeniedForever:
      'Location ki permission nahi mili. Neeche khud chunein.',
  LocationLookupFailureReason.unresolved:
      'Location nahi mil paayi. Neeche khud chunein.',
  LocationLookupFailureReason.unknown:
      'Location nahi mil paayi. Neeche khud chunein.',
};
