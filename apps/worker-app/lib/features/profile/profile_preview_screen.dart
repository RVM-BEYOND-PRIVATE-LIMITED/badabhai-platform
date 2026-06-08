import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/state/app_state.dart';
import '../../router.dart';

class ProfilePreviewScreen extends StatefulWidget {
  const ProfilePreviewScreen({super.key});

  @override
  State<ProfilePreviewScreen> createState() => _ProfilePreviewScreenState();
}

class _ProfilePreviewScreenState extends State<ProfilePreviewScreen> {
  final ApiClient _api = ApiClient();
  bool _loading = true;
  String? _profileId;

  @override
  void initState() {
    super.initState();
    _extract();
  }

  Future<void> _extract() async {
    final String? workerId = AppState.instance.workerId;
    if (workerId == null) {
      setState(() => _loading = false);
      return;
    }
    final ExtractResult result = await _api.extractProfile(
      workerId: workerId,
      sessionId: AppState.instance.sessionId,
    );
    AppState.instance.setProfile(result.profileId);
    if (!mounted) return;
    setState(() {
      _profileId = result.profileId;
      _loading = false;
    });
  }

  Future<void> _confirmAndGenerate() async {
    final String? workerId = AppState.instance.workerId;
    final String? profileId = _profileId;
    if (workerId == null || profileId == null) return;
    await _api.confirmProfile(workerId: workerId, profileId: profileId);
    if (!mounted) return;
    Navigator.pushNamed(context, Routes.resumePreview);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Your profile')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  const Text('Draft profile (placeholder data):'),
                  const SizedBox(height: 12),
                  const Card(
                    child: ListTile(title: Text('Role'), subtitle: Text('VMC Operator')),
                  ),
                  const Card(
                    child: ListTile(title: Text('Experience'), subtitle: Text('5 years')),
                  ),
                  const Card(
                    child: ListTile(title: Text('Machines'), subtitle: Text('VMC, CNC Lathe')),
                  ),
                  const SizedBox(height: 24),
                  FilledButton(
                    onPressed: _confirmAndGenerate,
                    child: const Text('Confirm & generate resume'),
                  ),
                ],
              ),
            ),
    );
  }
}
