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

class ProfilePreviewScreen extends StatefulWidget {
  const ProfilePreviewScreen({super.key});

  @override
  State<ProfilePreviewScreen> createState() => _ProfilePreviewScreenState();
}

class _ProfilePreviewScreenState extends State<ProfilePreviewScreen> {
  final ApiClient _api = createApiClient();
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
    return BbScaffold(
      appBar: const BbAppBar(title: 'Your profile'),
      bottomBar: _loading || _failed
          ? null
          : BbButton(
              label: 'Confirm & generate resume',
              block: true,
              iconLeft: Icons.description_outlined,
              onPressed: _confirmAndGenerate,
            ),
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
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const CircularProgressIndicator(),
          const SizedBox(height: AppSpacing.s6),
          Text(
            'Bada Bhai is preparing your profile…',
            textAlign: TextAlign.center,
            style: AppTypography.display(size: AppTypography.sizeMd),
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            'This takes a few seconds. Please wait.',
            textAlign: TextAlign.center,
            style: AppTypography.body(color: AppColors.textSecondary),
          ),
        ],
      ),
    );
  }

  /// Shown when extraction times out, fails, or there is no network. Offers a
  /// large, simple retry button.
  Widget _buildFailed() {
    return _StatusMessage(
      icon: Icons.cloud_off_rounded,
      title: 'Could not prepare your profile.',
      subtitle: 'Please check your internet and try again.',
      action: BbButton(
        label: 'Try again',
        iconLeft: Icons.refresh_rounded,
        onPressed: _extract,
      ),
    );
  }

  Widget _buildProfile() {
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s6),
      children: <Widget>[
        Text('Draft profile (placeholder data):',
            style: AppTypography.body(color: AppColors.textSecondary)),
        const SizedBox(height: AppSpacing.s4),
        const _ProfileRow(
            icon: Icons.badge_outlined, label: 'Role', value: 'VMC Operator'),
        const SizedBox(height: AppSpacing.s3),
        const _ProfileRow(
            icon: Icons.timeline_outlined,
            label: 'Experience',
            value: '5 years'),
        const SizedBox(height: AppSpacing.s3),
        const _ProfileRow(
            icon: Icons.precision_manufacturing_outlined,
            label: 'Machines',
            value: 'VMC, CNC Lathe'),
      ],
    );
  }
}

/// One labelled profile attribute card with a warm saffron icon chip.
class _ProfileRow extends StatelessWidget {
  const _ProfileRow({
    required this.icon,
    required this.label,
    required this.value,
  });

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.s4),
        child: Row(
          children: <Widget>[
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: AppColors.saffron50,
                borderRadius: BorderRadius.circular(AppRadii.sm),
              ),
              child: Icon(icon, color: AppColors.saffronDeep, size: 24),
            ),
            const SizedBox(width: AppSpacing.s4),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(label, style: AppTypography.eyebrow()),
                const SizedBox(height: 2),
                Text(value,
                    style: AppTypography.body(
                        size: AppTypography.sizeMd, weight: FontWeight.w600)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Centered icon + title + subtitle + action — the shared empty/error layout.
class _StatusMessage extends StatelessWidget {
  const _StatusMessage({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.action,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final Widget action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(icon, size: 48, color: AppColors.textMuted),
          const SizedBox(height: AppSpacing.s4),
          Text(title,
              textAlign: TextAlign.center,
              style: AppTypography.display(size: AppTypography.sizeMd)),
          const SizedBox(height: AppSpacing.s2),
          Text(subtitle,
              textAlign: TextAlign.center,
              style: AppTypography.body(color: AppColors.textSecondary)),
          const SizedBox(height: AppSpacing.s6),
          action,
        ],
      ),
    );
  }
}
