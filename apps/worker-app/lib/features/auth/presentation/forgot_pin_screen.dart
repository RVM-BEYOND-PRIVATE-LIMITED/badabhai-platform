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

/// Forgot-PIN: a self-contained phone → OTP mini-flow that always ends at
/// set-PIN (reset), so a worker who forgot their PIN re-proves their number and
/// chooses a fresh one without falling back into the normal "returning worker →
/// shell" routing.
///
/// It talks to [AuthSessionManager] directly (the same OTP verify that mints +
/// bridges tokens), then routes to the set-PIN screen in reset mode.
class ForgotPinScreen extends StatefulWidget {
  const ForgotPinScreen({super.key});

  @override
  State<ForgotPinScreen> createState() => _ForgotPinScreenState();
}

enum _Phase { phone, otp }

class _ForgotPinScreenState extends State<ForgotPinScreen> {
  final AuthSessionManager _manager = locator<AuthSessionManager>();
  final TextEditingController _phone = TextEditingController(text: '+91');
  final TextEditingController _otp = TextEditingController();

  _Phase _phase = _Phase.phone;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _phone.dispose();
    _otp.dispose();
    super.dispose();
  }

  Future<void> _sendOtp() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _manager.forgotPin(_phone.text.trim());
      if (!mounted) return;
      setState(() => _phase = _Phase.otp);
    } on AuthFailure catch (f) {
      if (!mounted) return;
      setState(() => _error = authErrorMessage(f, 'hi'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _manager.verifyOtp(_phone.text.trim(), _otp.text.trim());
      if (!mounted) return;
      // Always go to set-PIN in RESET mode — a forgot-PIN worker must choose a
      // fresh PIN even though the OTP already authenticated them.
      context.go(Routes.setPin, extra: true);
    } on AuthFailure catch (f) {
      if (!mounted) return;
      setState(() => _error = authErrorMessage(f, 'hi'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final bool onOtp = _phase == _Phase.otp;
    return BbScaffold(
      appBar: const BbAppBar(title: 'PIN reset'),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const SizedBox(height: AppSpacing.s6),
          Text(
            onOtp ? 'Code daalein' : 'Apna number daalein',
            style: AppTypography.display(size: AppTypography.sizeXl),
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            onOtp
                ? 'OTP confirm karein, fir naya PIN banayein.'
                : 'Hum aapke number par OTP bhejenge — fir naya PIN bana sakte hain.',
            style: AppTypography.body(color: AppColors.textSecondary),
          ),
          const SizedBox(height: AppSpacing.s6),
          if (!onOtp)
            TextField(
              controller: _phone,
              keyboardType: TextInputType.phone,
              style: AppTypography.mono(size: AppTypography.sizeLg),
              decoration: const InputDecoration(
                hintText: '+91XXXXXXXXXX',
                prefixIcon: Icon(Icons.phone_outlined),
              ),
            )
          else
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
            Text(
              _error!,
              style: AppTypography.body(
                  size: AppTypography.sizeSm, color: AppColors.danger),
            ),
          ],
          const SizedBox(height: AppSpacing.s7),
          BbButton(
            label: onOtp ? 'Verify' : 'Send OTP',
            block: true,
            loading: _busy,
            onPressed: _busy ? null : (onOtp ? _verify : _sendOtp),
          ),
        ],
      ),
    );
  }
}
