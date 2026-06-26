import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/theme/app_typography.dart';
import '../../core/widgets/bb_app_bar.dart';
import '../../core/widgets/bb_button.dart';
import '../../core/widgets/bb_scaffold.dart';
import '../../router.dart';

/// Route arguments for [OtpVerifyScreen]: the worker's [phone] and the
/// server-driven resend cooldown ([resendInSeconds] — the
/// `OTP_RESEND_COOLDOWN_SECONDS` value the API returned from /auth/otp/request).
/// The cooldown is sourced from the server, never a hard-coded client constant.
class OtpVerifyArgs {
  const OtpVerifyArgs({required this.phone, required this.resendInSeconds});

  final String phone;
  final int resendInSeconds;
}

/// OTP code screen.
///
/// The worker reads the code from their real SMS and types it here. There is NO
/// developer convenience: the code is never displayed, pre-filled, or
/// auto-submitted, in any state. `dev_otp` (echoed by the console SMS provider
/// in dev/test) is never read by the client, so there is nothing to show.
///
/// Errors are neutral and give no oracle: a wrong/expired code shows a single
/// "incorrect or expired code" message; a failed resend (send error / rate
/// limit / cap / breaker) shows ONE neutral message that never reveals whether
/// the number is registered or which limit was hit.
class OtpVerifyScreen extends StatefulWidget {
  const OtpVerifyScreen({super.key, ApiClient? api}) : _injectedApi = api;

  /// Test seam: lets a widget test inject an [ApiClient] with a fake
  /// `http.Client`. Production constructs the default client below.
  final ApiClient? _injectedApi;

  @override
  State<OtpVerifyScreen> createState() => _OtpVerifyScreenState();
}

class _OtpVerifyScreenState extends State<OtpVerifyScreen> {
  final TextEditingController _controller = TextEditingController();
  late final ApiClient _api;

  bool _loading = false;
  bool _resending = false;

  /// Single neutral error line shown beneath the field. Null = no error.
  String? _error;

  /// Seconds left on the resend cooldown. While > 0 the resend action is
  /// disabled; it re-enables at 0. Seeded from the server's `resend_in_seconds`
  /// on the first send and reset from the server value on every resend.
  int _cooldown = 0;
  Timer? _ticker;

  /// Captured once from the route args so didChangeDependencies seeds the
  /// initial cooldown exactly once.
  bool _seeded = false;

  @override
  void initState() {
    super.initState();
    _api = widget._injectedApi ?? createApiClient();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_seeded) return;
    final OtpVerifyArgs? args =
        ModalRoute.of(context)?.settings.arguments as OtpVerifyArgs?;
    if (args != null) _startCooldown(args.resendInSeconds);
    _seeded = true;
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _controller.dispose();
    if (widget._injectedApi == null) _api.dispose();
    super.dispose();
  }

  /// Starts (or restarts) the resend countdown from the server-provided
  /// [seconds]. A non-positive value leaves resend immediately available.
  void _startCooldown(int seconds) {
    _ticker?.cancel();
    if (seconds <= 0) {
      setState(() => _cooldown = 0);
      return;
    }
    setState(() => _cooldown = seconds);
    _ticker = Timer.periodic(const Duration(seconds: 1), (Timer t) {
      if (!mounted) {
        t.cancel();
        return;
      }
      setState(() {
        _cooldown -= 1;
        if (_cooldown <= 0) {
          _cooldown = 0;
          t.cancel();
        }
      });
    });
  }

  Future<void> _verify(String phone) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final VerifyOtpResult result =
          await _api.verifyOtp(phone, _controller.text.trim());
      AppState.instance.setWorker(
        phone: phone,
        workerId: result.workerId,
        sessionToken: result.accessToken,
      );
      if (!mounted) return;
      setState(() => _loading = false);
      Navigator.pushNamed(context, Routes.consent);
    } catch (_) {
      // Any verify failure (wrong code, expired code, too many attempts/lock)
      // surfaces ONE neutral message — no oracle for which case it was.
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'That code is incorrect or expired. Please try again.';
      });
    }
  }

  Future<void> _resend(String phone) async {
    if (_resending || _cooldown > 0) return;
    setState(() {
      _resending = true;
      _error = null;
    });
    try {
      final RequestOtpResult result = await _api.requestOtp(phone);
      if (!mounted) return;
      setState(() => _resending = false);
      // Restart the countdown from the fresh server cooldown.
      _startCooldown(result.resendInSeconds);
    } catch (_) {
      // Send failure / rate-limit / cap / breaker: ONE neutral message that
      // never reveals whether the number is registered or which limit was hit.
      if (!mounted) return;
      setState(() {
        _resending = false;
        _error = "Couldn't send a code right now — please try again shortly.";
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final OtpVerifyArgs? args =
        ModalRoute.of(context)?.settings.arguments as OtpVerifyArgs?;
    final String phone = args?.phone ?? '';
    final bool canResend = !_resending && _cooldown == 0;

    return BbScaffold(
      appBar: const BbAppBar(title: 'Verify OTP'),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const SizedBox(height: AppSpacing.s7),
          Text('Enter the code',
              style: AppTypography.display(size: AppTypography.sizeXl)),
          const SizedBox(height: AppSpacing.s2),
          Text(
            'We sent a one-time code by SMS to $phone. Type it below.',
            style: AppTypography.body(color: AppColors.textSecondary),
          ),
          const SizedBox(height: AppSpacing.s6),
          // Big mono cells for the code — data font, generously tracked. The
          // worker types what they received; nothing is pre-filled.
          TextField(
            key: const Key('otpCodeField'),
            controller: _controller,
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
            Row(
              children: <Widget>[
                const Icon(Icons.error_outline,
                    size: 18, color: AppColors.danger),
                const SizedBox(width: AppSpacing.s2),
                Expanded(
                  child: Text(
                    _error!,
                    key: const Key('otpErrorText'),
                    style: AppTypography.body(
                      size: AppTypography.sizeSm,
                      color: AppColors.danger,
                    ),
                  ),
                ),
              ],
            ),
          ],
          const SizedBox(height: AppSpacing.s7),
          BbButton(
            label: _loading ? 'Verifying…' : 'Verify',
            block: true,
            loading: _loading,
            onPressed: _loading ? null : () => _verify(phone),
          ),
          const SizedBox(height: AppSpacing.s4),
          // Resend — disabled while the server cooldown runs, re-enabled at 0.
          // Icon + label, ghost styling, full-height tap target (≥48px).
          SizedBox(
            height: AppSpacing.tap,
            child: TextButton.icon(
              key: const Key('otpResendButton'),
              onPressed: canResend ? () => _resend(phone) : null,
              icon: const Icon(Icons.refresh_rounded, size: 20),
              label: Text(
                _cooldown > 0
                    ? 'Resend code in ${_cooldown}s'
                    : (_resending ? 'Sending…' : 'Resend code'),
                style: AppTypography.body(
                  size: AppTypography.sizeBase,
                  weight: FontWeight.w700,
                  color: canResend ? AppColors.textLink : AppColors.textMuted,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
