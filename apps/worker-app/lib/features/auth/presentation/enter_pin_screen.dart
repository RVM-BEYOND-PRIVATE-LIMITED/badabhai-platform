import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/auth/biometric_service.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/push_once.dart';
import '../../../core/widgets/bb_alert_dialog.dart';
import '../../../core/widgets/bb_spinner.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../l10n/gen/app_localizations.dart';
import '../../../router.dart';
import 'cubit/enter_pin_cubit.dart';
import 'widgets/bb_pin_keypad.dart';
import 'widgets/bb_pin_view.dart';

/// PIN length the app uses everywhere (set + unlock). Single source so the dot
/// count and the auto-submit threshold never drift.
const int kPinLength = 4;

/// Enter-PIN (unlock) — the fast path on cold start and after a re-lock.
///
/// UI kit v3: the Shift Blue header carries the title, the body sits on
/// `canvasBg`, the masked row wears [BbPinSlotStyle.shiftBlue] under a
/// `PIN DAALEIN` micro label, and the keypad is the kit's white-key drawing.
///
/// The masked keypad assembles the PIN in LOCAL state only; it is forwarded to
/// the cubit on the last digit and cleared from memory immediately. On a wrong
/// PIN the dots flash crimson and the NEUTRAL "PIN sahi nahi…" copy is shown in a
/// CENTRED, blocking dialog (a "Theek hai" acknowledge) — the same treatment as
/// the set-PIN errors, so a low-literacy worker cannot miss it. The backend gives
/// one opaque 401 per failure, so there is no attempts/countdown UI. After a few
/// soft fails the "PIN bhool gaye?" link is emphasized; it starts the forgot-PIN
/// flow.
///
/// THERE IS NO CTA, deliberately. The kit's set-PIN screen has a
/// "Save PIN & Continue" button; unlock auto-submits on the 4th digit instead,
/// because the #1466 backspace-cancel window depends on that timing — a button
/// here would change the behaviour the whole typo-recovery story is built on.
class EnterPinScreen extends StatelessWidget {
  const EnterPinScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<EnterPinCubit>(
      create: (_) => locator<EnterPinCubit>(),
      child: const _EnterPinView(),
    );
  }
}

class _EnterPinView extends StatefulWidget {
  const _EnterPinView();

  @override
  State<_EnterPinView> createState() => _EnterPinViewState();
}

class _EnterPinViewState extends State<_EnterPinView> {
  /// The PIN buffer — LOCAL widget state only. Never persisted, never logged;
  /// cleared after each submit.
  String _pin = '';

  /// True while the wrong-PIN dialog is open, so repeated failures can't stack
  /// a second dialog on top of the first.
  bool _dialogOpen = false;

  /// The worker has SEEN the wrong-PIN dialog and dismissed it (#1469). The
  /// cubit stays in `failure` until the next attempt resolves, so painting the
  /// row off that status alone left the cleared retry row — and its caret —
  /// crimson for the whole of the corrective retype: the app kept shouting
  /// about a mistake the worker was already fixing.
  bool _errorAcknowledged = false;

  /// Identifies the pending submit so a backspace can CANCEL it (#1466).
  /// Bumping this orphans the in-flight `_onDigit` continuation, which checks
  /// the token after its delay and returns rather than unlocking.
  int _submitToken = 0;

