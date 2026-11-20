import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure_reason.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/bb_palette.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../domain/still_looking_repository.dart';
import '../cubit/still_looking_cubit.dart';

/// The inactivity banner's one line and its one action (#2748 item 5).
const String kStillLookingInactiveBannerText =
    'Kaafi din se active nahi dikhe. Abhi bhi kaam dhoondh rahe hain?';
const String kStillLookingInactiveBannerAction = 'Haan, dhoondh raha hoon';

/// Test handle.
const Key kStillLookingBannerKey = ValueKey<String>('still-looking-banner');
const Key kStillLookingRetryKey = ValueKey<String>('still-looking-retry');

/// Shown when the server could not be read (`503` or a transport failure).
const String kStillLookingRetryText =
    'Abhi jaankari nahi mil paayi. Thodi der baad dobara koshish karein.';
const String kStillLookingRetryAction = 'Dobara koshish karein';

/// The "not recently active" banner (#2748 item 5 / #2753 item 4).
///
/// It is a MARK, not a filter: nothing is hidden or re-sorted. It shows only
/// while the server says [StillLookingState.notRecentlyActive] and no monthly
/// check is due (the monthly card takes precedence). One tap answers `yes`,
/// which moves his last active day to today and clears the mark.
///
/// Hidden entirely while the switch is off (`404`) and while the first read is
/// in flight; a `503` leaves nothing to show, so no broken control appears.
class StillLookingInactiveBanner extends StatelessWidget {
  const StillLookingInactiveBanner({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<StillLookingCubit, StillLookingState>(
      // ONLY a write failure is surfaced here. A failed READ (a 503, a partial
      // test graph) must stay silent — the banner simply does not render.
      listenWhen: (StillLookingState prev, StillLookingState curr) =>
          prev.saving && !curr.saving && curr.failure != null,
      listener: (BuildContext context, StillLookingState state) {
        final String reason = failureReason(state.failure).reason;
        ScaffoldMessenger.of(context)
          ..clearSnackBars()
          ..showSnackBar(SnackBar(content: Text(reason)));
      },
      builder: (BuildContext context, StillLookingState state) {
        if (state.status == StillLookingStatus.failed) {
          return _RetryStrip(cubit: context.read<StillLookingCubit>());
        }
        if (state.status != StillLookingStatus.ready) {
          return const SizedBox.shrink();
        }
        if (state.due || !state.notRecentlyActive) {
          return const SizedBox.shrink();
        }
        final BbPalette p = context.bb;
        final StillLookingCubit cubit = context.read<StillLookingCubit>();
        return Semantics(
          container: true,
          child: Container(
            key: kStillLookingBannerKey,
            width: double.infinity,
            color: p.brandSurface,
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.gutter,
              AppSpacing.s2,
              AppSpacing.gutter,
              AppSpacing.s2,
            ),
            // STACKED, not one Row: the sentence and the CTA together exceed a
            // 360dp phone's width at a large system font. Text first, then the
            // action beneath it, so neither is ever clipped.
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Icon(
                      Icons.schedule_rounded,
                      size: 22,
                      color: p.onBrandSurface,
                    ),
                    const SizedBox(width: AppSpacing.s2),
                    Expanded(
                      child: Text(
                        kStillLookingInactiveBannerText,
                        style: OnboardingTypography.inter(
                          size: 13,
                          weight: FontWeight.w600,
                          color: p.onBrandSurface,
                          height: 1.3,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.s2),
                BbButton(
                  label: kStillLookingInactiveBannerAction,
                  variant: BbButtonVariant.tonal,
                  size: BbButtonSize.sm,
                  loading: state.saving,
                  onPressed: state.saving
                      ? null
                      : () => cubit.answer(StillLookingAnswer.yes),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

/// The retry strip shown while the monthly check's read is failing (`503` or a
/// transport failure). A `404` (switch off) never reaches this: the cubit maps
/// it to [StillLookingStatus.hidden], so a switched-off feature still renders
/// exactly nothing.
class _RetryStrip extends StatelessWidget {
  const _RetryStrip({required this.cubit});

  final StillLookingCubit cubit;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    return Container(
      key: kStillLookingRetryKey,
      width: double.infinity,
      color: p.brandSurface,
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s2,
        AppSpacing.gutter,
        AppSpacing.s2,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Icon(Icons.schedule_rounded, size: 22, color: p.onBrandSurface),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: Text(
                  kStillLookingRetryText,
                  style: OnboardingTypography.inter(
                    size: 13,
                    weight: FontWeight.w600,
                    color: p.onBrandSurface,
                    height: 1.3,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.s2),
          BbButton(
            label: kStillLookingRetryAction,
            variant: BbButtonVariant.tonal,
            size: BbButtonSize.sm,
            onPressed: () => cubit.load(),
          ),
        ],
      ),
    );
  }
}
