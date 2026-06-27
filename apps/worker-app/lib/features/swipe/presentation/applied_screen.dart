import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_job_card.dart';
import '../../../core/widgets/bb_list_row.dart';
import '../../../core/widgets/bb_success_stamp.dart';
import '../../../router.dart';

/// Application-confirmed screen (spec §5.8). A one-shot confirmation — there is
/// no persistent Applied tab. The applied job's display fields arrive as the
/// route `extra` (a [BbJobCardData]); everything here is presentation only.
class AppliedScreen extends StatelessWidget {
  const AppliedScreen({super.key, this.job});

  final BbJobCardData? job;

  @override
  Widget build(BuildContext context) {
    final String company = job?.company ?? 'The employer';
    final String title = job?.title ?? 'this job';

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: ListView(
          children: <Widget>[
            // Hero
            Padding(
              padding: const EdgeInsets.fromLTRB(AppSpacing.gutter,
                  AppSpacing.s8, AppSpacing.gutter, AppSpacing.s6),
              child: Column(
                children: <Widget>[
                  const BbSuccessStamp(),
                  const SizedBox(height: AppSpacing.s4),
                  Text('Apply ho gaya!',
                      textAlign: TextAlign.center,
                      style: AppTypography.display(
                          size: AppTypography.size2xl,
                          weight: FontWeight.w800)),
                  const SizedBox(height: AppSpacing.s2),
                  Text(
                    '$company ko aapka profile bhej diya. '
                    'Reply aane par hum aapko batayenge.',
                    textAlign: TextAlign.center,
                    style:
                        AppTypography.body(color: AppColors.textSecondary),
                  ),
                ],
              ),
            ),
            // Status timeline
            Padding(
              padding:
                  const EdgeInsets.symmetric(horizontal: AppSpacing.gutter),
              child: Container(
                decoration: BoxDecoration(
                  color: AppColors.surfaceCard,
                  borderRadius: BorderRadius.circular(AppRadii.lg),
                  border: Border.all(color: AppColors.borderSubtle),
                ),
                child: Column(
                  children: <Widget>[
                    BbListRow.status(
                      icon: Icons.send,
                      green: true,
                      label: 'Applied',
                      state: 'Abhi · $title',
                    ),
                    const Divider(height: 1, color: AppColors.divider),
                    // The viewed/reply signal is a deferred Phase-2 feature —
                    // rendered as a static "Pending" placeholder for now.
                    BbListRow.status(
                      icon: Icons.visibility_outlined,
                      green: false,
                      label: 'Employer ne dekha',
                      state: 'Pending',
                    ),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(AppSpacing.gutter),
              child: BbButton(
                label: 'Aur jobs dekhein',
                block: true,
                iconRight: Icons.arrow_forward_rounded,
                onPressed: () =>
                    context.canPop() ? context.pop() : context.go(Routes.jobs),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
