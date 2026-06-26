import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config.dart';
import '../../core/state/app_state.dart';
import '../../router.dart';

class ConsentScreen extends StatefulWidget {
  const ConsentScreen({super.key});

  @override
  State<ConsentScreen> createState() => _ConsentScreenState();
}

class _ConsentScreenState extends State<ConsentScreen> {
  final ApiClient _api = createApiClient();
  bool _accepted = false;
  bool _loading = false;

  Future<void> _continue() async {
    final String? workerId = AppState.instance.workerId;
    if (workerId == null) return;
    setState(() => _loading = true);
    await _api.acceptConsent(
      workerId: workerId,
      purposes: <String>['profiling', 'resume_generation'],
    );
    if (!mounted) return;
    setState(() => _loading = false);
    Navigator.pushNamed(context, Routes.chatProfiling);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Consent')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            const Text(
              'We use your answers only to build your work profile and resume. '
              '(DPDP consent copy is a Phase 1 placeholder.)',
            ),
            const SizedBox(height: 12),
            CheckboxListTile(
              value: _accepted,
              onChanged: (bool? v) => setState(() => _accepted = v ?? false),
              title: const Text('I agree'),
              controlAffinity: ListTileControlAffinity.leading,
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: (_accepted && !_loading) ? _continue : null,
              child: _loading ? const Text('Saving…') : const Text('Continue'),
            ),
          ],
        ),
      ),
    );
  }
}
