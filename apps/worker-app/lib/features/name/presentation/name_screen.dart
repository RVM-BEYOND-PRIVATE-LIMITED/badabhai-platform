import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../core/widgets/onboarding/onboarding_select_field.dart';
import '../../../core/widgets/onboarding/questionnaire_bottom_bar.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../router.dart';
import '../domain/indian_locations.dart';
import '../domain/location_lookup.dart';
import 'cubit/name_cubit.dart';

/// "Your name" onboarding step — placed AFTER consent, before chat profiling.
/// Captures the worker's real name ONCE, explicitly, with a clear purpose ("for
/// your resume"). The name goes straight to the API (encrypted at rest) and is
/// never asked for again in the chat flow, which stays identity-free.
///
/// Also captures a coarse location (state + city) — via GPS/network (device
/// geocoder, no backend round-trip) or by hand. See [LocationLookup] for the
/// resolution contract.
///
/// Layout is the master UI kit's Screen 6/10: the Shift Blue header, labelled
/// name inputs, the "SHEHER AUR STATE" section (GPS trigger, then the STATE
/// picker, then the CITY picker — state ALWAYS precedes city), and a docked
/// bottom bar carrying this screen's own Feedback pill beside Continue (which
/// is why the floating Feedback button hides on `/name`, see feedback_fab.dart).
///
/// LOCATION IS ASKED FOR HARD, BUT NEVER TRAPS (#1462). Three rules, and they
/// are one design:
///
///  1. BOTH ways are on screen at ALL times. GPS and the two manual pickers
///     are not rival modes — GPS fills them. A worker who declines the
///     permission, then grants it, still has the GPS button right there.
///  2. Granting the permission MID-FORM is offered back. A GPS failure the
///     worker can fix outside the app arms a check on the next app resume;
///     if GPS became possible and the location is still incomplete, the
///     prompt offers it again.
///  3. Continue is gated on the NAME ONLY, and an empty location opens the
///     same prompt instead. A disabled button cannot ask for what is missing,
///     so it asks — and closing that prompt saves the name without a location
///     (`city`/`state` are optional on `SetMyNameSchema`), which is the one
///     outcome that never leaves a worker stuck on the first screen.
class NameScreen extends StatelessWidget {
  const NameScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<NameCubit>(
      create: (_) => locator<NameCubit>(),
      child: const _NameView(),
    );
  }
}

class _NameView extends StatefulWidget {
  const _NameView();

  @override
  State<_NameView> createState() => _NameViewState();
}

class _NameViewState extends State<_NameView> with WidgetsBindingObserver {
  final TextEditingController _firstNameController = TextEditingController();
  final TextEditingController _lastNameController = TextEditingController();

  /// The picked (or GPS-filled) city and state. Still controllers, not plain
  /// strings, so there is ONE source of truth that GPS, the pickers, submit,
  /// [_hasLocation] and [_gpsConfirmed] all read and write (#1462).
  final TextEditingController _cityController = TextEditingController();
  final TextEditingController _stateController = TextEditingController();

  bool _hasName = false;
  bool _locationLoading = false;
  String? _locationErrorText;

  /// What GPS last resolved. Kept ONLY to decide whether the confirmation line
  /// still describes what is in the fields — the fields themselves are the
  /// single source of truth for what gets submitted.
  ResolvedLocation? _gpsResolved;

  /// The last GPS attempt failed for a reason the worker can fix OUTSIDE the
  /// app (permission declined, or location services off). This — and only
  /// this — arms the resume check that offers GPS again once they fix it.
  bool _gpsRecoverable = false;

  /// One prompt at a time: stops the resume path stacking a second dialog
  /// behind the submit-time one, and vice versa.
  bool _promptOpen = false;

  /// A state/city picker sheet is up. The resume offer waits for it too — a
  /// dialog must not open on top of a sheet the worker is typing into.
  bool _pickerOpen = false;

