import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/phone_format.dart';
import '../../../core/auth/auth_error_messages.dart';
import '../../../core/auth/auth_failure.dart';
import '../../../core/di/locator.dart';
import '../../../core/otp/sms_otp_autofill.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_alert_dialog.dart';
import '../../../core/widgets/bb_blue_header.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../router.dart';
import '../domain/auth_session_manager.dart';
import '../domain/weak_pin.dart';
import 'enter_pin_screen.dart' show kPinLength;
import 'widgets/bb_pin_keypad.dart';
import 'widgets/bb_pin_view.dart';

/// Forgot-PIN: the dedicated PIN-RESET flow (NOT the normal OTP login).
///
/// Three phases, in the order a worker expects — the OTP comes BEFORE the new
/// PIN:
///  1. phone → [AuthSessionManager.requestPinReset] (POST /auth/pin/reset/request)
///  2. otp   → enter the code that just arrived (Android SMS auto-fills it)
///  3. pin   → enter + confirm a brand-new 4-digit PIN, then
///     [AuthSessionManager.confirmPinReset] (POST /auth/pin/reset/confirm) with
///     {phone, otp, newPin} in ONE call.
///
/// EVERY error on every step is a CENTRED, blocking [showBbAlert] with a single
/// "Theek hai" button — a couldn't-send-OTP, a missing code, a bad/expired code,
/// a guessable PIN, a confirm mismatch, a server weak-PIN. There is no tiny
/// inline red text a first-time, low-literacy worker would scroll past.
///
/// The backend verifies the OTP only at that final `/confirm` (there is no
/// standalone reset-OTP verify), so a wrong/expired code surfaces there and
/// returns the worker to the OTP step; a weak/format PIN re-collects the PIN. On
/// success it routes to [Routes.pin] — the redirect bounces to /login if the
/// worker is now loggedOut. A guessable PIN (1111 / 1234) is BLOCKED CLIENT-SIDE
/// the moment it is entered, so it never reaches the confirm call.
class ForgotPinScreen extends StatefulWidget {
  const ForgotPinScreen({super.key});

  @override
  State<ForgotPinScreen> createState() => _ForgotPinScreenState();
}

enum _Phase { phone, otp, pin }

/// Sub-step within the PIN phase: enter a PIN, then re-enter to confirm it.
enum _PinStep { enter, confirm }

class _ForgotPinScreenState extends State<ForgotPinScreen> {
  final AuthSessionManager _manager = locator<AuthSessionManager>();

  /// Holds ONLY the 10 national digits — `+91` is fixed chrome, not editable
  /// text. Seeding it into the controller let the worker backspace it away, and
  /// the raw text went straight to requestPinReset(), sending a malformed number
  /// (identical bug to the login screen).
  final TextEditingController _phone = TextEditingController();
  final TextEditingController _otp = TextEditingController();

  _Phase _phase = _Phase.phone;
  _PinStep _pinStep = _PinStep.enter;

  /// PIN buffers — LOCAL widget state only; never persisted, never logged.
  String _first = '';
  String _confirm = '';
  String _newPin = ''; // the confirmed PIN, held only until the confirm call

  bool _busy = false;

  /// True while an alert dialog is open, so a rapid tap or a rebuild can't stack
  /// a second dialog on top of the first.
  bool _dialogOpen = false;

  /// Android SMS auto-read for the reset OTP. Null when the locator has no
  /// instance (tests) — the screen stays usable by typing.
  SmsOtpAutofill? _autofill;
  StreamSubscription<String>? _codeSub;

  String get _buffer => _pinStep == _PinStep.enter ? _first : _confirm;

  @override
  void initState() {
    super.initState();
    // This is the app's SECOND OTP surface (login is the other). It bypasses
    // PhoneLoginCubit, so the SMS auto-read has to be wired here too — otherwise
    // a PIN reset is the one flow left where the worker still types the code.
    if (!locator.isRegistered<SmsOtpAutofill>()) return;
    final SmsOtpAutofill autofill = locator<SmsOtpAutofill>();
    _autofill = autofill;
    _codeSub = autofill.codes.listen(_onSmsCode);
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
    _phone.dispose();
    _otp.dispose();
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
      unawaited(_showErrorAlert('OTP nahi bhej paye', authErrorMessage(f, 'hi')));
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
    setState(() => _phase = _Phase.pin);
  }

