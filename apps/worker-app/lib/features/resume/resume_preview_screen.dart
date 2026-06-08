import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/state/app_state.dart';
import '../../router.dart';

class ResumePreviewScreen extends StatefulWidget {
  const ResumePreviewScreen({super.key});

  @override
  State<ResumePreviewScreen> createState() => _ResumePreviewScreenState();
}

class _ResumePreviewScreenState extends State<ResumePreviewScreen> {
  final ApiClient _api = ApiClient();
  bool _loading = true;
  String _resume = '';

  @override
  void initState() {
    super.initState();
    _generate();
  }

  Future<void> _generate() async {
    final String? workerId = AppState.instance.workerId;
    final String? profileId = AppState.instance.profileId;
    if (workerId == null || profileId == null) {
      setState(() => _loading = false);
      return;
    }
    final String resume = await _api.generateResume(workerId: workerId, profileId: profileId);
    if (!mounted) return;
    setState(() {
      _resume = resume;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Your resume')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Text(_resume),
                    ),
                  ),
                  const SizedBox(height: 24),
                  FilledButton(
                    onPressed: () => Navigator.pushNamedAndRemoveUntil(
                      context,
                      Routes.splash,
                      (Route<dynamic> route) => false,
                    ),
                    child: const Text('Done'),
                  ),
                ],
              ),
            ),
    );
  }
}
