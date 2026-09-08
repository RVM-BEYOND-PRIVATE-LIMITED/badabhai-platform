import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../router.dart';
import '../domain/location_lookup.dart';
import 'cubit/name_cubit.dart';

/// "Your name" onboarding step — placed AFTER consent, before chat profiling.
/// Captures the worker's real name ONCE, explicitly, with a clear purpose ("for
/// your resume"). The name goes straight to the API (encrypted at rest) and is
/// never asked for again in the chat flow, which stays identity-free.
///
/// Also captures a coarse location (city + state) — via GPS/network (device
/// geocoder, no backend round-trip) or by hand. See [LocationLookup] for the
/// resolution contract.
///
/// LOCATION IS ASKED FOR HARD, BUT NEVER TRAPS (#1462). Three rules, and they
/// are one design:
///
///  1. BOTH ways are on screen at ALL times. GPS and the two manual boxes are
///     not rival modes — GPS fills the boxes. A worker who declines the
///     permission, then grants it, still has the GPS button right there.
///  2. Granting the permission MID-FORM is offered back. A GPS failure the
///     worker can fix outside the app arms a check on the next app resume;
///     if GPS became possible and both boxes are still empty, the prompt
///     offers it again.
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
  final TextEditingController _cityController = TextEditingController();
  final TextEditingController _stateController = TextEditingController();

  /// Focused when the worker picks "Khud likhein" in the prompt — the prompt
  /// closes onto the box it just told them to use, rather than onto a screen
  /// they have to hunt through.
  final FocusNode _cityFocus = FocusNode();

  bool _hasName = false;
  bool _locationLoading = false;
  String? _locationErrorText;

  /// What GPS last resolved. Kept ONLY to decide whether the confirmation line
  /// still describes what is in the boxes — the boxes themselves are the
  /// single source of truth for what gets submitted.
  ResolvedLocation? _gpsResolved;

  /// The last GPS attempt failed for a reason the worker can fix OUTSIDE the
  /// app (permission declined, or location services off). This — and only
  /// this — arms the resume check that offers GPS again once they fix it.
  bool _gpsRecoverable = false;

  /// One prompt at a time: stops the resume path stacking a second dialog
  /// behind the submit-time one, and vice versa.
  bool _promptOpen = false;

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
    _cityFocus.dispose();
    super.dispose();
  }

  void _onNameChanged() {
    final bool has = _firstNameController.text.trim().isNotEmpty &&
        _lastNameController.text.trim().isNotEmpty;
    if (has != _hasName) setState(() => _hasName = has);
  }

  void _onLocationChanged() => setState(() {});

  // BOTH paths produce the SAME pair of fields (#1428): `workers.current_city`
  // / `current_state` are the only location columns the platform has ("City +
  // state only — never an address, never a coordinate", `worker.ts`), so the
  // manual boxes ask for exactly those two rather than one free-text address
  // line the API would silently drop. Free text on purpose — this is the
  // FIRST screen a worker meets, and it must never refuse the name of the
  // place they actually live in (the server does not gazetteer-check either).
  //
  // GPS writes INTO these same controllers (#1462), so there is one source of
  // truth however the value arrived, and a GPS answer stays editable.
  String get _effectiveCity => _cityController.text.trim();

  String get _effectiveState => _stateController.text.trim();

  bool get _hasLocation =>
      _effectiveCity.isNotEmpty && _effectiveState.isNotEmpty;

  /// True while the boxes still hold exactly what GPS put in them — the cue
  /// disappears the moment the worker edits either half, because it would then
  /// be describing something GPS did not say.
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

  /// Armed only after a fixable failure, and only while BOTH boxes are still
  /// empty — a worker who already typed their city is not interrupted.
  bool get _shouldOfferGps =>
      _gpsRecoverable && !_locationLoading && !_promptOpen && !_hasLocation;

  Future<void> _offerGpsIfNowAvailable() async {
    if (!_shouldOfferGps) return;
    final bool available = await _locationLookup.isAvailable();
    // Re-check AFTER the await: the worker may have typed a city, or another
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
        return 'Phone ki location on nahi hai. Neeche khud likhein.';
      case LocationLookupFailureReason.permissionDenied:
      case LocationLookupFailureReason.permissionDeniedForever:
        return 'Location ki permission nahi mili. Neeche khud likhein.';
      case LocationLookupFailureReason.unresolved:
      case LocationLookupFailureReason.unknown:
        return 'Location nahi mil paayi. Neeche khud likhein.';
    }
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
        _cityFocus.requestFocus();
      case _LocationPromptChoice.dismiss:
        // (#1462, rule 3) Closing the SUBMIT-time prompt skips location and
        // saves the name anyway: `city`/`state` are optional on
        // `SetMyNameSchema` and the cubit sends null for an empty box, so this
        // is a valid call. Closing the mid-form prompt does nothing — there is
        // nothing to submit yet.
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
    cubit.submit(
      fullName,
      city: _effectiveCity,
      state: _effectiveState,
    );
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
          context.go(Routes.chatProfiling);
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
        // Kit onboarding pattern (screens 02/06): a full-bleed deep-blue header
        // band (haldi title + muted subtitle) over a padded body with the
        // labelled fields and the primary CTA.
        return Scaffold(
          // SafeArea(top: false) — the blue header intentionally bleeds under
          // the status bar (it pads the top inset itself); this keeps the CTA
          // clear of the bottom gesture-nav inset.
          body: SafeArea(
            top: false,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Container(
                  width: double.infinity,
                  color: AppColors.blue,
                  padding: EdgeInsets.fromLTRB(
                    AppSpacing.gutter,
                    MediaQuery.of(context).padding.top + AppSpacing.s5,
                    AppSpacing.gutter,
                    AppSpacing.s5,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text('Aapka naam?',
                          style: AppTypography.display(
                              size: AppTypography.sizeXl,
                              color: AppColors.haldi)),
                      const SizedBox(height: AppSpacing.s1),
                      Text(
                        'Yeh sirf aapke resume par chhapega. Hum ise kisi aur ko '
                        'nahi dikhate.',
                        style: AppTypography.body(
                          size: AppTypography.sizeSm,
                          color: AppColors.onBlueMuted,
                        ),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.all(AppSpacing.gutter),
                    children: <Widget>[
                      Text('PEHLA NAAM',
                          style: AppTypography.eyebrow(
                              color: AppColors.textMuted)),
                      const SizedBox(height: AppSpacing.s2),
                      _NameField(
                        controller: _firstNameController,
                        hint: 'Jaise: Asha',
                        autofocus: true,
                        onSubmitted: (_) => _submit(context, state),
                      ),
                      const SizedBox(height: AppSpacing.s4),
                      Text('AAKHRI NAAM',
                          style: AppTypography.eyebrow(
                              color: AppColors.textMuted)),
                      const SizedBox(height: AppSpacing.s2),
                      _NameField(
                        controller: _lastNameController,
                        hint: 'Jaise: Kumari',
                        onSubmitted: (_) => _submit(context, state),
                      ),
                      const SizedBox(height: AppSpacing.s5),
                      Text('SHEHER AUR STATE',
                          style: AppTypography.eyebrow(
                              color: AppColors.textMuted)),
                      const SizedBox(height: AppSpacing.s2),
                      _LocationSection(
                        loading: _locationLoading,
                        errorText: _locationErrorText,
                        gpsConfirmed: _gpsConfirmed,
                        cityController: _cityController,
                        stateController: _stateController,
                        cityFocusNode: _cityFocus,
                        onUseCurrentLocation: _useCurrentLocation,
                      ),
                      const SizedBox(height: AppSpacing.s6),
                      BbButton(
                        label: state.isSubmitting ? 'Saving…' : 'Continue',
                        block: true,
                        loading: state.isSubmitting,
                        iconRight: Icons.arrow_forward_rounded,
                        onPressed: (_canSubmit && !state.isSubmitting)
                            ? () => _submit(context, state)
                            : null,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
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

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      textCapitalization: TextCapitalization.words,
      textInputAction: TextInputAction.next,
      maxLength: 40,
      autofocus: autofocus,
      onSubmitted: onSubmitted,
      style: AppTypography.body(size: AppTypography.sizeMd),
      decoration: InputDecoration(
        hintText: hint,
        counterText: '',
        filled: true,
        fillColor: AppColors.paper,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.s3,
          vertical: AppSpacing.controlInset,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadii.sm),
          borderSide: const BorderSide(color: AppColors.borderSubtle),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadii.sm),
          borderSide: const BorderSide(color: AppColors.blue, width: 1.5),
        ),
      ),
    );
  }
}

/// Location capture — GPS **and** the manual boxes, on screen at ALL times.
///
/// #1462: this used to render exactly ONE of three states (a resolved summary
/// card, a "use my location" prompt, or the manual boxes). A worker who
/// declined the permission was switched into manual mode and the GPS button
/// VANISHED, so turning the permission on afterwards left no way back to it.
///
/// There is now a single layout — GPS button on top, the two boxes below,
/// always — and GPS is a FILLER for those boxes rather than a rival mode: a
/// successful fix types its answer into them, where it stays editable and
/// where the submit path reads it from either way. Nothing here is ever
/// hidden, so no state can strand the worker on one of the two paths.
class _LocationSection extends StatelessWidget {
  const _LocationSection({
    required this.loading,
    required this.errorText,
    required this.gpsConfirmed,
    required this.cityController,
    required this.stateController,
    required this.cityFocusNode,
    required this.onUseCurrentLocation,
  });

  final bool loading;
  final String? errorText;
  final bool gpsConfirmed;
  final TextEditingController cityController;
  final TextEditingController stateController;
  final FocusNode cityFocusNode;
  final VoidCallback onUseCurrentLocation;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        BbButton(
          label: loading ? 'Location dhoondh rahe hain…' : 'Location se bharein',
          variant: BbButtonVariant.outline,
          block: true,
          loading: loading,
          iconLeft: loading ? null : Icons.my_location_rounded,
          // Disabled ONLY while a fix is in flight — never because of a past
          // refusal, which is exactly the state this button has to rescue.
          onPressed: loading ? null : onUseCurrentLocation,
        ),
        const SizedBox(height: AppSpacing.s2),
        _LocationHint(errorText: errorText, gpsConfirmed: gpsConfirmed),
        const SizedBox(height: AppSpacing.s3),
        Text('SHEHER', style: AppTypography.eyebrow(color: AppColors.textMuted)),
        const SizedBox(height: AppSpacing.s2),
        _ManualLocationField(
          controller: cityController,
          focusNode: cityFocusNode,
          hint: 'Jaise: Jaipur',
          textInputAction: TextInputAction.next,
        ),
        const SizedBox(height: AppSpacing.s4),
        Text('STATE', style: AppTypography.eyebrow(color: AppColors.textMuted)),
        const SizedBox(height: AppSpacing.s2),
        _ManualLocationField(
          controller: stateController,
          hint: 'Jaise: Rajasthan',
          textInputAction: TextInputAction.done,
        ),
      ],
    );
  }
}