  // --- phase 3: choose a new PIN (enter + confirm) --------------------------

  void _onDigit(String d) {
    if (_buffer.length >= kPinLength) return;
    setState(() {
      if (_pinStep == _PinStep.enter) {
        _first += d;
      } else {
        _confirm += d;
      }
    });
    if (_buffer.length == kPinLength) _advancePin();
  }

  void _onBackspace() {
    setState(() {
      if (_pinStep == _PinStep.enter && _first.isNotEmpty) {
        _first = _first.substring(0, _first.length - 1);
      } else if (_pinStep == _PinStep.confirm && _confirm.isNotEmpty) {
        _confirm = _confirm.substring(0, _confirm.length - 1);
      }
    });
  }

  void _advancePin() {
    if (_pinStep == _PinStep.enter) {
      // HARD client block: catch a guessable PIN HERE, before it reaches the
      // confirm call the worker won't understand a rejection from.
      if (isWeakPin(_first)) {
        _blockWeakPin();
        return;
      }
      setState(() => _pinStep = _PinStep.confirm);
      return;
    }
    if (_confirm != _first) {
      _mismatchPin();
      return;
    }
    // Both entries match — submit the OTP (already entered) + the new PIN.
    setState(() {
      _newPin = _first;
      _first = '';
      _confirm = '';
    });
    _confirmReset();
  }

  /// Guessable PIN — block it, explain in a dialog, and stay on the enter step.
  /// The buffer is cleared SYNCHRONOUSLY (before the await) so a re-tap while the
  /// dialog animates in can't re-fire this.
  Future<void> _blockWeakPin() async {
    if (_dialogOpen) return;
    _dialogOpen = true;
    setState(() {
      _first = '';
      _confirm = '';
      _pinStep = _PinStep.enter;
    });
    await showBbAlert(
      context,
      title: 'Yeh PIN aasan hai',
      message: '1234 ya 1111 jaisa PIN koi bhi aasani se guess kar sakta hai. '
          'Aisa 4-digit PIN chunein jo sirf aap jaante hain.',
    );
    if (mounted) _dialogOpen = false;
  }

  /// The two entries differed — explain, and send the worker back to the start.
  Future<void> _mismatchPin() async {
    if (_dialogOpen) return;
    _dialogOpen = true;
    setState(() {
      _first = '';
      _confirm = '';
      _pinStep = _PinStep.enter;
    });
    await showBbAlert(
      context,
      title: 'PIN alag hai',
      message: 'Dono baar ek jaisa PIN daalein. '
          'Pehli baar aur confirm wala PIN abhi alag hain.',
    );
    if (mounted) _dialogOpen = false;
  }

