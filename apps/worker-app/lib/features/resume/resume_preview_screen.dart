import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/theme/app_typography.dart';
import '../../core/widgets/bb_app_bar.dart';
import '../../core/widgets/bb_button.dart';
import '../../core/widgets/bb_festive_card.dart';
import '../../core/widgets/bb_scaffold.dart';
import '../../router.dart';

class ResumePreviewScreen extends StatefulWidget {
  const ResumePreviewScreen({super.key});

  @override
  State<ResumePreviewScreen> createState() => _ResumePreviewScreenState();
}

class _ResumePreviewScreenState extends State<ResumePreviewScreen> {
  final ApiClient _api = createApiClient();
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
    final ResumeResult result =
        await _api.generateResume(workerId: workerId, profileId: profileId);
    AppState.instance.setResume(result.resumeId);
    if (!mounted) return;
    setState(() {
      _resume = result.resumeText;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return BbScaffold(
      appBar: const BbAppBar(title: 'Your resume'),
      bottomBar: _loading
          ? null
          : Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                BbButton(
                  label: 'See jobs for you',
                  block: true,
                  iconLeft: Icons.work_outline_rounded,
                  onPressed: () =>
                      Navigator.pushNamed(context, Routes.swipeJobs),
                ),
                const SizedBox(height: AppSpacing.s3),
                BbButton(
                  label: 'Done',
                  block: true,
                  variant: BbButtonVariant.ghost,
                  onPressed: () => Navigator.pushNamedAndRemoveUntil(
                    context,
                    Routes.splash,
                    (Route<dynamic> route) => false,
                  ),
                ),
              ],
            ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.s6),
              children: <Widget>[
                _buildHeader(),
                const SizedBox(height: AppSpacing.s5),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(AppSpacing.s4),
                    child: Text(
                      _resume,
                      style: AppTypography.body(size: AppTypography.sizeMd),
                    ),
                  ),
                ),
              ],
            ),
    );
  }

  /// Celebratory festive header — the "stamp" moment when the resume is ready.
  Widget _buildHeader() {
    return BbFestiveCard(
      child: Row(
        children: <Widget>[
          Container(
            width: 52,
            height: 52,
            decoration: BoxDecoration(
              color: AppColors.saffron50,
              borderRadius: BorderRadius.circular(AppRadii.md),
            ),
            child: const Icon(Icons.description_rounded,
                color: AppColors.saffronDeep, size: 28),
          ),
          const SizedBox(width: AppSpacing.s4),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('Resume ready! 👍',
                    style: AppTypography.display(size: AppTypography.sizeLg)),
                const SizedBox(height: 2),
                Text(
                  'Free, and yours to share.',
                  style: AppTypography.body(color: AppColors.textSecondary),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
