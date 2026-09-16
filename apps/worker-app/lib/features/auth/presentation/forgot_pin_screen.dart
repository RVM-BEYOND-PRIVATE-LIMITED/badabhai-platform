import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/auth_error_messages.dart';
import '../../../core/auth/auth_failure.dart';
import '../../../core/auth/phone_format.dart';
import '../../../core/di/locator.dart';
import '../../../core/otp/sms_otp_autofill.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/bb_alert_dialog.dart';
import '../../../core/widgets/kit/otp_code_field.dart';
import '../../../core/widgets/kit/phone_number_field.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../router.dart';
import '../domain/auth_session_manager.dart';
import 'widgets/bb_pin_view.dart';
import 'widgets/bb_set_pin_form.dart';

/// Forgot-PIN: the dedicated PIN-RESET flow (NOT the normal OTP login).
///
/// Three phases, in the order a worker expects — the OTP comes BEFORE the new
/// PIN:
///  1. phone → [AuthSessionManager.requestPinReset] (POST /auth/pin/reset/request)
///  2. otp   → enter the code that just arrived (Android SMS auto-fills it)
///  3. pin   → ONE page: enter + confirm a brand-new 4-digit PIN together (no
///     next-screen transition between them — see [BbSetPinForm]), then
///     [AuthSessionManager.confirmPinReset] (POST /auth/pin/reset/confirm) with
///     {phone, otp, newPin} in ONE call.
///
/// UI kit v3: the Shift Blue header carries each phase's title, the phone box is
/// the kit [PhoneNumberField], the code is the kit's six-cell [OtpCodeField]
/// (which retires the old single field and its wrong four-dash hint), and each
/// phase ends in the yellow [PrimaryActionButton].
///
/// THE NEW PIN IS SAVED BY A BUTTON, not by completing the second row. That
/// matches set-PIN exactly: [BbSetPinForm] runs in button mode, so a mismatch is
/// still explained the instant the confirm row fills, a match enables
/// "Save PIN & Continue", and only the tap submits.
///
/// EVERY error on every step is a CENTRED, blocking [showBbAlert] with a single
/// "Theek hai" button — a couldn't-send-OTP, a missing code, a bad/expired code,
/// a confirm mismatch, a server weak-PIN. There is no tiny inline red text a
/// first-time, low-literacy worker would scroll past.
///
/// The backend verifies the OTP only at that final `/confirm` (there is no
/// standalone reset-OTP verify), so a wrong/expired code surfaces there and
/// returns the worker to the OTP step; a weak/format PIN re-collects the PIN. On
/// success it routes to [Routes.pin] — the redirect bounces to /login if the
/// worker is now loggedOut.
///
/// THERE IS NO RESEND TIMER. `POST /auth/pin/reset/request` returns no
/// `resend_in_seconds`, and #336 forbids inventing a client-side cooldown, so
/// the spec's "Resend code in 0:29" cannot be shown honestly here.
///
/// THE WORKER PICKS THEIR OWN PIN (#1464). A guessable PIN is NOT blocked here
/// — 1234 / 1111 / 0000 go straight to the confirm call. The API still runs its
/// own denylist, so such a PIN comes back as [AuthErrorCode.pinWeak] and is
/// handled below; that server policy is issue #1462.
class ForgotPinScreen extends StatefulWidget {
  const ForgotPinScreen({super.key});

  @override
  State<ForgotPinScreen> createState() => _ForgotPinScreenState();
}

enum _Phase { phone, otp, pin }

class _ForgotPinScreenState extends State<ForgotPinScreen> {
  final AuthSessionManager _manager = locator<AuthSessionManager>();

  /// Holds ONLY the 10 national digits — `+91` is fixed chrome, not editable
  /// text. Seeding it into the controller let the worker backspace it away, and
  /// the raw text went straight to requestPinReset(), sending a malformed number
  /// (identical bug to the login screen).
  final TextEditingController _phone = TextEditingController();
  final TextEditingController _otp = TextEditingController();

  /// The kit fields take their focus from outside, so the screen owns (and
  /// disposes) both nodes.
  final FocusNode _phoneFocus = FocusNode();
  final FocusNode _otpFocus = FocusNode();

  final GlobalKey<BbSetPinFormState> _pinFormKey =
      GlobalKey<BbSetPinFormState>();

  _Phase _phase = _Phase.phone;

  bool _busy = false;

  /// Button mode: both PIN rows hold the same complete PIN right now — the
  /// "Save PIN & Continue" enable signal.
  bool _pinReady = false;

  /// True while an alert dialog is open, so a rapid tap or a rebuild can't stack
  /// a second dialog on top of the first.
  bool _dialogOpen = false;

  /// Android SMS auto-read for the reset OTP. Null when the locator has no
  /// instance (tests) — the screen stays usable by typing.
  SmsOtpAutofill? _autofill;
  StreamSubscription<String>? _codeSub;

