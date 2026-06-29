import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/auth_error_messages.dart';
import '../../../core/auth/auth_failure.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../router.dart';
import '../domain/auth_session_manager.dart';
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
  final TextEditingController _phone = TextEditingController(text: '+91');
  final TextEditingController _otp = TextEditingController();

  _Phase _phase = _Phase.phone;
  _PinStep _pinStep = _PinStep.enter;

  /// PIN buffers — LOCAL widget state only; never persisted, never logged.
  String _first = '';
  String _confirm = '';
  String _newPin = ''; // the confirmed PIN, held only until the confirm call

  bool _busy = false;
  String? _error;

  String get _buffer => _pinStep == _PinStep.enter ? _first : _confirm;

  @override
  void dispose() {
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
      await _manager.requestPinReset(_phone.text.trim());
      if (!mounted) return;
      setState(() => _phase = _Phase.pin);
    } on AuthFailure catch (f) {
      if (!mounted) return;
      setState(() => _error = authErrorMessage(f, 'hi'));
    } finally {
      if (mounted) setState(() => _busy = false);
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
      setState(() => _pinStep = _PinStep.confirm);
      return;
    }
    if (_confirm != _first) {
      setState(() {
        _error = 'PIN match nahi hua. Dobara try karein.';
        _first = '';
        _confirm = '';
        _pinStep = _PinStep.enter;
      });
      return;
    }
    setState(() {
      _newPin = _first;
      _first = '';
      _confirm = '';
      _phase = _Phase.confirm;
    });
  }

  // --- phase 3: confirm OTP + new PIN ---------------------------------------

  Future<void> _confirmReset() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _manager.confirmPinReset(
        _phone.text.trim(),
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
      setState(() {
        _error = authErrorMessage(f, 'hi');
        // 401 (bad/expired OTP) → back to the OTP step; 400 (weak/format PIN) →
        // re-collect the PIN.
        if (f.code == AuthErrorCode.pinWeak) {
          _newPin = '';
          _pinStep = _PinStep.enter;
          _phase = _Phase.pin;
        }
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return BbScaffold(
      appBar: const BbAppBar(title: 'PIN reset'),
      body: switch (_phase) {
        _Phase.phone => _phoneView(),
        _Phase.pin => _pinView(),
        _Phase.confirm => _confirmView(),
      },
    );
  }

  Widget _phoneView() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const SizedBox(height: AppSpacing.s6),
        Text(
          'Apna number daalein',
          style: AppTypography.display(size: AppTypography.sizeXl),
        ),
        const SizedBox(height: AppSpacing.s2),
        Text(
          'Hum aapke number par OTP bhejenge — fir naya PIN bana sakte hain.',
          style: AppTypography.body(color: AppColors.textSecondary),
        ),
        const SizedBox(height: AppSpacing.s6),
        TextField(
          controller: _phone,
          keyboardType: TextInputType.phone,
          style: AppTypography.mono(size: AppTypography.sizeLg),
          decoration: const InputDecoration(
            hintText: '+91XXXXXXXXXX',
            prefixIcon: Icon(Icons.phone_outlined),
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
          onPressed: _busy ? null : _sendReset,
        ),
      ],
    );
  }

  Widget _pinView() {
    final bool confirming = _pinStep == _PinStep.confirm;
    return Column(
      children: <Widget>[
        const Spacer(flex: 1),
        Icon(
          confirming ? Icons.check_circle_outline : Icons.pin_outlined,
          size: 40,
          color: AppColors.brand,
        ),
        const SizedBox(height: AppSpacing.s4),
        Text(
          confirming ? 'PIN dobara daalein' : 'Naya 4-digit PIN banayein',
          style: AppTypography.display(size: AppTypography.sizeXl),
        ),
        const SizedBox(height: AppSpacing.s2),
        Text(
          confirming
              ? 'Confirm karne ke liye wahi PIN dobara daalein.'
              : 'Yeh naya PIN aapke purane PIN ko badal dega.',
          textAlign: TextAlign.center,
          style: AppTypography.body(color: AppColors.textSecondary),
        ),
        const SizedBox(height: AppSpacing.s7),
        BbPinView(length: kPinLength, filled: _buffer.length, error: _error != null),
        const SizedBox(height: AppSpacing.s4),
        SizedBox(
          height: AppSpacing.s6,
          child: _error != null ? _errorText(_error!) : null,
        ),
        const SizedBox(height: AppSpacing.s4),
        BbPinKeypad(onDigit: _onDigit, onBackspace: _onBackspace),
        const Spacer(flex: 2),
      ],
    );
  }

  Widget _confirmView() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const SizedBox(height: AppSpacing.s6),
        Text(
          'OTP daalein',
          style: AppTypography.display(size: AppTypography.sizeXl),
        ),
        const SizedBox(height: AppSpacing.s2),
        Text(
          'Number par aaya OTP daalein — naya PIN set ho jayega.',
          style: AppTypography.body(color: AppColors.textSecondary),
        ),
        const SizedBox(height: AppSpacing.s6),
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
