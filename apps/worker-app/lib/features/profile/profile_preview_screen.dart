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
  bool _failed = false;
  String? _profileId;

  @override
  void initState() {
    super.initState();
    _extract();
  }

  Future<void> _extract() async {
    final String? token = AppState.instance.sessionToken;
    if (token == null) {
      setState(() => _loading = false);
      return;
    }
    setState(() {
      _loading = true;
      _failed = false;
    });
    try {
      // Extraction runs as a background job on the API; this awaits the job
      // and returns the ready profile id. Can take a few seconds.
      final String profileId = await _api.extractProfile(
        authToken: token,
        sessionId: AppState.instance.sessionId,
      );
      AppState.instance.setProfile(profileId);
      if (!mounted) return;
      setState(() {
        _profileId = profileId;
        _loading = false;
      });
    } catch (_) {
      // Timeout, job failure, or no network. Show a friendly retry rather than
      // a stuck spinner. (No PII or error detail logged here.)
      if (!mounted) return;
      setState(() {
        _loading = false;
        _failed = true;
      });
    }
  }

  Future<void> _confirmAndGenerate() async {
    final String? token = AppState.instance.sessionToken;
    final String? profileId = _profileId;
    if (token == null || profileId == null) return;
    await _api.confirmProfile(authToken: token, profileId: profileId);
    if (!mounted) return;
    Navigator.pushNamed(context, Routes.resumePreview);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Your profile')),
      body: _loading
          ? _buildWaiting()
          : _failed
              ? _buildFailed()
              : _buildProfile(),
    );
  }

  /// Shown while the background extraction job is running. Friendly, low-text
  /// waiting state so a first-time user is not left staring at a bare spinner.
  Widget _buildWaiting() {
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            CircularProgressIndicator(),
            SizedBox(height: 24),
            Text(
              'Bada Bhai is preparing your profile…',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 18),
            ),
            SizedBox(height: 8),
            Text(
              'This takes a few seconds. Please wait.',
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  /// Shown when extraction times out, fails, or there is no network. Offers a
  /// large, simple retry button.
  Widget _buildFailed() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(Icons.cloud_off, size: 48),
            const SizedBox(height: 16),
            const Text(
              'Could not prepare your profile.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 18),
            ),
            const SizedBox(height: 8),
            const Text(
              'Please check your internet and try again.',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _extract,
              child: const Text('Try again'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildProfile() {
    return Padding(
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
    );
  }
}
