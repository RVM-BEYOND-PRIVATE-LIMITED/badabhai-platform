import 'package:flutter/material.dart';

import '../../../../core/data/models.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/theme/bb_palette.dart';
import '../../../../core/widgets/bb_chip.dart';

/// #2746 — the audience picker + RVM branch/course multi-selects for a COMPANY
/// posting. Rendered only when `GET /payer/job-postings/audience-options`
/// answered 200; a neutral 404 (the switch is off) hides it entirely, so the
/// form stays exactly what it was before.
///
/// Empty branch/course selections mean ALL (`[]` on the wire). Presentation
/// only: the screen owns the state and sends it on create/PATCH.
class PostingAudienceFields extends StatelessWidget {
  const PostingAudienceFields({
    super.key,
    required this.options,
    required this.audience,
    required this.branchIds,
    required this.courseIds,
    required this.onChanged,
    this.review,
  });

  final AudienceOptions options;
  final JobAudience audience;
  final Set<int> branchIds;
  final Set<String> courseIds;
  final void Function(JobAudience audience, Set<int> branchIds, Set<String> courseIds)
      onChanged;

  /// The stored review when editing a posting with an RVM part.
  final RvmReview? review;

  void _pickAudience(JobAudience next) {
    onChanged(
      next,
      next.hasRvm ? branchIds : <int>{},
      next.hasRvm ? courseIds : <String>{},
    );
  }

  void _toggleBranch(int id) {
    final Set<int> next = <int>{...branchIds};
    if (!next.remove(id)) next.add(id);
    onChanged(audience, next, courseIds);
  }

  void _toggleCourse(String id) {
    final Set<String> next = <String>{...courseIds};
    if (!next.remove(id)) next.add(id);
    onChanged(audience, branchIds, next);
  }

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          'Who sees this job',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        Wrap(
          spacing: AppSpacing.s2,
          runSpacing: AppSpacing.s2,
          children: <Widget>[
            for (final JobAudience option in options.audiences)
              BbChip(
                label: option.label,
                selected: audience == option,
                onTap: () => _pickAudience(option),
              ),
          ],
        ),
        if (audience.hasRvm) ...<Widget>[
          const SizedBox(height: AppSpacing.s2),
          Text(
            'RVM students see this posting only after RVM’s placement team '
            'approves it.',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: p.textMuted,
              height: 1.4,
            ),
          ),
          if (options.branches.isNotEmpty) ...<Widget>[
            const SizedBox(height: AppSpacing.s4),
            Text(
              'Branches',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                weight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: AppSpacing.s1),
            Text(
              'Leave all unticked to target every branch.',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: p.textMuted,
                height: 1.4,
              ),
            ),
            const SizedBox(height: AppSpacing.s2),
            Wrap(
              spacing: AppSpacing.s2,
              runSpacing: AppSpacing.s2,
              children: <Widget>[
                for (final AudienceBranchOption branch in options.branches)
                  BbChip(
                    label: branch.label,
                    selected: branchIds.contains(branch.id),
                    onTap: () => _toggleBranch(branch.id),
                  ),
              ],
            ),
          ],
          if (options.courses.isNotEmpty) ...<Widget>[
            const SizedBox(height: AppSpacing.s4),
            Text(
              'Courses',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                weight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: AppSpacing.s1),
            Text(
              'Leave all unticked to target every course.',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: p.textMuted,
                height: 1.4,
              ),
            ),
            const SizedBox(height: AppSpacing.s2),
            Wrap(
              spacing: AppSpacing.s2,
              runSpacing: AppSpacing.s2,
              children: <Widget>[
                for (final AudienceCourseOption course in options.courses)
                  BbChip(
                    label: course.label,
                    selected: courseIds.contains(course.id),
                    onTap: () => _toggleCourse(course.id),
                  ),
              ],
            ),
          ],
          if (review?.state == 'approved') ...<Widget>[
            const SizedBox(height: AppSpacing.s4),
            Container(
              padding: const EdgeInsets.all(AppSpacing.s3),
              decoration: BoxDecoration(
                color: p.warningBg,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: p.warning),
              ),
              child: Text(
                'RVM approved this posting. Saving a change to anything '
                'students see — title, description, requirements, benefits, '
                'pay, location, shift, experience, openings, audience or '
                'targeting — sends it back to pending.',
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  color: p.textPrimary,
                  height: 1.45,
                ),
              ),
            ),
          ],
        ],
      ],
    );
  }
}

/// #2746 — the review state + the placement team's note, rendered as PLAIN
/// TEXT (a Flutter [Text] never renders markdown or auto-links).
class RvmReviewNote extends StatelessWidget {
  const RvmReviewNote({super.key, required this.review});

  final RvmReview review;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.s3),
      decoration: BoxDecoration(
        color: p.inset,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            'RVM review: ${review.label}',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              weight: FontWeight.w700,
              color: p.textPrimary,
            ),
          ),
          if (review.reason != null && review.reason!.isNotEmpty) ...<Widget>[
            const SizedBox(height: AppSpacing.s1),
            Text(
              review.reason!,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: p.textMuted,
                height: 1.45,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
