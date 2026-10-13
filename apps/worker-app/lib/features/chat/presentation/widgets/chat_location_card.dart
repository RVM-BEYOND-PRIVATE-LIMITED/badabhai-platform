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
///
/// OWNER ASK (2026-10-12). The card is now shown in a NON-CANCELABLE dialog (see
/// [showChatLocationDialog]) and gains a small red "help karein" affordance at
/// its top-right: a worker who cannot get a GPS fix or cannot find their city in
/// the list taps it and the CITY dropdown becomes a free-text field.
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

  /// OWNER ASK — true once "help karein" is tapped: the city dropdown is a
  /// free-text field instead, for a worker whose city is not in the list.
  bool _cityManual = false;
  late final TextEditingController _cityController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _state = widget.knownState ?? '';
  }

  @override
  void dispose() {
    _cityController.dispose();
    super.dispose();
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
        // A fix also fills the manual field, so switching to typing later keeps
        // what the GPS found.
        if (_cityManual) _cityController.text = location.city;
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

  /// The top-right toggle: dropdown ⇄ free text. Entering the manual view seeds
  /// the field with whatever is in it now; leaving it keeps the typed value as
  /// the field's value (the picker shows any value).
  void _toggleCityMode() {
    setState(() {
      _cityManual = !_cityManual;
      if (_cityManual) _cityController.text = _city;
      _error = null;
    });
  }

  /// Everything this card was asked for has an answer.
  bool get _complete =>
      (!widget.askState || _state.trim().isNotEmpty) &&
      (!widget.askCity || _city.trim().isNotEmpty);

  static OutlineInputBorder _fieldBorder(Color color, double width) =>
      OutlineInputBorder(
        borderRadius: BorderRadius.circular(OnboardingRadii.nameField),
        borderSide: BorderSide(color: color, width: width),
      );

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
            // OWNER ASK — the top-right TOGGLE: a worker who cannot find their
            // city in the list taps "city khud bharein" and types it; the same
            // spot then reads "city select kren" and swaps the dropdown back.
            if (widget.askCity)
              Align(
                alignment: Alignment.centerRight,
                child: Semantics(
                  button: true,
                  label: _cityManual
                      ? kChatLocationDropdownToggle
                      : kChatLocationManualCityToggle,
                  child: InkWell(
                    onTap: _toggleCityMode,
                    borderRadius: BorderRadius.circular(4),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 2,
                        vertical: 4,
                      ),
                      child: Text(
                        _cityManual
                            ? kChatLocationDropdownToggle
                            : kChatLocationManualCityToggle,
                        style: OnboardingTypography.inter(
                          size: 12,
                          weight: FontWeight.w600,
                          color: OnboardingColors.errorRed,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
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
              if (_cityManual)
                TextField(
                  controller: _cityController,
                  textCapitalization: TextCapitalization.words,
                  maxLength: 80,
                  style: OnboardingTypography.inter(
                    size: 14,
                    weight: FontWeight.w500,
                  ),
                  onChanged: (String value) => setState(() {
                    _city = value;
                    _error = null;
                  }),
                  decoration: InputDecoration(
                    hintText: kChatLocationCityManualHint,
                    hintStyle: OnboardingTypography.inter(
                      size: 14,
                      color: OnboardingColors.ink500,
                    ),
                    counterText: '',
                    filled: true,
                    fillColor: OnboardingColors.paperWhite,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 14,
                      vertical: 14,
                    ),
                    enabledBorder: _fieldBorder(
                      OnboardingColors.borderDefault,
                      1.2,
                    ),
                    // Spec §3.3: a focused input rings navy at 1.8.
                    focusedBorder: _fieldBorder(
                      OnboardingColors.shiftBlue,
                      1.8,
                    ),
                  ),
                )
              else
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

/// OWNER ASK (2026-10-12) — the location pickers as a NON-CANCELABLE dialog.
///
/// The inline card became a modal so the worker answers the location in one
/// focused step: the scrim blocks the rest of the chat (and its composer/mic),
/// tapping outside does nothing, and the system back is swallowed — the ONLY
/// way out is "Theek hai".
///
/// [onSubmit] fires once, AFTER the dialog is closed, with whatever the worker
/// chose. The caller must guard against opening a second dialog (the chat screen
/// keeps its own open-guard).
Future<void> showChatLocationDialog(
  BuildContext context, {
  required bool askState,
  required String? knownState,
  required void Function({String? state, String? city}) onSubmit,
  LocationLookup? lookup,
}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (BuildContext dialogContext) => PopScope(
      // Non-cancelable: the back button/gesture must not dismiss the question.
      canPop: false,
      child: Dialog(
        backgroundColor: Colors.transparent,
        elevation: 0,
        insetPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 24),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: OnboardingLayout.maxContentWidth,
            // A short phone with a large font scrolls the card rather than
            // clipping the confirm button out of reach.
            maxHeight: MediaQuery.sizeOf(dialogContext).height * 0.86,
          ),
          child: SingleChildScrollView(
            child: ChatLocationCard(
              askState: askState,
              askCity: true,
              knownState: knownState,
              lookup: lookup,
              onSubmit: ({String? state, String? city}) {
                // Close first, then send: the worker is returned to the chat as
                // the next turn is posted.
                Navigator.of(dialogContext).pop();
                onSubmit(state: state, city: city);
              },
            ),
          ),
        ),
      ),
    ),
  );
}

/// The card's copy. Hinglish, aap-form, like the rest of the chat.
const String kChatLocationGpsCta = 'Abhi ki location lein';
const String kChatLocationGpsBusy = 'Location dhoondh rahe hain…';
const String kChatLocationOrLabel = 'Ya khud chunein';
const String kChatLocationStateLabel = 'STATE (RAJYA)';
const String kChatLocationCityLabel = 'SHEHER (CITY)';
const String kChatLocationConfirm = 'Theek hai';

/// OWNER ASK (2026-10-12) — the top-right TOGGLE on the dialog. In the default
/// view it reads [kChatLocationManualCityToggle] ("city khud bharein") and swaps
/// the city dropdown for a free-text field; once typing, it reads
/// [kChatLocationDropdownToggle] ("city select kren") and swaps the dropdown
/// back.
const String kChatLocationManualCityToggle = 'city khud bharein';
const String kChatLocationDropdownToggle = 'city select kren';

/// The manual city field's hint.
const String kChatLocationCityManualHint = 'Sheher likhein';

/// The composer hint shown INSTEAD of the keyboard while the location dialog is
/// up (the dialog is the only answer path).
const String kChatLocationDialogHint = 'Location dialog mein chunein';

/// OWNER ASK (2026-10-12) — the button offered for a location question that came
/// back after the app was closed (or backed out): tapping it opens the dialog.
const String kChatLocationRestoreLabel = 'Location bharein';

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
