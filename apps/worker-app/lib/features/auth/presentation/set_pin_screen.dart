import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/biometric_service.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/bb_alert_dialog.dart';
import '../../../core/widgets/kit/secure_note.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../l10n/gen/app_localizations.dart';
import '../../../router.dart';
import '../domain/auth_session_manager.dart';
import 'cubit/set_pin_cubit.dart';
import 'widgets/bb_pin_view.dart';
import 'widgets/bb_set_pin_form.dart';

/// Set / reset PIN — onboarding kit **Screen 4**: the Shift Blue header, the
/// `PIN DAALEIN` and `PIN DOBARA DAALEIN` rows of four boxes, the yellow
/// "Save PIN & Continue", and the security note.
///
/// ONE page: both rows are on screen together, driven by the OS numeric
/// keyboard via [BbSetPinForm] — not a custom keypad. Every PIN row still shows
/// where the worker is typing (the ring and the blinking caret, #1463).
///
/// NOTHING IS SENT UNTIL THE BUTTON. The kit adds "Save PIN & Continue", so the
/// form runs in button mode: a mismatch is still explained the instant the
/// confirm row fills, a match enables the button, and the tap submits.
///
/// THE WORKER PICKS THEIR OWN PIN (#1464). There is NO strength gate on this
/// client — 1234, 1111 and 0000 are all accepted and submitted.
///
/// Every error the worker can still hit is a CENTRED, blocking [showBbAlert]:
///  - a confirm mismatch clears both rows and explains in a dialog
///    ([BbSetPinForm] owns this).
///  - a server rejection surfaces its full reason here and resets both rows.
///
/// On success the manager authenticates; a new user continues onboarding
/// (consent), a reset returns to the shell.
class SetPinScreen extends StatelessWidget {
  const SetPinScreen({super.key, this.isReset = false});

  /// True when reached from forgot-PIN (returns to the shell on success) rather
  /// than the new-user onboarding (continues to consent).
  final bool isReset;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<SetPinCubit>(
      create: (_) => locator<SetPinCubit>(),
      child: _SetPinView(isReset: isReset),
    );
  }
}

class _SetPinView extends StatefulWidget {
  const _SetPinView({required this.isReset});

  final bool isReset;

  @override
  State<_SetPinView> createState() => _SetPinViewState();
}

class _SetPinViewState extends State<_SetPinView> {
  final GlobalKey<BbSetPinFormState> _formKey = GlobalKey<BbSetPinFormState>();

  /// True while an alert dialog is open, so a rapid tap or a rebuild can't stack
  /// a second dialog on top of the first.
  bool _dialogOpen = false;

  /// Both rows hold the same complete PIN — the button's enable signal.
  bool _ready = false;

  /// The server rejected the PIN — surface its full reason, then reset both rows.
  Future<void> _showFailureAlert(String? message) async {
    if (_dialogOpen) return;
    _dialogOpen = true;
    final String text = (message == null || message.isEmpty)
        ? 'Kuch gadbad ho gayi. Dobara try karein.'
        : message;
    await showBbAlert(context, title: 'PIN set nahi hua', message: text);
    if (mounted) {
      _dialogOpen = false;
      _formKey.currentState?.reset();
    }
  }

  /// #2451 — the worker's answer to the one-time opt-in. Held locally because
  /// the preference can only be enabled AFTER the manager authenticates (which
  /// happens as soon as this callback returns); enabling it earlier would fail
  /// its "authenticated + PIN set" guard by design.
  bool _enableBiometricAfterSet = false;

  /// #2451 — the opt-in, offered as the LAST step of a successful set-PIN.
  ///
  /// It runs from [AuthSessionManager.setPin]'s `beforeAuthenticate` hook, i.e.
  /// BEFORE the status flips to authenticated. That ordering is what keeps the
  /// router the only navigation owner: if we waited until after the flip, the
  /// router would already be replacing this route and an async dialog would be
  /// racing it (the #349 lesson). Here the worker answers while still on the
  /// set-PIN screen, then the router navigates as it always did.
  ///
  /// Never auto-enables; an unavailable/unenrolled device is not asked and the
  /// prompt is not marked "seen", so a later enrolment can still be offered.
  Future<void> _offerBiometricOptIn() async {
    final AuthSessionManager? manager = locator.isRegistered<AuthSessionManager>()
        ? locator<AuthSessionManager>()
        : null;
    if (manager == null ||
        manager.biometricEnabled ||
        manager.biometricPromptSeen) {
      return;
    }

    final BiometricAvailability availability =
        await manager.biometricAvailability();
    if (!mounted) return;
    if (availability != BiometricAvailability.available) return;

    final AppLocalizations strings = AppLocalizations.of(context);
    final bool enable = await showBbConfirm(
      context,
      title: strings.biometricOptInTitle,
      message: strings.biometricOptInBody,
      confirmLabel: strings.biometricOptInEnable,
      cancelLabel: strings.biometricOptInNotNow,
      barrierDismissible: false,
    );
    await manager.markBiometricPromptSeen();
    _enableBiometricAfterSet = enable;
  }

