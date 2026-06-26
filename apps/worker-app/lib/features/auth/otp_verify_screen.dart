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

class OtpVerifyScreen extends StatefulWidget {
  const OtpVerifyScreen({super.key});

  @override
  State<OtpVerifyScreen> createState() => _OtpVerifyScreenState();
}

class _OtpVerifyScreenState extends State<OtpVerifyScreen> {
  final TextEditingController _controller = TextEditingController();
  final ApiClient _api = createApiClient();
  bool _loading = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _verify(String phone) async {
    setState(() => _loading = true);
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
  }

  @override
  Widget build(BuildContext context) {
    final String phone =
        (ModalRoute.of(context)?.settings.arguments as String?) ?? '';
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
            'Sent to $phone (mock — any 4-6 digits)',
            style: AppTypography.body(color: AppColors.textSecondary),
          ),
          const SizedBox(height: AppSpacing.s6),
          // Big mono cells for the code — data font, generously tracked.
          TextField(
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
          const SizedBox(height: AppSpacing.s7),
          BbButton(
            label: _loading ? 'Verifying…' : 'Verify',
            block: true,
            loading: _loading,
            onPressed: _loading ? null : () => _verify(phone),
          ),
        ],
      ),
    );
  }
}
