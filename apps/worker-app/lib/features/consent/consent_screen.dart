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
    return BbScaffold(
      appBar: const BbAppBar(title: 'Consent'),
      bottomBar: BbButton(
        label: _loading ? 'Saving…' : 'Continue',
        block: true,
        loading: _loading,
        iconRight: Icons.arrow_forward_rounded,
        onPressed: (_accepted && !_loading) ? _continue : null,
      ),
      body: ListView(
        padding: const EdgeInsets.only(top: AppSpacing.s6),
        children: <Widget>[
          Container(
            width: 56,
            height: 56,
            decoration: BoxDecoration(
              color: AppColors.successTint,
              borderRadius: BorderRadius.circular(AppRadii.md),
            ),
            child: const Icon(Icons.verified_user_outlined,
                color: AppColors.success, size: 30),
          ),
          const SizedBox(height: AppSpacing.s4),
          Text('Your privacy',
              style: AppTypography.display(size: AppTypography.sizeXl)),
          const SizedBox(height: AppSpacing.s3),
          Text(
            'We use your answers only to build your work profile and resume. '
            '(DPDP consent copy is a Phase 1 placeholder.)',
            style: AppTypography.body(
              size: AppTypography.sizeMd,
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: AppSpacing.s5),
          InkWell(
            onTap: () => setState(() => _accepted = !_accepted),
            borderRadius: BorderRadius.circular(AppRadii.md),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.s1),
              child: Row(
                children: <Widget>[
                  Checkbox(
                    value: _accepted,
                    onChanged: (bool? v) =>
                        setState(() => _accepted = v ?? false),
                  ),
                  const SizedBox(width: AppSpacing.s2),
                  Text('I agree',
                      style: AppTypography.body(size: AppTypography.sizeMd)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