  LocationLookup get _locationLookup => locator<LocationLookup>();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _firstNameController.addListener(_onNameChanged);
    _lastNameController.addListener(_onNameChanged);
    _cityController.addListener(_onLocationChanged);
    _stateController.addListener(_onLocationChanged);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _firstNameController.dispose();
    _lastNameController.dispose();
    _cityController.dispose();
    _stateController.dispose();
    super.dispose();
  }

  void _onNameChanged() {
    final bool has =
        _firstNameController.text.trim().isNotEmpty &&
        _lastNameController.text.trim().isNotEmpty;
    if (has != _hasName) setState(() => _hasName = has);
  }

  void _onLocationChanged() => setState(() {});

  // BOTH paths produce the SAME pair of fields (#1428): `workers.current_city`
  // / `current_state` are the only location columns the platform has ("City +
  // state only — never an address, never a coordinate", `worker.ts`), so the
  // manual path asks for exactly those two rather than one free-text address
  // line the API would silently drop. The CITY picker always accepts what the
  // worker typed — this is the FIRST screen a worker meets, and it must never
  // refuse the name of the place they actually live in (the server does not
  // gazetteer-check either).
  //
  // GPS writes INTO these same controllers (#1462), so there is one source of
  // truth however the value arrived, and a GPS answer stays editable.
  String get _effectiveCity => _cityController.text.trim();

  String get _effectiveState => _stateController.text.trim();

  bool get _hasLocation =>
      _effectiveCity.isNotEmpty && _effectiveState.isNotEmpty;

  /// True while the fields still hold exactly what GPS put in them — the cue
  /// disappears the moment the worker changes either half, because it would
  /// then be describing something GPS did not say.
  bool get _gpsConfirmed =>
      _gpsResolved != null &&
      _effectiveCity == _gpsResolved!.city &&
      _effectiveState == _gpsResolved!.state;

  // ── (#1462, rule 2) Permission granted mid-form ──────────────────────────
  // A worker who declined the prompt and then turned location on from the
  // notification shade or Settings comes back through `resumed` — the only
  // signal there is. So that is where we ask the OS, SILENTLY, whether GPS is
  // possible now, and offer it if so.
  @override
  void didChangeAppLifecycleState(AppLifecycleState lifecycle) {
    if (lifecycle == AppLifecycleState.resumed) {
      unawaited(_offerGpsIfNowAvailable());
    }
  }

  /// Armed only after a fixable failure, and only while the location is still
  /// incomplete — a worker who already chose their city is not interrupted.
  bool get _shouldOfferGps =>
      _gpsRecoverable &&
      !_locationLoading &&
      !_promptOpen &&
      !_pickerOpen &&
      !_hasLocation;

  Future<void> _offerGpsIfNowAvailable() async {
    if (!_shouldOfferGps) return;
    final bool available = await _locationLookup.isAvailable();
    // Re-check AFTER the await: the worker may have chosen a city, or another
    // prompt may have opened, while the platform channel was answering.
    if (!mounted || !available || !_shouldOfferGps) return;
    setState(() {
      // Offered once per grant. Without this every later resume would re-open
      // the same dialog on a worker who already said no to it.
      _gpsRecoverable = false;
      _locationErrorText = null;
    });
    await _showLocationPrompt(submitOnDismiss: false);
  }

  Future<void> _useCurrentLocation() async {
    setState(() {
      _locationLoading = true;
      _locationErrorText = null;
    });
    try {
      final ResolvedLocation location = await _locationLookup.resolveCurrent();
      if (!mounted) return;
      _cityController.text = location.city;
      _stateController.text = location.state;
      setState(() {
        _gpsResolved = location;
        _locationLoading = false;
        _gpsRecoverable = false;
      });
    } on LocationLookupFailure catch (failure) {
      if (!mounted) return;
      setState(() {
        _locationLoading = false;
        _locationErrorText = _messageFor(failure.reason);
        _gpsRecoverable = _isRecoverable(failure.reason);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _locationLoading = false;
        _locationErrorText = _messageFor(LocationLookupFailureReason.unknown);
        _gpsRecoverable = false;
      });
    }
  }

  /// Can the worker fix this themselves, outside the app? Only a refused
  /// permission or a switched-off location service — a dead geocoder or a
  /// timeout will not be cured by a trip to Settings, so those never arm the
  /// resume offer.
  static bool _isRecoverable(LocationLookupFailureReason reason) {
    switch (reason) {
      case LocationLookupFailureReason.serviceDisabled:
      case LocationLookupFailureReason.permissionDenied:
      case LocationLookupFailureReason.permissionDeniedForever:
        return true;
      case LocationLookupFailureReason.unresolved:
      case LocationLookupFailureReason.unknown:
        return false;
    }
  }

  String _messageFor(LocationLookupFailureReason reason) {
    switch (reason) {
      case LocationLookupFailureReason.serviceDisabled:
        return 'Phone ki location on nahi hai. Neeche khud chunein.';
      case LocationLookupFailureReason.permissionDenied:
      case LocationLookupFailureReason.permissionDeniedForever:
        return 'Location ki permission nahi mili. Neeche khud chunein.';
      case LocationLookupFailureReason.unresolved:
      case LocationLookupFailureReason.unknown:
        return 'Location nahi mil paayi. Neeche khud chunein.';
    }
  }

  // ── Manual pickers ───────────────────────────────────────────────────────

  Future<String?> _openPicker({
    required String title,
    required List<String> options,
    required String selected,
    bool allowCustom = false,
  }) async {
    _pickerOpen = true;
    try {
      return await showOnboardingPicker(
        context,
        title: title,
        options: options,
        selected: selected.isEmpty ? null : selected,
        allowCustom: allowCustom,
        customMaxLength: _kMaxLocationLength,
      );
    } finally {
      _pickerOpen = false;
    }
  }

  /// STATE first (master spec: state always precedes city). The list is the
  /// closed set of states and UTs.
  Future<void> _pickState() async {
    final String? picked = await _openPicker(
      title: 'State chunein',
      options: kIndianStates,
      selected: _effectiveState,
    );
    if (!mounted || picked == null) return;
    // A DIFFERENT state invalidates the city chosen under the old one. The
    // same state under another spelling ("NCT of Delhi" from the geocoder,
    // "Delhi" from the list) is not a different state, so the city stays.
    final String previous = _effectiveState;
    final bool sameState =
        previous == picked ||
        (canonicalIndianState(previous) ?? previous) == picked;
    _stateController.text = picked;
    if (!sameState) _cityController.clear();
  }

  /// CITY second. The list is a suggestion, never a gate: whatever the worker
  /// types can be used as-is (#1428), capped at the server's own 80.
  Future<void> _pickCity() async {
    if (_effectiveState.isEmpty) return;
    final String? picked = await _openPicker(
      title: 'Sheher chunein',
      options: citiesForIndianState(_effectiveState),
      selected: _effectiveCity,
      allowCustom: true,
    );
    if (!mounted || picked == null) return;
    _cityController.text = picked;
  }

  /// The prompt's "Khud chunein": walks the worker through exactly what is
  /// still missing — the State picker if there is no state yet, then the City
  /// picker — rather than dropping them back on the form to hunt for it.
  Future<void> _chooseLocationManually() async {
    if (_effectiveState.isEmpty) {
      await _pickState();
      // Closed the state sheet without choosing: stop, do not stack the city.
      if (!mounted || _effectiveState.isEmpty) return;
    }
    await _pickCity();
  }

  Future<void> _showLocationPrompt({required bool submitOnDismiss}) async {
    if (_promptOpen) return;
    _promptOpen = true;
    final _LocationPromptChoice choice;
    try {
      choice = await _askForLocation(context, submitOnDismiss: submitOnDismiss);
    } finally {
      _promptOpen = false;
    }
    if (!mounted) return;
    switch (choice) {
      case _LocationPromptChoice.gps:
        await _useCurrentLocation();
      case _LocationPromptChoice.manual:
        await _chooseLocationManually();
      case _LocationPromptChoice.dismiss:
        // (#1462, rule 3) Closing the SUBMIT-time prompt skips location and
        // saves the name anyway: `city`/`state` are optional on
        // `SetMyNameSchema` and the cubit sends null for an empty field, so
        // this is a valid call. Closing the mid-form prompt does nothing —
        // there is nothing to submit yet.
        if (submitOnDismiss) _submitNow();
    }
  }

  /// Gated on the NAME ONLY. Location is still asked for — twice, hard — but a
  /// disabled button cannot show the prompt that asks for it (#1462, rule 3).
  bool get _canSubmit => _hasName;

  void _submit(BuildContext context, NameState state) {
    if (!_canSubmit || state.isSubmitting) return;
    if (!_hasLocation) {
      unawaited(_showLocationPrompt(submitOnDismiss: true));
      return;
    }
    _submitNow();
  }

  void _submitNow() {
    if (!_hasName) return;
    final NameCubit cubit = context.read<NameCubit>();
    if (cubit.state.isSubmitting) return;
    final String fullName =
        '${_firstNameController.text.trim()} ${_lastNameController.text.trim()}'
            .trim();
    cubit.submit(fullName, city: _effectiveCity, state: _effectiveState);
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<NameCubit, NameState>(
      listenWhen: (NameState p, NameState c) => p.status != c.status,
      listener: (BuildContext context, NameState state) {
        if (state.status == NameStatus.success) {
          // #381 — go, NOT push. Pushing left the SUBMITTED name screen alive
          // underneath, so system back from the profiling chat dropped the
          // worker onto a name they had already saved, inviting a duplicate
          // submit. Onboarding is a one-way sequence; each completed step
          // replaces the last rather than stacking. (ProfilePreviewScreen
          // already does the same with go(Routes.building).)
          //
          // #1499 — hands to the three-door résumé step rather than straight to
          // the chat. Two of those three doors ARE this line's old destination,
          // reached with the same request sequence, so a worker who has no
          // résumé (or does not want to use it) walks the identical path he
          // walked before the screen existed.
          context.go(Routes.resumeUpload);
        } else if (state.status == NameStatus.failed) {
          ScaffoldMessenger.of(context)
            ..clearSnackBars()
            ..showSnackBar(
              const SnackBar(
                content: Text('Naam save nahi hua. Dobara koshish karein.'),
              ),
            );
        }
      },
      builder: (BuildContext context, NameState state) {
        final NavigatorState navigator = Navigator.of(context);
        return Scaffold(
          backgroundColor: OnboardingColors.canvasBg,
          body: Column(
            children: <Widget>[
              // The header bleeds under the status bar and pads the top inset
              // itself. Reached via `go` from consent, so the back arrow shows
              // only when there is genuinely something to pop to.
              ShiftBlueHeader(
                title: 'Aapka naam?',
                subtitle:
                    'Yeh sirf aapke resume par chhapega. Hum ise kisi '
                    'aur ko nahi dikhate.',
                onBack: navigator.canPop() ? navigator.maybePop : null,
              ),
              Expanded(
                child: SafeArea(
                  top: false,
                  bottom: false,
                  child: OnboardingBody(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        const _MicroLabel('PEHLA NAAM (FIRST NAME)'),
                        _NameField(
                          controller: _firstNameController,
                          hint: 'Jaise: Asha / Ramesh',
                          autofocus: true,
                          onSubmitted: (_) => _submit(context, state),
                        ),
                        const SizedBox(height: 16),
                        const _MicroLabel('AAKHRI NAAM (LAST NAME)'),
                        _NameField(
                          controller: _lastNameController,
                          hint: 'Jaise: Kumari / Kumar',
                          onSubmitted: (_) => _submit(context, state),
                        ),
                        const SizedBox(height: 24),
                        const _MicroLabel('SHEHER AUR STATE'),
                        _LocationSection(
                          loading: _locationLoading,
                          errorText: _locationErrorText,
                          gpsConfirmed: _gpsConfirmed,
                          state: _effectiveState,
                          city: _effectiveCity,
                          onUseCurrentLocation: _useCurrentLocation,
                          onPickState: _pickState,
                          onPickCity: _pickCity,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              // Docked outside the scroll; the bar pads the bottom inset itself.
              QuestionnaireBottomBar(
                // The label still says what is happening for screen readers
                // while the spinner replaces it on screen.
                nextLabel: state.isSubmitting ? 'Saving…' : 'Continue',
                isLoading: state.isSubmitting,
                onNext: (_canSubmit && !state.isSubmitting)
                    ? () => _submit(context, state)
                    : null,
                leading: _FeedbackPill(
                  // This screen owns its Feedback action (the floating button
                  // hides on /name). The route travels as `extra`, exactly as
                  // the floating button sends it.
                  onTap: () =>
                      context.push(Routes.feedback, extra: Routes.name),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// The server's own cap on `current_city` / `current_state`.
const int _kMaxLocationLength = 80;

/// The kit's uppercase field micro-label, with the gap to its field below.
class _MicroLabel extends StatelessWidget {
  const _MicroLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(text, style: OnboardingTypography.fieldMicroLabel()),
    );
  }
}

class _NameField extends StatelessWidget {
  const _NameField({
    required this.controller,
    required this.hint,
    this.autofocus = false,
    this.onSubmitted,
  });

  final TextEditingController controller;
  final String hint;
  final bool autofocus;
  final ValueChanged<String>? onSubmitted;

  static OutlineInputBorder _border(Color color, double width) =>
      OutlineInputBorder(
        borderRadius: BorderRadius.circular(OnboardingRadii.nameField),
        borderSide: BorderSide(color: color, width: width),
      );

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      textCapitalization: TextCapitalization.words,
      textInputAction: TextInputAction.next,
      maxLength: 40,
      autofocus: autofocus,
      onSubmitted: onSubmitted,
      style: OnboardingTypography.inter(size: 14, weight: FontWeight.w500),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: OnboardingTypography.inter(
          size: 14,
          color: OnboardingColors.ink500,
        ),
        counterText: '',
        filled: true,
        fillColor: OnboardingColors.paperWhite,
        isDense: true,
        constraints: const BoxConstraints(
          minHeight: OnboardingLayout.tapTarget,
        ),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 14,
          vertical: 15,
        ),
        border: _border(OnboardingColors.borderDefault, 1.2),
        enabledBorder: _border(OnboardingColors.borderDefault, 1.2),
        // Spec §3.3's one focus rule (D8): navy at 1.8. Yellow is reserved for
        // a SELECTED card, chip or checkbox — an input is never selected.
        focusedBorder: _border(OnboardingColors.shiftBlue, 1.8),
      ),
    );
  }
}

/// Location capture — GPS **and** the manual pickers, on screen at ALL times.
///
/// #1462: this used to render exactly ONE of three states (a resolved summary
/// card, a "use my location" prompt, or the manual boxes). A worker who
/// declined the permission was switched into manual mode and the GPS button
/// VANISHED, so turning the permission on afterwards left no way back to it.
///
/// There is now a single layout — GPS button on top, the STATE then CITY
/// pickers below, always — and GPS is a FILLER for those fields rather than a
/// rival mode: a successful fix writes its answer into them, where it stays
/// changeable and where the submit path reads it from either way. Nothing
/// here is ever hidden, so no state can strand the worker on one of the two
/// paths.
class _LocationSection extends StatelessWidget {
  const _LocationSection({
    required this.loading,
    required this.errorText,
    required this.gpsConfirmed,
    required this.state,
    required this.city,
    required this.onUseCurrentLocation,
    required this.onPickState,
    required this.onPickCity,
  });

  final bool loading;
  final String? errorText;
  final bool gpsConfirmed;
  final String state;
  final String city;
  final VoidCallback onUseCurrentLocation;
  final VoidCallback onPickState;
  final VoidCallback onPickCity;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _GpsButton(
          loading: loading,
          // Disabled ONLY while a fix is in flight — never because of a past
          // refusal, which is exactly the state this button has to rescue.
          onPressed: loading ? null : onUseCurrentLocation,
        ),
        const SizedBox(height: 10),
        _LocationHint(errorText: errorText, gpsConfirmed: gpsConfirmed),
        const SizedBox(height: 16),
        const _MicroLabel('STATE (RAJYA)'),
        OnboardingSelectField(
          value: state,
          hint: 'State chunein (Select State)',
          semanticLabel: 'State',
          onTap: onPickState,
        ),
        const SizedBox(height: 16),
        const _MicroLabel('SHEHER (CITY)'),
        OnboardingSelectField(
          value: city,
          hint: 'Sheher chunein (Select City)',
          semanticLabel: 'Sheher',
          // A city list only means something inside a state.
          enabled: state.isNotEmpty,
          onTap: onPickCity,
        ),
      ],
    );
  }
}

/// The kit's secondary GPS trigger: white, 1.5px Shift Blue border, 10 radius,
/// 48px, `my_location` icon.
class _GpsButton extends StatelessWidget {
  const _GpsButton({required this.loading, required this.onPressed});

  final bool loading;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return _OutlineActionButton(
      label: loading ? 'Location dhoondh rahe hain…' : 'Location se bharein',
      icon: Icons.my_location_rounded,
      loading: loading,
      onPressed: onPressed,
    );
  }
}

/// White button with a 1.5px Shift Blue border — the GPS trigger on the form
/// and the "Khud chunein" choice in the prompt.
class _OutlineActionButton extends StatelessWidget {
  const _OutlineActionButton({
    required this.label,
    required this.onPressed,
    this.icon,
    this.loading = false,
  });

  final String label;
  final IconData? icon;
  final bool loading;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: SizedBox(
        height: OnboardingLayout.tapTarget,
        child: OutlinedButton(
          onPressed: onPressed,
          style: OutlinedButton.styleFrom(
            backgroundColor: OnboardingColors.paperWhite,
            foregroundColor: OnboardingColors.shiftBlue,
            // Keep the navy frame while a fix is in flight; only the spinner
            // says "busy", so the button never looks like it vanished.
            disabledForegroundColor: OnboardingColors.shiftBlue,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            side: const BorderSide(
              color: OnboardingColors.shiftBlue,
              width: 1.5,
            ),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(OnboardingRadii.nameField),
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (loading)
                const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: OnboardingColors.shiftBlue,
                  ),
                )
              else if (icon != null)
                Icon(icon, size: 20, color: OnboardingColors.shiftBlue),
              if (loading || icon != null) const SizedBox(width: 8),
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: OnboardingTypography.inter(
                    size: 14,
                    weight: FontWeight.w600,
                    color: OnboardingColors.shiftBlue,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The one line between the GPS button and the pickers. It says the most
/// useful true thing about the last GPS attempt: why it failed, that it
/// worked, or — before any attempt — that choosing by hand is equally fine.
class _LocationHint extends StatelessWidget {
  const _LocationHint({required this.errorText, required this.gpsConfirmed});

  final String? errorText;
  final bool gpsConfirmed;

  @override
  Widget build(BuildContext context) {
    if (errorText != null) {
      return Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Padding(
            padding: EdgeInsets.only(top: 1),
            child: Icon(
              Icons.error_outline_rounded,
              size: 16,
              color: OnboardingColors.errorRed,
            ),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              errorText!,
              style: OnboardingTypography.inter(
                size: 13,
                height: 1.35,
                color: OnboardingColors.errorRed,
              ),
            ),
          ),
        ],
      );
    }
    if (gpsConfirmed) {
      return Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Padding(
            padding: EdgeInsets.only(top: 1),
            child: Icon(
              Icons.check_rounded,
              size: 16,
              color: OnboardingColors.successGreen,
            ),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              'Location mil gayi. Galat ho toh neeche badal sakte hain.',
              style: OnboardingTypography.inter(
                size: 13,
                height: 1.35,
                weight: FontWeight.w500,
                color: OnboardingColors.successGreen,
              ),
            ),
          ),
        ],
      );
    }
    return Text(
      'Ya sheher aur state neeche khud chunein:',
      style: OnboardingTypography.bodyMuted(),
    );
  }
}

