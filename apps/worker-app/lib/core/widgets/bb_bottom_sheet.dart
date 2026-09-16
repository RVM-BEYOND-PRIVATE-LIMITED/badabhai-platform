import 'package:flutter/material.dart';

import '../theme/app_spacing.dart';
import '../theme/onboarding_theme.dart';
import 'kit/kit_content_column.dart';

/// Shows the BadaBhai modal bottom sheet: a white sheet with 16dp top corners
/// over the navy scrim, a centred grip, safe-area padding, and a max height of
/// 80% of the screen.
///
/// Pass a [builder] for the sheet body; it is wrapped in a [Flexible] so it
/// scrolls/shrinks within the capped height. Returns whatever the sheet is
/// popped with.
///
/// Pass [footer] for actions that must stay on screen whatever the body does:
/// the body scrolls and shrinks, the footer does not.
///
/// [maxWidth] caps the sheet's CONTENT column, the same way a page body caps —
/// 440 for a form-shaped sheet (the default), 600 for a list-shaped one. On a
/// tablet the shell is full-bleed by design, but a 728dp-wide paragraph and a
/// 728dp-wide CTA inside it were a second sheet grammar in one app: the
/// onboarding picker sheet already caps its own column at 440.
Future<T?> showBbBottomSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  bool isScrollControlled = true,
  double maxWidth = OnboardingLayout.maxContentWidth,
  WidgetBuilder? footer,
}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: isScrollControlled,
    backgroundColor: OnboardingColors.paperWhite,
    barrierColor: OnboardingColors.scrim,
    elevation: 0,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(
        top: Radius.circular(OnboardingRadii.card),
      ),
    ),
    builder: (BuildContext sheetContext) {
      // The 80% cap is read from the SHEET's own context, INSIDE the builder.
      // As `showModalBottomSheet`'s `constraints:` it was computed from the
      // CALLER's MediaQuery at show time and then never re-read, so a rotation
      // or a font-size change left the sheet capped at a height that no longer
      // existed.
      return ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(sheetContext).height * 0.8,
        ),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.gutter,
              AppSpacing.s3,
              AppSpacing.gutter,
              AppSpacing.gutter,
            ),
            child: KitContentColumn(
              maxWidth: maxWidth,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  const BbSheetGrip(),
                  Flexible(child: builder(sheetContext)),
                  // A DOCKED footer: laid out at its natural height first, so
                  // the [builder] body above gives way instead. A sheet whose
                  // actions sat at the end of the scrolling body showed a
                  // half-cut primary CTA and no escape hatch at all on a
                  // 320x568 screen at a 2.0 system font — the worker had to
                  // scroll a sheet they could not tell was scrollable to find
                  // the way out.
                  if (footer != null) footer(sheetContext),
                ],
              ),
            ),
          ),
        ),
      );
    },
  );
}

/// The drag handle for a [showBbBottomSheet] — a 40x4 rounded hairline pill
/// with a bottom gap. Reusable on any hand-built sheet that wants the same
/// affordance.
class BbSheetGrip extends StatelessWidget {
  const BbSheetGrip({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 40,
      height: 4,
      margin: const EdgeInsets.only(bottom: AppSpacing.s3),
      decoration: const BoxDecoration(
        color: OnboardingColors.borderDefault,
        borderRadius: BorderRadius.all(Radius.circular(AppRadii.pill)),
      ),
    );
  }
}
