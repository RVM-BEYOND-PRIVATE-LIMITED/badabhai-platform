import 'package:flutter/foundation.dart' show ValueListenable;
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
///
/// Pass [dismissible] to hold the sheet open while it reads `false` (a save in
/// flight, say): system back, a tap on the scrim and a swipe down then all
/// leave it where it is, and only the sheet itself can close it. Null (the
/// default) keeps the sheet dismissible the whole time.
Future<T?> showBbBottomSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  bool isScrollControlled = true,
  double maxWidth = OnboardingLayout.maxContentWidth,
  WidgetBuilder? footer,
  ValueListenable<bool>? dismissible,
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
      final Widget sheet = ConstrainedBox(
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
      if (dismissible == null) return sheet;
      return _BbSheetHold(dismissible: dismissible, child: sheet);
    },
  );
}

/// Holds a [showBbBottomSheet] open while [dismissible] reads `false`.
///
/// System back and a scrim tap ask the route to MAYBE pop, which the
/// [PopScope] refuses. A swipe down is different: the modal sheet pops its
/// route outright, past any [PopScope], so while the sheet is held a vertical
/// drag anywhere on it is claimed here first and never reaches the sheet's own
/// drag handler. The detector is always in the tree and only armed while held,
/// so the sheet's content keeps its state when the hold changes.
class _BbSheetHold extends StatelessWidget {
  const _BbSheetHold({required this.dismissible, required this.child});

  final ValueListenable<bool> dismissible;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: dismissible,
      child: child,
      builder: (BuildContext context, bool canDismiss, Widget? sheet) {
        return PopScope(
          canPop: canDismiss,
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            excludeFromSemantics: true,
            onVerticalDragStart: canDismiss ? null : (_) {},
            child: sheet,
          ),
        );
      },
    );
  }
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