/// The one line between the GPS button and the boxes. It says the most useful
/// true thing about the last GPS attempt: why it failed, that it worked, or —
/// before any attempt — that typing is equally fine.
class _LocationHint extends StatelessWidget {
  const _LocationHint({required this.errorText, required this.gpsConfirmed});

  final String? errorText;
  final bool gpsConfirmed;

  @override
  Widget build(BuildContext context) {
    if (errorText != null) {
      return Text(
        errorText!,
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          color: AppColors.danger,
        ),
      );
    }
    if (gpsConfirmed) {
      return Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(Icons.check_circle_rounded,
              size: 18, color: AppColors.success),
          const SizedBox(width: AppSpacing.s1),
          Expanded(
            child: Text(
              'Location mil gayi. Galat ho toh neeche badal sakte hain.',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textMuted,
              ),
            ),
          ),
        ],
      );
    }
    return Text(
      'Ya sheher aur state neeche khud likhein.',
      style: AppTypography.body(
        size: AppTypography.sizeSm,
        color: AppColors.textMuted,
      ),
    );
  }
}

/// One half of the manual-entry fallback — city or state, typed by hand when
/// GPS is unavailable or declined.
///
/// TWO BOXES, NOT ONE ADDRESS LINE. `workers` stores exactly
/// `current_city`/`current_state` and nothing else ("City + state only —
/// never an address, never a coordinate", `packages/db/src/schema/worker.ts`),
/// so a single free-text address line had nowhere to land: the API's zod
/// object silently dropped it and a hand-typing worker's location was never
/// stored at all. These two map straight onto the columns that exist.
///
/// FREE TEXT, capped at the server's own 80 — deliberately NOT checked
/// against the preferred-cities gazetteer, which is a closed set of
/// manufacturing hubs. This is the first screen the product ever shows, and
/// it must not refuse a worker in Patna the name of the town they live in.
class _ManualLocationField extends StatelessWidget {
  const _ManualLocationField({
    required this.controller,
    required this.hint,
    required this.textInputAction,
    this.focusNode,
  });