  @override
  void initState() {
    super.initState();
    // #2451 — one-shot auto prompt. Only when the worker opted in; the PIN
    // keypad is fully usable underneath and remains the fallback after a
    // cancel. A post-frame callback lets the first frame paint the PIN screen
    // BEFORE the OS sheet covers it, so the worker never sees a blank pause.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final EnterPinCubit cubit = context.read<EnterPinCubit>();
      if (cubit.state.biometricEnabled) {
        cubit.biometricUnlock();
      }
    });
  }

  Future<void> _onDigit(String d) async {
    // Length alone guards a stray 5th tap during the pop-beat; `_submitting`
    // deliberately does NOT gate input any more (see [_onBackspace]).
    if (_pin.length >= kPinLength) return;
    setState(() => _pin += d);
    if (_pin.length < kPinLength) return;

    // Let the 4th dot finish its fill-pop, THEN submit — but KEEP the dots
    // FILLED through the verify. Blanking them the instant the 4th digit lands
    // (as this used to) read like a reset / wrong PIN, and a worker re-entered a
    // correct PIN. Instead the keypad is swapped for a loader (build) while the
    // unlock is in flight, and the dots are cleared ONLY on a wrong PIN, after
    // the worker has acknowledged it (see [_showError]).
    final int token = ++_submitToken;
    await Future<void>.delayed(BbPinView.fillPopSettle);
    // Cancelled by a backspace while the pop was still running — the worker
    // caught their own typo, so do NOT spend an attempt on it.
    if (!mounted || token != _submitToken) return;
    context.read<EnterPinCubit>().unlock(_pin);
  }

  /// #1466 — a mistyped LAST digit used to be unfixable: input froze for the
  /// fill-pop and the PIN submitted itself 300ms later, spending one of the
  /// five attempts before the lockout on a typo the worker had already seen.
  /// Backspace now works at every moment the keypad is on screen, and doing it
  /// during the pop-beat cancels the pending submit outright.
  void _onBackspace() {
    if (_pin.isEmpty) return;
    _submitToken++; // orphan any pending submit
    setState(() => _pin = _pin.substring(0, _pin.length - 1));
  }

  /// Surface a wrong-PIN (or unknown-error) failure in a centred dialog with a
  /// single "Theek hai" button — matching the set-PIN errors. Guarded by
  /// [_dialogOpen] so a fast retry can't stack dialogs.
  Future<void> _showError(String? message) async {
    if (_dialogOpen) return;
    _dialogOpen = true;
    final String text = (message == null || message.isEmpty)
        ? 'PIN sahi nahi — dobara try karein, ya \'PIN bhool gaye?\''
        : message;
    await showBbAlert(context, title: 'PIN sahi nahi', message: text);
    if (mounted) {
      _dialogOpen = false;
      // Clear ONLY now — after the worker has seen the wrong-PIN dialog — so a
      // fresh retry starts from empty dots. (On success the dots stay filled
      // until the router navigates away; they never blank mid-verify.)
      // Cleared AND un-tinted together: the next digit lands on a neutral row.
      setState(() {
        _pin = '';
        _errorAcknowledged = true;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    // On unlock the ROUTER REDIRECT owns where we land — it fires on the status
    // change via `refreshListenable`, restores the location the re-lock
    // interrupted (#349), falls back to the Resume tab, and applies the TD62
    // consent gate. The listener here ONLY surfaces the failure dialog; it never
    // navigates (two owners of post-unlock routing was the #349 bug).
    return BlocConsumer<EnterPinCubit, EnterPinState>(
      listenWhen: (EnterPinState p, EnterPinState c) => p.status != c.status,
      listener: (BuildContext context, EnterPinState state) {
        if (state.status == EnterPinStatus.failure) {
          _errorAcknowledged = false;
          _showError(state.message);
        }
      },
      builder: (BuildContext context, EnterPinState state) {
        final AppLocalizations strings = AppLocalizations.of(context);
        final bool error =
            state.status == EnterPinStatus.failure && !_errorAcknowledged;
        // Kit auth chrome: the navy header carries the title/context; the light
        // body holds the masked dots + on-screen keypad. NO back arrow — this is
        // the locked root, and there is nothing behind it to go back to.
        return Scaffold(
          backgroundColor: OnboardingColors.canvasBg,
          body: Column(
            children: <Widget>[
              const ShiftBlueHeader(
                title: 'PIN daalein',
                subtitle: 'Apne account mein wapas aane ke liye PIN daalein.',
              ),
              Expanded(
                child: SafeArea(
                  top: false,
                  // Scroll-safe: the keypad body centres when there is room and
                  // scrolls (never a RenderFlex overflow) on a short handset or
                  // at a large accessibility text scale. Caps at 440 on tablets.
                  child: OnboardingBody(
                    fillViewport: true,
                    padding: const EdgeInsets.symmetric(horizontal: 20),
                    child: Column(
                      children: <Widget>[
                        const Spacer(flex: 2),
                        Text(
                          'PIN DAALEIN',
                          style: OnboardingTypography.fieldMicroLabel(),
                        ),
                        const SizedBox(height: 12),
                        BbPinView(
                          length: kPinLength,
                          filled: _pin.length,
                          error: error,
                          // #1466 — every PIN surface shows where the next
                          // digit lands. The keypad below is the input and it
                          // is on screen whenever a digit can be typed, so the
                          // row is "focused" exactly while the verify is not
                          // in flight.
                          focused: !state.isSubmitting && !state.biometricInFlight,
                          style: BbPinSlotStyle.shiftBlue,
                        ),
                        // The wrong-PIN reason now lives in the centred dialog
                        // (see [_showError]) — no tiny inline line here.
                        const SizedBox(height: 8),
                        // While the PIN (or the biometric refresh) is being
                        // verified, swap the keypad for a loader so the worker
                        // sees WORK IN PROGRESS — the dots stay filled above and
                        // never blank mid-verify.
                        if (state.isSubmitting || state.biometricInFlight)
                          _VerifyingNote(
                            caption: state.biometricInFlight
                                ? strings.biometricVerifying
                                : strings.pinVerifying,
                          )
                        else ...<Widget>[
                          BbPinKeypad(
                            onDigit: _onDigit,
                            onBackspace: _onBackspace,
                          ),
                          // #2451 — the explicit retry affordance. The OS prompt
                          // is auto-triggered once on entry; after a cancel this
                          // is how the worker asks for it again. PIN is never
                          // removed or covered by it.
                          if (state.biometricEnabled) _biometricCta(strings),
                        ],
                        if (_biometricHint(state.biometricResult) != null) ...[
                          const SizedBox(height: 4),
                          Text(
                            _biometricHint(state.biometricResult)!,
                            textAlign: TextAlign.center,
                            style: OnboardingTypography.inter(
                              size: 12,
                              color: OnboardingColors.ink600,
                            ),
                          ),
                        ],
                        const Spacer(flex: 1),
                        _forgotLink(context, state),
                        const SizedBox(height: 4),
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

  /// The biometric retry affordance (#2451). A solid fingerprint glyph + the
  /// app's Hinglish CTA; deliberately a SECONDARY control so it never competes
  /// with the keypad the worker already trusts.
  Widget _biometricCta(AppLocalizations strings) {
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: TextButton.icon(
        key: const Key('enterPinBiometricButton'),
        onPressed: () => context.read<EnterPinCubit>().biometricUnlock(),
        icon: const Icon(
          Icons.fingerprint,
          color: OnboardingColors.shiftBlue,
          size: 26,
        ),
        label: Text(
          strings.biometricUnlockCta,
          textAlign: TextAlign.center,
          style: OnboardingTypography.inter(
            size: 13,
            weight: FontWeight.w600,
            color: OnboardingColors.shiftBlue,
          ),
        ),
        style: TextButton.styleFrom(
          minimumSize: const Size(
            OnboardingLayout.tapTarget,
            OnboardingLayout.tapTarget,
          ),
          tapTargetSize: MaterialTapTargetSize.padded,
        ),
      ),
    );
  }

  /// One short, neutral hint after a non-successful biometric attempt. Returns
  /// null for no hint (success / preference turned off by the manager).
  String? _biometricHint(BiometricUnlockResult? result) {
    final AppLocalizations strings = AppLocalizations.of(context);
    switch (result) {
      case BiometricUnlockResult.cancelled:
        return strings.biometricUnlockCancelled;
      case BiometricUnlockResult.failed:
        return strings.biometricUnlockFailed;
      case BiometricUnlockResult.serverUnavailable:
        return strings.biometricUnlockServerUnavailable;
      case BiometricUnlockResult.unavailable:
      case BiometricUnlockResult.notEnrolled:
        return strings.biometricUnlockUnavailable;
      case BiometricUnlockResult.success:
      case BiometricUnlockResult.notEnabled:
      case BiometricUnlockResult.reauthRequired:
      case null:
        return null;
    }
  }

  /// The reset escape hatch. Deep-blue underlined link in BOTH states — haldi
  /// (brand) as body text on white is ~1.4:1 and illegible; the w700 weight
  /// carries the emphasis once [EnterPinState.suggestForgot] is set.
  Widget _forgotLink(BuildContext context, EnterPinState state) {
    return TextButton(
      onPressed: () => context.pushOnce(Routes.forgotPin),
      style: TextButton.styleFrom(
        minimumSize: const Size(
          OnboardingLayout.tapTarget,
          OnboardingLayout.tapTarget,
        ),
        tapTargetSize: MaterialTapTargetSize.padded,
      ),
      child: Text(
        // After enough soft fails, nudge toward the reset flow.
        state.suggestForgot
            ? 'PIN bhool gaye? Naya PIN banayein'
            : 'PIN bhool gaye?',
        textAlign: TextAlign.center,
        style: OnboardingTypography.inter(
          size: 13,
          weight: state.suggestForgot ? FontWeight.w700 : FontWeight.w600,
          color: OnboardingColors.shiftBlue,
          decoration: TextDecoration.underline,
        ),
      ),
    );
  }
}

/// The in-flight verify: the kit's navy ring plus the honest caption, standing
/// in for the keypad while the unlock is on the wire.
///
/// [BbSpinner] — the app's ONE spinner drawing (a hairline track with a navy
/// arc head) — not a bare `CircularProgressIndicator`. A raw Material ring here
/// was both off-kit and a silent regression: the unlock test pins this surface
/// on `BbSpinner`, because "the dots stay filled and a LOADER replaces the
/// keypad" is the whole #1469 fix.
class _VerifyingNote extends StatelessWidget {
  const _VerifyingNote({required this.caption});

  final String caption;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: BbSpinner(size: 40, caption: caption),
    );
  }
}