  /// Submit the confirmed PIN, offering the biometric opt-in first while the
  /// screen is still mounted (see [_offerBiometricOptIn]).
  Future<void> _submit(String pin) {
    return context.read<SetPinCubit>().submit(
          pin,
          beforeAuthenticate: _offerBiometricOptIn,
        );
  }

  /// Fire-and-forget after a successful set-PIN. The worker is being navigated
  /// by the router; this only persists a preference and must never block it.
  void _enableBiometricIfChosen(BuildContext context) {
    if (!_enableBiometricAfterSet) return;
    _enableBiometricAfterSet = false;
    if (!locator.isRegistered<AuthSessionManager>()) return;
    // Capture the app-level messenger BEFORE the router swaps this route, so a
    // late failure can still tell the worker why the switch did not stick.
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final String failureCopy = AppLocalizations.of(context).biometricEnableFailed;
    unawaited(
      locator<AuthSessionManager>()
          .setBiometricEnabled(true)
          .then<void>((bool enabled) {
        if (enabled) return;
        messenger
          ..clearSnackBars()
          ..showSnackBar(SnackBar(content: Text(failureCopy)));
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<SetPinCubit, SetPinState>(
      listenWhen: (SetPinState p, SetPinState c) => p.status != c.status,
      listener: (BuildContext context, SetPinState state) {
        if (state.status == SetPinStatus.done) {
          // #2451 — the opt-in was answered while setPin was still in flight;
          // persist it now WITHOUT awaiting (the router owns the destination).
          _enableBiometricIfChosen(context);
          // Reset → confirm it landed with a toast, then back to the shell.
          // New user → continue onboarding at consent. The messenger is the
          // app-level one, so the SnackBar survives the `go`.
          if (widget.isReset) {
            ScaffoldMessenger.of(context)
              ..clearSnackBars()
              ..showSnackBar(
                const SnackBar(content: Text('PIN reset kar diya gaya hai')),
              );
          }
          context.go(widget.isReset ? Routes.resume : Routes.consent);
        } else if (state.status == SetPinStatus.failure) {
          _showFailureAlert(state.message);
        }
      },
      builder: (BuildContext context, SetPinState state) {
        final bool canPop = Navigator.of(context).canPop();
        return Scaffold(
          backgroundColor: OnboardingColors.canvasBg,
          body: Column(
            children: <Widget>[
              ShiftBlueHeader(
                title: widget.isReset ? 'Naya PIN' : 'PIN banayein',
                subtitle:
                    'Pehle naya PIN daalein, fir confirm karne ke liye '
                    'wahi PIN dobara daalein.',
                // Reached with `go` (after OTP, or on a cold-start resume), so
                // there is normally nothing behind it. A back arrow that led to
                // the spent OTP screen would be worse than none.
                onBack: canPop ? () => Navigator.of(context).pop() : null,
              ),
              Expanded(
                child: SafeArea(
                  top: false,
                  child: OnboardingBody(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      children: <Widget>[
                        const SizedBox(height: 10),
                        BbSetPinForm(
                          key: _formKey,
                          enterLabel: 'PIN DAALEIN',
                          confirmLabel: 'PIN DOBARA DAALEIN',
                          busy: state.isSubmitting,
                          busyCaption: 'PIN set kar rahe hain…',
                          pinStyle: BbPinSlotStyle.shiftBlue,
                          labelStyle: OnboardingTypography.fieldMicroLabel(),
                          rowGap: 28,
                          submitOnComplete: false,
                          showBusySpinner: false,
                          onReadyChanged: (bool ready) =>
                              setState(() => _ready = ready),
                          onConfirmed: _submit,
                        ),
                        const SizedBox(height: 40),
                        PrimaryActionButton(
                          buttonKey: const Key('setPinSaveButton'),
                          label: 'Save PIN & Continue',
                          showArrow: false,
                          isLoading: state.isSubmitting,
                          onPressed: _ready && !state.isSubmitting
                              ? () => _formKey.currentState?.submit()
                              : null,
                        ),
                        const SizedBox(height: 18),
                        // Spec §3.4's reassurance line, same words, drawn by
                        // the shared kit widget (a real shield glyph, never an
                        // emoji — see [SecureNote]).
                        const SecureNote(),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
