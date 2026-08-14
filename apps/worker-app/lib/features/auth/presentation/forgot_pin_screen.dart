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
/// Three phases:
///  1. phone   → [AuthSessionManager.requestPinReset] (POST /auth/pin/reset/request)
///  2. pin     → enter + confirm a brand-new 4-digit PIN on the [BbPinKeypad]
///  3. confirm → [AuthSessionManager.confirmPinReset] (POST /auth/pin/reset/confirm)
///     with {phone, otp, newPin} in ONE call.
///
/// It never calls verifyOtp and never routes through set-PIN. On a bad/expired
/// OTP (401 → otpInvalid) it shows neutral OTP copy and returns to the OTP step;
/// on a weak/format PIN (400 → pinWeak) it re-collects the PIN. On success it
/// routes to [Routes.pin] — the redirect bounces to /login if the worker is now
/// loggedOut (no surviving refresh token).
///
/// A guessable PIN (1111 / 1234) is BLOCKED CLIENT-SIDE ([isWeakPin]) the moment
/// it is entered, via a centred [showBbAlert] — so it never wastes the worker's
/// reset OTP (previously it was only caught server-side, after OTP + confirm).
/// The pin-phase errors (weak PIN, confirm mismatch) are dialogs now; the
/// phone/OTP steps keep their field-contextual inline copy.
class ForgotPinScreen extends StatefulWidget {
  const ForgotPinScreen({super.key});

  @override
  State<ForgotPinScreen> createState() => _ForgotPinScreenState();
}

enum _Phase { phone, pin, confirm }

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
  String? _error;

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

  /// Fill the reset OTP from the SMS. Not auto-submitted: confirm needs the new
  /// PIN too, and a wrong code would burn a verify attempt.
  void _onSmsCode(String code) {
    if (!mounted) return;
    _otp.text = code;
    _otp.selection = TextSelection.collapsed(offset: _otp.text.length);
  }

  @override
  void dispose() {
    _codeSub?.cancel();
    _autofill?.stopListening();
    _phone.dispose();
    _otp.dispose();
    super.dispose();
  }

  // --- phase 1: phone -------------------------------------------------------

  Future<void> _sendReset() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      // Opened BEFORE the request (User Consent only matches an SMS that lands
      // after the window opens) and NOT awaited — a wedged Play Services must
      // never stall the reset SMS itself. Never throws.
      unawaited(_openOtpAutofillWindow());
      await _manager.requestPinReset(toE164(_phone.text));
      if (!mounted) return;
      setState(() => _phase = _Phase.pin);
    } on AuthFailure catch (f) {
      if (!mounted) return;
      setState(() => _error = authErrorMessage(f, 'hi'));
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

  // --- phase 2: choose a new PIN (enter + confirm) --------------------------

  void _onDigit(String d) {
    if (_buffer.length >= kPinLength) return;
    setState(() {
      _error = null;
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
      _error = null;
      if (_pinStep == _PinStep.enter && _first.isNotEmpty) {
        _first = _first.substring(0, _first.length - 1);
      } else if (_pinStep == _PinStep.confirm && _confirm.isNotEmpty) {
        _confirm = _confirm.substring(0, _confirm.length - 1);
      }
    });
  }

  void _advancePin() {
    if (_pinStep == _PinStep.enter) {
      // HARD client block: catch a guessable PIN HERE, before it spends the
      // worker's reset OTP on a server rejection they won't understand.
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
    setState(() {
      _newPin = _first;
      _first = '';
      _confirm = '';
      _phase = _Phase.confirm;
    });
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
      _error = null;
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
      _error = null;
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

  /// The SERVER rejected the new PIN as weak (a pattern our local [isWeakPin]
  /// does not catch). Surface its reason in the same centred dialog.
  Future<void> _showWeakServerAlert(String message) async {
    if (_dialogOpen) return;
    _dialogOpen = true;
    await showBbAlert(context, title: 'Yeh PIN aasan hai', message: message);
    if (mounted) _dialogOpen = false;
  }

  // --- phase 3: confirm OTP + new PIN ---------------------------------------

  Future<void> _confirmReset() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _manager.confirmPinReset(
        // E.164, exactly as the request step sent it. The controller holds only
        // the national digits now, so composing here is mandatory — passing the
        // raw text would send a bare 10-digit number and fail the reset AFTER
        // the worker had already spent their OTP.
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
      // 400 (weak/format PIN) → re-collect the PIN behind a centred dialog (the
      // same treatment as the client-side block). 401 (bad/expired OTP) and the
      // rest stay as field-contextual inline copy on their own step.
      if (f.code == AuthErrorCode.pinWeak) {
        setState(() {
          _error = null;
          _newPin = '';
          _first = '';
          _confirm = '';
          _pinStep = _PinStep.enter;
          _phase = _Phase.pin;
        });
        unawaited(_showWeakServerAlert(authErrorMessage(f, 'hi')));
      } else {
        setState(() => _error = authErrorMessage(f, 'hi'));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// The blue-header title for the current phase/step (the kit auth chrome
  /// carries the heading, so the phase bodies below start at the first control).
  String get _headerTitle => switch (_phase) {
        _Phase.phone => 'Apna number daalein',
        _Phase.pin => _pinStep == _PinStep.confirm
            ? 'PIN dobara daalein'
            : 'Naya 4-digit PIN banayein',
        _Phase.confirm => 'OTP daalein',
      };

  String get _headerSubtitle => switch (_phase) {
        _Phase.phone =>
          'Hum aapke number par OTP bhejenge — fir naya PIN bana sakte hain.',
        _Phase.pin => _pinStep == _PinStep.confirm
            ? 'Confirm karne ke liye wahi PIN dobara daalein.'
            : 'Yeh naya PIN aapke purane PIN ko badal dega.',
        _Phase.confirm =>
          'Number par aaya OTP daalein — naya PIN set ho jayega.',
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
                _Phase.pin => _pinView(),
                _Phase.confirm => _confirmView(),
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
          if (_error != null) ...<Widget>[
            const SizedBox(height: AppSpacing.s3),
            _errorText(_error!),
          ],
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

  Widget _pinView() {
    // Pin-phase errors are centred dialogs now (weak-PIN block, confirm
    // mismatch), so the body is just the masked dots + keypad. Scroll-safe:
    // centred when there is room, scrolls (never overflows) on a short screen.
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

  Widget _confirmView() {
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
            style: AppTypography.mono(
              size: AppTypography.size2xl,
              weight: FontWeight.w700,
              letterSpacing: 12,
            ),
            decoration: const InputDecoration(hintText: '— — — —'),
          ),
          if (_error != null) ...<Widget>[
            const SizedBox(height: AppSpacing.s3),
            _errorText(_error!),
          ],
          const SizedBox(height: AppSpacing.s7),
          BbButton(
            label: 'Naya PIN set karein',
            block: true,
            loading: _busy,
            onPressed: _busy ? null : _confirmReset,
          ),
        ],
      ),
    );
  }

  Widget _errorText(String message) => Text(
        message,
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          color: AppColors.danger,
        ),
      );
}
