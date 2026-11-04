import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_motion.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';

/// The two views of the Find tab (owner rulings 2026-11-03).
enum FindView {
  /// Every eligible worker on the portal (ADR-0040 E2). The DEFAULT view, for
  /// company and agency sessions alike.
  allCandidates,

  /// The per-job applicant feed — today's flow, unchanged, job chips included.
  applicants,
}

/// Find's segmented control: "All candidates" | "Applicants".
///
/// Structural navigation, so the selected segment is deep blue (the bottom
/// nav's active colour), never haldi: haldi is the unlock CTA on every card
/// below, and a second haldi block would compete with it. Each segment clears
/// the 48px tap floor and is announced as a selectable button.
///
/// #2593 — the blue THUMB slides between the two halves ([AppMotion.tab],
/// [AppMotion.emphasized]; transform only, zero under reduced motion) instead
/// of the selection jumping. The labels swap colour at once, as the bottom
/// nav's do under its sliding indicator.
class FindViewSwitch extends StatelessWidget {
  const FindViewSwitch({
    super.key,
    required this.selected,
    required this.onChanged,
  });

  final FindView selected;
  final ValueChanged<FindView> onChanged;

  /// Key of the sliding thumb (for widget tests).
  @visibleForTesting
  static const Key thumbKey = Key('find_view_thumb');

  @override
  Widget build(BuildContext context) {
    final bool rtl = Directionality.of(context) == TextDirection.rtl;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.s1),
      decoration: BoxDecoration(
        color: AppColors.surfaceSunken,
        borderRadius: BorderRadius.circular(AppRadii.xl),
        border: Border.all(color: AppColors.border),
      ),
      child: Stack(
        children: <Widget>[
          // Half the track, translated by whole halves — never a relayout.
          Positioned.fill(
            child: FractionallySizedBox(
              alignment: AlignmentDirectional.centerStart,
              widthFactor: 1 / FindView.values.length,
              child: AnimatedSlide(
                key: thumbKey,
                offset: Offset((rtl ? -1 : 1) * selected.index.toDouble(), 0),
                duration: AppMotion.resolve(context, AppMotion.tab),
                curve: AppMotion.emphasized,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: AppColors.blue,
                    borderRadius: BorderRadius.circular(AppRadii.md),
                  ),
                ),
              ),
            ),
          ),
          Row(
            children: <Widget>[
              Expanded(
                child: _Segment(
                  key: const Key('find_view_all'),
                  label: 'All candidates',
                  icon: Icons.groups_rounded,
                  selected: selected == FindView.allCandidates,
                  onTap: () => onChanged(FindView.allCandidates),
                ),
              ),
              Expanded(
                child: _Segment(
                  key: const Key('find_view_applicants'),
                  label: 'Applicants',
                  icon: Icons.assignment_ind_rounded,
                  selected: selected == FindView.applicants,
                  onTap: () => onChanged(FindView.applicants),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Segment extends StatelessWidget {
  const _Segment({
    super.key,
    required this.label,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final Color foreground = selected ? AppColors.onBlue : AppColors.textSecondary;
    return Semantics(
      button: true,
      selected: selected,
      // Transparent: the thumb behind the row is the selected fill.
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(AppRadii.md),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppRadii.md),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: AppSpacing.tap),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s2),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  Icon(icon, size: 18, color: foreground),
                  const SizedBox(width: AppSpacing.gap6),
                  Flexible(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        weight: FontWeight.w700,
                        color: foreground,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