/// This screen's Feedback action, docked left of Continue: the SAME pill the
/// app-wide floating Feedback button draws (D9) — navy, 12 radius, 48dp tall,
/// `chat_bubble_outline_rounded` 16 over an Inter 13 w700 white label — because
/// the two are the same action and only ever appear one at a time.
class _FeedbackPill extends StatelessWidget {
  const _FeedbackPill({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      child: Material(
        color: OnboardingColors.shiftBlue,
        borderRadius: BorderRadius.circular(OnboardingRadii.feedbackButton),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(OnboardingRadii.feedbackButton),
          child: Container(
            height: OnboardingLayout.tapTarget,
            padding: const EdgeInsets.symmetric(horizontal: 14),
            alignment: Alignment.center,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                const Icon(
                  Icons.chat_bubble_outline_rounded,
                  size: 16,
                  color: OnboardingColors.textOnBlue,
                ),
                const SizedBox(width: 8),
                Text(
                  'Feedback',
                  style: OnboardingTypography.inter(
                    size: 13,
                    weight: FontWeight.w700,
                    color: OnboardingColors.textOnBlue,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// What the worker picked in the location prompt.
enum _LocationPromptChoice { gps, manual, dismiss }

/// The location prompt (#1462, rules 2 and 3) — the ONE modal that asks for a
/// location the worker has not given, and offers both ways to give it.
///
/// Two callers, one dialog:
///
///  - MID-FORM ([submitOnDismiss] false). The worker declined the permission,
///    then granted it while filling the form. Closing just closes.
///  - AT SUBMIT ([submitOnDismiss] true). Continue was tapped with the
///    location incomplete. Closing SKIPS location and saves the name anyway —
///    valid on the wire, since `city`/`state` are optional on
///    `SetMyNameSchema`.
///
/// Chrome is the onboarding kit's: white card, 16-radius corners, elevation 0
/// (separation is the scrim + fill, never a shadow), an Anek title over an
/// Inter body, the yellow GPS action over the navy-outlined manual one. The
/// actions are Row + Expanded rather than full-width children because
/// [AlertDialog] wraps its content in an `IntrinsicWidth`, which throws on an
/// infinite-width child.
///
/// `barrierDismissible: false` so the choice is always explicit — the close
/// action is always present, so this asks without ever trapping. A pop from
/// anywhere else (system back) is read as that same close.
Future<_LocationPromptChoice> _askForLocation(
  BuildContext context, {
  required bool submitOnDismiss,
}) async {
  final _LocationPromptChoice? choice = await showDialog<_LocationPromptChoice>(
    context: context,
    barrierDismissible: false,
    barrierColor: AppColors.scrim,
    builder: (BuildContext dialogContext) {
      void close(_LocationPromptChoice value) =>
          Navigator.of(dialogContext).pop(value);

      return AlertDialog(
        // Scrolls rather than overflowing on a 320x568 phone at a large
        // system font, where title + copy + three 48px actions exceed it.
        scrollable: true,
        backgroundColor: OnboardingColors.paperWhite,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(OnboardingRadii.card)),
        ),
        titlePadding: const EdgeInsets.fromLTRB(24, 24, 24, 10),
        contentPadding: const EdgeInsets.fromLTRB(24, 0, 24, 16),
        title: Text(
          submitOnDismiss ? 'Location reh gayi' : 'Location ab mil sakti hai',
          textAlign: TextAlign.center,
          style: OnboardingTypography.questionHeadline(
            color: OnboardingColors.shiftBlue,
          ),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(
              submitOnDismiss
                  ? 'Jobs aapke sheher ke hisaab se aati hain. GPS se bhar '
                        'dein, ya sheher aur state khud chunein.'
                  : 'Ab GPS se aapka sheher aur state apne aap bhar sakte '
                        'hain, ya khud chunein.',
              textAlign: TextAlign.center,
              style: OnboardingTypography.body(color: OnboardingColors.ink600),
            ),
            const SizedBox(height: 20),
            Row(
              children: <Widget>[
                Expanded(
                  child: _PromptPrimaryButton(
                    label: 'Location se bharein',
                    icon: Icons.my_location_rounded,
                    onPressed: () => close(_LocationPromptChoice.gps),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: <Widget>[
                Expanded(
                  child: _OutlineActionButton(
                    label: 'Khud chunein',
                    onPressed: () => close(_LocationPromptChoice.manual),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            SizedBox(
              height: OnboardingLayout.tapTarget,
              child: TextButton(
                onPressed: () => close(_LocationPromptChoice.dismiss),
                style: TextButton.styleFrom(
                  foregroundColor: OnboardingColors.ink600,
                ),
                child: Text(
                  // The submit-time close is a SKIP, and says so — a worker who
                  // taps it must know the name saves without a location, not
                  // that they were sent back to try again.
                  submitOnDismiss
                      ? 'Bina location aage badhein'
                      : 'Band karein',
                  textAlign: TextAlign.center,
                  style: OnboardingTypography.inter(
                    size: 14,
                    weight: FontWeight.w600,
                    color: OnboardingColors.ink600,
                  ),
                ),
              ),
            ),
          ],
        ),
      );
    },
  );
  return choice ?? _LocationPromptChoice.dismiss;
}

/// The prompt's yellow GPS action — the kit's primary fill at the 48px bar
/// size, sized by its [Expanded] parent (see [_askForLocation] on why it is
/// not a full-width child).
class _PromptPrimaryButton extends StatelessWidget {
  const _PromptPrimaryButton({
    required this.label,
    required this.icon,
    required this.onPressed,
  });

  final String label;
  final IconData icon;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: SizedBox(
        height: OnboardingLayout.tapTarget,
        child: ElevatedButton(
          onPressed: onPressed,
          style: ElevatedButton.styleFrom(
            backgroundColor: OnboardingColors.safetyYellow,
            foregroundColor: OnboardingColors.shiftBlue,
            elevation: 0,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(
                OnboardingRadii.feedbackButton,
              ),
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(icon, size: 20, color: OnboardingColors.shiftBlue),
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: OnboardingTypography.buttonLabel(),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
