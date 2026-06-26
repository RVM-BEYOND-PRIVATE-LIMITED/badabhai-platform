import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';

/// Shows the BadaBhai modal bottom sheet — the `.aw-sheet*` spec (ui.css
/// 225-232): a rounded cream sheet over the ink scrim, with a centred grip,
/// safe-area padding, and a max height of 80% of the screen.
///
/// Pass a [builder] for the sheet body; it is wrapped in a [Flexible] so it
/// scrolls/shrinks within the capped height. Returns whatever the sheet is
/// popped with.
Future<T?> showBbBottomSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  bool isScrollControlled = true,
}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: isScrollControlled,
    backgroundColor: AppColors.surfaceCard,
    barrierColor: AppColors.scrim,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadii.xxl)),
    ),
    constraints: BoxConstraints(
      maxHeight: MediaQuery.of(context).size.height * 0.8,
    ),
    builder: (BuildContext sheetContext) {
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s3,
            AppSpacing.gutter,
            AppSpacing.gutter,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const BbSheetGrip(),
              Flexible(child: builder(sheetContext)),
            ],
          ),
        ),
      );
    },
  );
}

/// The drag handle for a [showBbBottomSheet] — a 40x4 rounded ink pill with a
/// bottom gap, per the `.aw-sheet` grip in the design system. Reusable on any
/// hand-built sheet that wants the same affordance.
class BbSheetGrip extends StatelessWidget {
  const BbSheetGrip({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 40,
      height: 4,
      margin: const EdgeInsets.only(bottom: AppSpacing.s3),
      decoration: const BoxDecoration(
        color: AppColors.borderStrong,
        borderRadius: BorderRadius.all(Radius.circular(AppRadii.pill)),
      ),
    );
  }
}