  /// Submit {phone, otp, newPin}. The OTP is verified here (there is no earlier
  /// verify), so a bad/expired code returns to the OTP step; a weak PIN re-opens
  /// the PIN step. Every failure is a dialog.
  Future<void> _confirmReset() async {
    setState(() => _busy = true);
    try {
      await _manager.confirmPinReset(
        // E.164, exactly as the request step sent it. The controller holds only
        // the national digits now, so composing here is mandatory.
        toE164(_phone.text),
        _otp.text.trim(),
        _newPin,
      );
      if (!mounted) return;
      _newPin = ''; // drop the PIN as soon as the call succeeds
      // The redirect resolves the destination: locked → enter the new PIN at
      // /pin; loggedOut → bounced to /login.
      context.go(Routes.pin);
    } on AuthFailure catch (f) {
      if (!mounted) return;
      if (f.code == AuthErrorCode.pinWeak) {
        // Server weak-PIN → re-collect the PIN behind a dialog.
        setState(() {
          _newPin = '';
          _first = '';
          _confirm = '';
          _pinStep = _PinStep.enter;
          _phase = _Phase.pin;
        });
        unawaited(_showErrorAlert('Yeh PIN aasan hai', authErrorMessage(f, 'hi')));
      } else {
        // Bad/expired OTP (401 → otpInvalid) or anything else → back to the OTP
        // step with the honest reason in a dialog, so the worker fixes the code
        // (their new PIN is not lost to a code they already typed).
        final bool badOtp = f.code == AuthErrorCode.otpInvalid;
        setState(() {
          _newPin = '';
          _first = '';
          _confirm = '';
          _pinStep = _PinStep.enter;
          _phase = _Phase.otp;
        });
        unawaited(_showErrorAlert(
          badOtp ? 'OTP sahi nahi' : 'Kuch gadbad ho gayi',
          authErrorMessage(f, 'hi'),
        ));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// The blue-header title for the current phase/step (the kit auth chrome
  /// carries the heading, so the phase bodies below start at the first control).
  String get _headerTitle => switch (_phase) {
        _Phase.phone => 'Apna number daalein',
        _Phase.otp => 'OTP daalein',
        _Phase.pin => _pinStep == _PinStep.confirm
            ? 'PIN dobara daalein'
            : 'Naya 4-digit PIN banayein',
      };

  String get _headerSubtitle => switch (_phase) {
        _Phase.phone =>
          'Hum aapke number par OTP bhejenge — fir naya PIN bana sakte hain.',
        _Phase.otp => 'Number par aaya 6-digit OTP daalein.',
        _Phase.pin => _pinStep == _PinStep.confirm
            ? 'Confirm karne ke liye wahi PIN dobara daalein.'
            : 'Yeh naya PIN aapke purane PIN ko badal dega.',
      };

  @override
  Widget build(BuildContext context) {
    // Kit auth chrome: a full-bleed blue header (title/subtitle change per phase)
    // over the phase body. Pushed from enter-PIN, so a back affordance is shown.
    return Scaffold(
      body: Column(
        children: <Widget>[
          BbBlueHeader(
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

  Widget _phoneView() {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s6,
        AppSpacing.gutter,
        AppSpacing.s6,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text('MOBILE NUMBER',
              style: AppTypography.eyebrow(color: AppColors.textMuted)),
          const SizedBox(height: AppSpacing.s2),
          TextField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            style: AppTypography.mono(size: AppTypography.sizeLg),
            onChanged: (_) => setState(() {}), // repaint the CTA at 10 digits
            inputFormatters: <TextInputFormatter>[
              FilteringTextInputFormatter.digitsOnly,
              LengthLimitingTextInputFormatter(kNationalNumberDigits),
            ],
            decoration: InputDecoration(
              prefixText: '$kIndiaDialCode ',
              prefixStyle: AppTypography.mono(size: AppTypography.sizeLg),
              hintText: 'XXXXXXXXXX',
            ),
          ),
          const SizedBox(height: AppSpacing.s7),
          BbButton(
            label: 'Send OTP',
            block: true,
            loading: _busy,
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
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s6,
        AppSpacing.gutter,
        AppSpacing.s6,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text('OTP DAALEIN',
              style: AppTypography.eyebrow(color: AppColors.textMuted)),
          const SizedBox(height: AppSpacing.s3),
          TextField(
            controller: _otp,
            keyboardType: TextInputType.number,
            textAlign: TextAlign.center,
            onChanged: (_) => setState(() {}), // enable the CTA when filled
            style: AppTypography.mono(
              size: AppTypography.size2xl,
              weight: FontWeight.w700,
              letterSpacing: 12,
            ),
            decoration: const InputDecoration(hintText: '— — — —'),
          ),
          const SizedBox(height: AppSpacing.s7),
          BbButton(
            label: 'Aage badhein',
            block: true,
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
    // so the body is just the masked dots + keypad. Scroll-safe: centred when
    // there is room, scrolls (never overflows) on a short screen.
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        return SingleChildScrollView(
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: constraints.maxHeight),
            child: IntrinsicHeight(
              child: Padding(
                padding:
                    const EdgeInsets.symmetric(horizontal: AppSpacing.gutter),
                child: Column(
                  children: <Widget>[
                    const Spacer(flex: 1),
                    BbPinView(length: kPinLength, filled: _buffer.length),
                    const SizedBox(height: AppSpacing.s6),
                    BbPinKeypad(onDigit: _onDigit, onBackspace: _onBackspace),
                    const Spacer(flex: 2),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