  final TextEditingController controller;
  final String hint;
  final TextInputAction textInputAction;

  /// Set on the CITY box only, so the prompt's "Khud likhein" can close onto
  /// the first thing it just asked the worker to fill.
  final FocusNode? focusNode;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      focusNode: focusNode,
      textCapitalization: TextCapitalization.words,
      textInputAction: textInputAction,
      maxLength: 80,
      style: AppTypography.body(size: AppTypography.sizeMd),
      decoration: InputDecoration(
        hintText: hint,
        counterText: '',
        filled: true,
        fillColor: AppColors.paper,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.s3,
          vertical: AppSpacing.controlInset,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadii.sm),
          borderSide: const BorderSide(color: AppColors.borderSubtle),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadii.sm),
          borderSide: const BorderSide(color: AppColors.blue, width: 1.5),
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
///  - AT SUBMIT ([submitOnDismiss] true). Continue was tapped with both boxes
///    empty. Closing SKIPS location and saves the name anyway — valid on the
///    wire, since `city`/`state` are optional on `SetMyNameSchema`.
///
/// Chrome mirrors [showBbAlert]: white card, 12-radius corners, elevation 0
/// (design law §4 — separation is the scrim + fill, never a shadow), an Anek
/// title over a Roboto body at the worker size. The actions are Row + Expanded
/// rather than `BbButton(block: true)` because [AlertDialog] wraps its content
/// in an `IntrinsicWidth`, which throws on an infinite-width child.
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
        backgroundColor: AppColors.surfaceCard,
        elevation: 0,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(AppRadii.lg)),
        ),
        titlePadding: const EdgeInsets.fromLTRB(
          AppSpacing.s6,
          AppSpacing.s6,
          AppSpacing.s6,
          AppSpacing.s3,
        ),
        contentPadding: const EdgeInsets.fromLTRB(
          AppSpacing.s6,
          0,
          AppSpacing.s6,
          AppSpacing.s5,
        ),
        title: Text(
          submitOnDismiss ? 'Location reh gayi' : 'Location ab mil sakti hai',
          textAlign: TextAlign.center,
          style: AppTypography.display(size: AppTypography.sizeMd),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(
              submitOnDismiss
                  ? 'Jobs aapke sheher ke hisaab se aati hain. GPS se bhar '
                      'dein, ya sheher aur state khud likhein.'
                  : 'Ab GPS se aapka sheher aur state apne aap bhar sakte '
                      'hain, ya khud likhein.',
              textAlign: TextAlign.center,
              style: AppTypography.body(
                size: AppTypography.sizeMd,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: AppSpacing.s5),
            Row(
              children: <Widget>[
                Expanded(
                  child: BbButton(
                    label: 'Location se bharein',
                    iconLeft: Icons.my_location_rounded,
                    onPressed: () => close(_LocationPromptChoice.gps),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.s2),
            Row(
              children: <Widget>[
                Expanded(
                  child: BbButton(
                    label: 'Khud likhein',
                    variant: BbButtonVariant.outline,
                    onPressed: () => close(_LocationPromptChoice.manual),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.s1),
            TextButton(
              onPressed: () => close(_LocationPromptChoice.dismiss),
              child: Text(
                // The submit-time close is a SKIP, and says so — a worker who
                // taps it must know the name saves without a location, not
                // that they were sent back to try again.
                submitOnDismiss ? 'Bina location aage badhein' : 'Band karein',
              ),
            ),
          ],
        ),
      );
    },
  );
  return choice ?? _LocationPromptChoice.dismiss;
}
