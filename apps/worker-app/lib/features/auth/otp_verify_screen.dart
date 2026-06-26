import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config.dart';
import '../../core/state/app_state.dart';
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
    final VerifyOtpResult result = await _api.verifyOtp(phone, _controller.text.trim());
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
    final String phone = (ModalRoute.of(context)?.settings.arguments as String?) ?? '';
    return Scaffold(
      appBar: AppBar(title: const Text('Verify OTP')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text('Enter the OTP sent to $phone (mock — any 4-6 digits)'),
            const SizedBox(height: 12),
            TextField(
              controller: _controller,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                border: OutlineInputBorder(),
                hintText: '123456',
              ),
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _loading ? null : () => _verify(phone),
              child: _loading ? const Text('Verifying…') : const Text('Verify'),
            ),
          ],
        ),
      ),
    );
  }
}