  @override
  void initState() {
    super.initState();
    // The kit fields expose no `onChanged` — they are handed a controller and
    // paint from it. Both CTAs gate on the text (10 digits / a non-empty code),
    // so the repaint has to come from the controller itself.
    _phone.addListener(_onFieldChanged);
    _otp.addListener(_onFieldChanged);
    // This is the app's SECOND OTP surface (login is the other). It bypasses
    // PhoneLoginCubit, so the SMS auto-read has to be wired here too — otherwise
    // a PIN reset is the one flow left where the worker still types the code.
    if (!locator.isRegistered<SmsOtpAutofill>()) return;
    final SmsOtpAutofill autofill = locator<SmsOtpAutofill>();
    _autofill = autofill;
    _codeSub = autofill.codes.listen(_onSmsCode);
  }

  void _onFieldChanged() {
    if (mounted) setState(() {});
  }

  /// Fill the reset OTP from the SMS. Not auto-submitted: the worker still picks
  /// a new PIN after this, so there is nothing to submit yet.
  void _onSmsCode(String code) {
    if (!mounted) return;
    setState(() {
      _otp.text = code;
      _otp.selection = TextSelection.collapsed(offset: _otp.text.length);
    });
  }

  @override
  void dispose() {
    _codeSub?.cancel();
    _autofill?.stopListening();
    _phone.removeListener(_onFieldChanged);
    _otp.removeListener(_onFieldChanged);
    _phone.dispose();
    _otp.dispose();
    _phoneFocus.dispose();
    _otpFocus.dispose();
    super.dispose();
  }

  /// The one error surface: a centred, blocking dialog with a "Theek hai"
  /// button. Guarded by [_dialogOpen] so a fast retry can't stack dialogs.
  Future<void> _showErrorAlert(String title, String message) async {
    if (_dialogOpen) return;
    _dialogOpen = true;
    await showBbAlert(context, title: title, message: message);
    if (mounted) _dialogOpen = false;
  }

  // --- phase 1: phone -------------------------------------------------------

