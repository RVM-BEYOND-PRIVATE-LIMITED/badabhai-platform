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
/// Also captures a MANDATORY coarse location (city + state) — via GPS/network
/// (device geocoder, no backend round-trip) or, if that fails or the worker
/// declines, a manual fallback. Continue is disabled until both name and
/// location are present; see [LocationLookup] for the resolution contract.
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

class _NameViewState extends State<_NameView> {
  final TextEditingController _firstNameController = TextEditingController();
  final TextEditingController _lastNameController = TextEditingController();
  final TextEditingController _manualCityController = TextEditingController();
  final TextEditingController _manualStateController = TextEditingController();

  bool _hasName = false;
  bool _manualLocationEntry = false;
  bool _locationLoading = false;
  String? _locationErrorText;
  ResolvedLocation? _resolvedLocation;

  LocationLookup get _locationLookup => locator<LocationLookup>();

  @override
  void initState() {
    super.initState();
    _firstNameController.addListener(_onNameChanged);
    _lastNameController.addListener(_onNameChanged);
    _manualCityController.addListener(_onManualLocationChanged);
    _manualStateController.addListener(_onManualLocationChanged);
  }

  void _onNameChanged() {
    final bool has = _firstNameController.text.trim().isNotEmpty &&
        _lastNameController.text.trim().isNotEmpty;
    if (has != _hasName) setState(() => _hasName = has);
  }

  void _onManualLocationChanged() => setState(() {});

  @override
  void dispose() {
    _firstNameController.dispose();
    _lastNameController.dispose();
    _manualCityController.dispose();
    _manualStateController.dispose();
    super.dispose();
  }

  String get _effectiveCity => _manualLocationEntry
      ? _manualCityController.text.trim()
      : (_resolvedLocation?.city ?? '');

  String get _effectiveState => _manualLocationEntry
      ? _manualStateController.text.trim()
      : (_resolvedLocation?.state ?? '');

  bool get _hasLocation =>
      _effectiveCity.isNotEmpty && _effectiveState.isNotEmpty;

  Future<void> _useCurrentLocation() async {
    setState(() {
      _locationLoading = true;
      _locationErrorText = null;
    });
    try {
      final ResolvedLocation location = await _locationLookup.resolveCurrent();
      if (!mounted) return;
      setState(() {
        _resolvedLocation = location;
        _manualLocationEntry = false;
        _locationLoading = false;
      });
    } on LocationLookupFailure catch (failure) {
      if (!mounted) return;
      setState(() {
        _locationLoading = false;
        _locationErrorText = _messageFor(failure.reason);
        // Never leave the worker stuck: a failed GPS attempt drops straight
        // into manual entry so location capture stays completable either way.
        _manualLocationEntry = true;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _locationLoading = false;
        _locationErrorText = _messageFor(LocationLookupFailureReason.unknown);
        _manualLocationEntry = true;
      });
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

  void _switchToManualEntry() {
    setState(() {
      _manualCityController.text = _resolvedLocation?.city ?? '';
      _manualStateController.text = _resolvedLocation?.state ?? '';
      _manualLocationEntry = true;
      _locationErrorText = null;
    });
  }

  bool get _canSubmit => _hasName && _hasLocation;

  void _submit(BuildContext context, NameState state) {
    if (_canSubmit && !state.isSubmitting) {
      final String fullName =
          '${_firstNameController.text.trim()} ${_lastNameController.text.trim()}'
              .trim();
      context.read<NameCubit>().submit(
            fullName,
            city: _effectiveCity,
            state: _effectiveState,
          );
    }
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
                        resolved:
                            !_manualLocationEntry ? _resolvedLocation : null,
                        manualEntry: _manualLocationEntry,
                        cityController: _manualCityController,
                        stateController: _manualStateController,
                        onUseCurrentLocation: _useCurrentLocation,
                        onEnterManually: _switchToManualEntry,
                        onChangeLocation: _switchToManualEntry,
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

/// Renders exactly one of three states: a resolved-location summary card, a
/// "use my location" prompt, or the manual city/state fallback fields.
class _LocationSection extends StatelessWidget {
  const _LocationSection({
    required this.loading,
    required this.errorText,
    required this.resolved,
    required this.manualEntry,
    required this.cityController,
    required this.stateController,
    required this.onUseCurrentLocation,
    required this.onEnterManually,
    required this.onChangeLocation,
  });

  final bool loading;
  final String? errorText;
  final ResolvedLocation? resolved;
  final bool manualEntry;
  final TextEditingController cityController;
  final TextEditingController stateController;
  final VoidCallback onUseCurrentLocation;
  final VoidCallback onEnterManually;
  final VoidCallback onChangeLocation;

  @override
  Widget build(BuildContext context) {
    if (resolved != null) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.s3,
          vertical: AppSpacing.s3,
        ),
        decoration: BoxDecoration(
          color: AppColors.paper,
          borderRadius: BorderRadius.circular(AppRadii.sm),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        child: Row(
          children: <Widget>[
            const Icon(Icons.location_on_rounded, color: AppColors.blue),
            const SizedBox(width: AppSpacing.s2),
            Expanded(
              child: Text(
                '${resolved!.city}, ${resolved!.state}',
                style: AppTypography.body(
                  size: AppTypography.sizeMd,
                  weight: FontWeight.w600,
                ),
              ),
            ),
            TextButton(
              onPressed: onChangeLocation,
              child: const Text('Badlein'),
            ),
          ],
        ),
      );
    }

    if (manualEntry) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (errorText != null) ...<Widget>[
            Text(
              errorText!,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.danger,
              ),
            ),
            const SizedBox(height: AppSpacing.s2),
          ],
          _NameField(controller: cityController, hint: 'Sheher (jaise: Pune)'),
          const SizedBox(height: AppSpacing.s3),
          _NameField(controller: stateController, hint: 'State (jaise: Maharashtra)'),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (errorText != null) ...<Widget>[
          Text(
            errorText!,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.danger,
            ),
          ),
          const SizedBox(height: AppSpacing.s2),
        ],
        BbButton(
          label: loading ? 'Location dhoondh rahe hain…' : 'Location se bharein',
          variant: BbButtonVariant.outline,
          block: true,
          loading: loading,
          iconLeft: loading ? null : Icons.my_location_rounded,
          onPressed: loading ? null : onUseCurrentLocation,
        ),
        TextButton(
          onPressed: loading ? null : onEnterManually,
          child: const Text('Khud likhein'),
        ),
      ],
    );
  }
}
