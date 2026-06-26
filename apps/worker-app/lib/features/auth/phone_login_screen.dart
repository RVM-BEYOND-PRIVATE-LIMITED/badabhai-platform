import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/theme/app_typography.dart';
import '../../core/widgets/bb_app_bar.dart';
import '../../core/widgets/bb_button.dart';
import '../../core/widgets/bb_scaffold.dart';
import '../../router.dart';
import 'otp_verify_screen.dart';

class PhoneLoginScreen extends StatefulWidget {
  const PhoneLoginScreen({super.key, ApiClient? api}) : _injectedApi = api;

  /// Test seam: lets a widget test inject an [ApiClient] with a fake
  /// `http.Client`. Production constructs the default client below.
  final ApiClient? _injectedApi;

  @override
  State<PhoneLoginScreen> createState() => _PhoneLoginScreenState();
}

class _PhoneLoginScreenState extends State<PhoneLoginScreen> {
  final TextEditingController _controller = TextEditingController(text: '+91');
  late final ApiClient _api;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _api = widget._injectedApi ?? createApiClient();
  }

  @override
  void dispose() {
    _controller.dispose();
    if (widget._injectedApi == null) _api.dispose();
    super.dispose();
  }

  Future<void> _continue() async {
    final String phone = _controller.text.trim();
    setState(() => _loading = true);
    RequestOtpResult result;
    try {
      result = await _api.requestOtp(phone);
    } catch (_) {
      // Send failure / rate-limit / cap / breaker (any 4xx/5xx or no network):
      // ONE neutral message. Never reveals whether the number is registered or
      // which limit was hit, and never advances to the code screen.
      if (!mounted) return;
      setState(() => _loading = false);
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(
          const SnackBar(
            content: Text("Couldn't send a code right now — please try again shortly."),
          ),
        );
      return;
    }
    if (!mounted) return;
    setState(() => _loading = false);
    Navigator.pushNamed(
      context,
      Routes.otpVerify,
      arguments: OtpVerifyArgs(
        phone: phone,
        resendInSeconds: result.resendInSeconds,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return BbScaffold(
      appBar: const BbAppBar(title: 'Login'),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const SizedBox(height: AppSpacing.s7),
          Text('Enter your phone number',
              style: AppTypography.display(size: AppTypography.sizeXl)),
          const SizedBox(height: AppSpacing.s2),
          Text(
            'We send a one-time code to log you in.',
            style: AppTypography.body(color: AppColors.textSecondary),
          ),
          const SizedBox(height: AppSpacing.s6),
          TextField(
            controller: _controller,
            keyboardType: TextInputType.phone,
            style: AppTypography.mono(size: AppTypography.sizeLg),
            decoration: const InputDecoration(
              hintText: '+91XXXXXXXXXX',
              prefixIcon: Icon(Icons.phone_outlined),
            ),
          ),
          const SizedBox(height: AppSpacing.s4),
          Row(
            children: <Widget>[
              const Icon(Icons.lock_outline,
                  size: 18, color: AppColors.textMuted),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: Text(
                  'Your number stays private. We never show it to anyone.',
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.textMuted,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.s7),
          BbButton(
            label: _loading ? 'Sending OTP…' : 'Send OTP',
            block: true,
            loading: _loading,
            onPressed: _loading ? null : _continue,
          ),
        ],
      ),
    );
  }
}