  Future<void> _sendReset() async {
    setState(() => _busy = true);
    try {
      // Opened BEFORE the request (User Consent only matches an SMS that lands
      // after the window opens) and NOT awaited — a wedged Play Services must
      // never stall the reset SMS itself. Never throws.
      unawaited(_openOtpAutofillWindow());
      await _manager.requestPinReset(toE164(_phone.text));
      if (!mounted) return;
      // OTP FIRST — the worker enters the code before choosing a new PIN.
      setState(() => _phase = _Phase.otp);
    } on AuthFailure catch (f) {
      if (!mounted) return;
      unawaited(
        _showErrorAlert('OTP nahi bhej paye', authErrorMessage(f, 'hi')),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _openOtpAutofillWindow() async {
    try {
      await _autofill?.startListening();
    } catch (_) {
      // No Play Services → the worker types the code.
    }
  }

  // --- phase 2: enter the OTP ------------------------------------------------

  /// Move on to choose a new PIN once a code has been entered. The code itself
  /// is verified with the new PIN at [_confirmReset] (the backend has no
  /// standalone reset-OTP verify), so a wrong code returns here from that step.
  void _otpContinue() {
    // The CTA is disabled until a code is entered (see [_otpView]), so there is
    // no empty-OTP error to surface here.
    setState(() {
      _phase = _Phase.pin;
      // A fresh form mounts with two empty rows. `onReadyChanged` only fires on
      // a CHANGE, so a stale `true` from an earlier visit would otherwise leave
      // "Save PIN & Continue" enabled over empty rows.
      _pinReady = false;
    });
  }

  // --- phase 3: choose a new PIN (enter + confirm, one page) ----------------

  /// Submit {phone, otp, newPin}. The OTP is verified here (there is no earlier
  /// verify), so a bad/expired code returns to the OTP step; a weak PIN re-opens
  /// the PIN step. Every failure is a dialog.
  Future<void> _confirmReset(String newPin) async {
    setState(() => _busy = true);
    try {
      await _manager.confirmPinReset(
        // E.164, exactly as the request step sent it. The controller holds only
        // the national digits now, so composing here is mandatory.
        toE164(_phone.text),
        _otp.text.trim(),
        newPin,
      );
      if (!mounted) return;
      // The redirect resolves the destination: locked → enter the new PIN at
      // /pin; loggedOut → bounced to /login.
      context.go(Routes.pin);
    } on AuthFailure catch (f) {
      if (!mounted) return;
      if (f.code == AuthErrorCode.pinWeak) {
        // Server weak-PIN → re-collect the PIN behind a dialog, same phase.
        // `reset()` clears both rows, which reports ready:false back here.
        _pinFormKey.currentState?.reset();
        unawaited(
          _showErrorAlert('Yeh PIN aasan hai', authErrorMessage(f, 'hi')),
        );
      } else {
        // Bad/expired OTP (401 → otpInvalid) or anything else → back to the OTP
        // step with the honest reason in a dialog, so the worker fixes the code
        // (their new PIN is not lost to a code they already typed).
        final bool badOtp = f.code == AuthErrorCode.otpInvalid;
        setState(() {
          _phase = _Phase.otp;
          // The PIN form unmounts here, so its ready flag must not survive it.
          _pinReady = false;
        });
        unawaited(
          _showErrorAlert(
            badOtp ? 'OTP sahi nahi' : 'Kuch gadbad ho gayi',
            authErrorMessage(f, 'hi'),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// The blue-header title for the current phase (the kit auth chrome carries
  /// the heading, so the phase bodies below start at the first control).
  String get _headerTitle => switch (_phase) {
    _Phase.phone => 'Apna number daalein',
    _Phase.otp => 'OTP daalein',
    _Phase.pin => 'Naya PIN banayein',
  };

  String get _headerSubtitle => switch (_phase) {
    _Phase.phone =>
      'Hum aapke number par OTP bhejenge — fir naya PIN bana sakte hain.',
    _Phase.otp => 'Number par aaya 6-digit OTP daalein.',
    _Phase.pin => 'Yeh naya PIN aapke purane PIN ko badal dega.',
  };

  @override
  Widget build(BuildContext context) {
    // Kit auth chrome: a full-bleed navy header (title/subtitle change per phase)
    // over the phase body. Pushed from enter-PIN, so a back affordance is shown.
    return Scaffold(
      backgroundColor: OnboardingColors.canvasBg,
      body: Column(
        children: <Widget>[
          ShiftBlueHeader(
            title: _headerTitle,
            subtitle: _headerSubtitle,
            onBack: () => Navigator.of(context).maybePop(),
          ),
          Expanded(
            child: SafeArea(
              top: false,
              child: switch (_phase) {
                _Phase.phone => _phoneView(),
                _Phase.otp => _otpView(),
                _Phase.pin => _pinView(),
              },
            ),
          ),
        ],
      ),
    );
  }

  /// Padding shared by the phone and OTP phases — the header's 16dp gutter
  /// widened to the forms' 20, with room above the first control.
  static const EdgeInsets _formPadding = EdgeInsets.fromLTRB(20, 24, 20, 24);

  Widget _phoneView() {
    return OnboardingBody(
      padding: _formPadding,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text('MOBILE NUMBER', style: OnboardingTypography.fieldMicroLabel()),
          const SizedBox(height: 8),
          PhoneNumberField(
            controller: _phone,
            focusNode: _phoneFocus,
            // Reuses the micro label above it rather than inventing new copy:
            // once digits hide the hint, TalkBack has nothing else to read.
            semanticLabel: 'MOBILE NUMBER',
          ),
          const SizedBox(height: 28),
          PrimaryActionButton(
            label: 'Send OTP',
            showArrow: false,
            isLoading: _busy,
            // Disabled until 10 digits — a half-typed number can only fail, and
            // a reset OTP is a real (billed) SMS.
            onPressed: _busy || !isCompleteNationalNumber(_phone.text)
                ? null
                : _sendReset,
          ),
        ],
      ),
    );
  }

  Widget _otpView() {
    return OnboardingBody(
      padding: _formPadding,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text('OTP DAALEIN', style: OnboardingTypography.fieldMicroLabel()),
          const SizedBox(height: 12),
          // Six cells, sized from the width available, so the row cannot
          // overflow at 320dp. One real field underneath keeps paste, autofill
          // and a single semantics node.
          OtpCodeField(controller: _otp, focusNode: _otpFocus),
          const SizedBox(height: 28),
          PrimaryActionButton(
            label: 'Aage badhein',
            // Enabled once a code has been entered; the code is verified with the
            // new PIN at the final confirm.
            onPressed: _otp.text.trim().isEmpty ? null : _otpContinue,
          ),
        ],
      ),
    );
  }

  Widget _pinView() {
    // Pin-phase errors are centred dialogs (weak-PIN block, confirm mismatch),
    // so the body is the two PIN rows plus the save CTA. Scroll-safe: centred
    // when there is room, scrolls (never overflows) on a short screen.
    return OnboardingBody(
      padding: const EdgeInsets.all(24),
      child: Column(
        children: <Widget>[
          const SizedBox(height: 10),
          BbSetPinForm(
            key: _pinFormKey,
            enterLabel: 'NAYA PIN DAALEIN',
            confirmLabel: 'PIN DOBARA DAALEIN',
            busy: _busy,
            busyCaption: 'PIN set kar rahe hain…',
            pinStyle: BbPinSlotStyle.shiftBlue,
            labelStyle: OnboardingTypography.fieldMicroLabel(),
            rowGap: 28,
            // Button mode — nothing is sent until "Save PIN & Continue".
            submitOnComplete: false,
            showBusySpinner: false,
            onReadyChanged: (bool ready) => setState(() => _pinReady = ready),
            onConfirmed: _confirmReset,
          ),
          const SizedBox(height: 40),
          PrimaryActionButton(
            buttonKey: const Key('forgotPinSaveButton'),
            label: 'Save PIN & Continue',
            showArrow: false,
            isLoading: _busy,
            onPressed: _pinReady && !_busy
                ? () => _pinFormKey.currentState?.submit()
                : null,
          ),
        ],
      ),
    );
  }
}
