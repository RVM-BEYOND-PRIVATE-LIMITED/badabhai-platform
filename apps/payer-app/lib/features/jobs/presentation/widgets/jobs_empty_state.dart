import 'package:flutter/material.dart';

import '../../../../core/theme/app_spacing.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_status_view.dart';

/// Empty My-jobs copy (#2594) — a new account sees what the tab is for and
/// the one next step, never a blank list.
const String kJobsEmptyTitle = 'No jobs yet';
const String kJobsEmptyMessage =
    'Post your first job. Workers who match it can see it and apply.';
const String kJobsEmptyCta = 'Post a job';

/// My jobs with nothing posted: the shared [BbStatusView] layout with the
/// haldi Post CTA — the screen's ONE primary action, since the list header
/// (and its own Post button) is not drawn — plus an optional [footer] (the
/// company's AI create path). Centred, and scrolls when it does not fit.
class JobsEmptyState extends StatelessWidget {
  const JobsEmptyState({super.key, required this.onPost, this.footer});

  final VoidCallback onPost;
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        return SingleChildScrollView(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              minHeight:
                  constraints.hasBoundedHeight ? constraints.maxHeight : 0,
            ),
            child: BbStatusView(
              icon: Icons.work_rounded,
              title: kJobsEmptyTitle,
              subtitle: kJobsEmptyMessage,
              action: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  BbButton(
                    label: kJobsEmptyCta,
                    iconLeft: Icons.add_rounded,
                    onPressed: onPost,
                  ),
                  if (footer != null) ...<Widget>[
                    const SizedBox(height: AppSpacing.s3),
                    footer!,
                  ],
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
