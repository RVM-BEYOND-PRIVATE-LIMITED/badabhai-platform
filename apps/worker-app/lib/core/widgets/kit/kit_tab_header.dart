import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme/onboarding_theme.dart';
import 'kit_content_column.dart';

/// The navy header of a TAB ROOT — Jobs, Resume, Profile (spec §4): a yellow
/// rule, the title, and the tab's action glyphs.
///
/// It is not an [AppBar] and not a [ShiftBlueHeader]: a tab root has no back
/// arrow and no brand badge (the worker is home, not mid-flow), so this is the
/// third and last header variant. Pushed routes use [ShiftBlueHeader].
///
/// GEOMETRY. Left padding is the 16dp gutter; RIGHT padding is 3, because each
/// action is a 48dp hit box around a ~22dp glyph — that puts the last glyph's
/// painted edge 16dp from the screen edge, matching the artboard, while the tap
/// area stays legal. The row is [OnboardingLayout.tabHeaderRowHeight] tall for
/// the same reason.
///
/// Chrome clamps text scaling at [OnboardingLayout.chromeMaxTextScale]: a
/// header that grew to 200% would eat a third of a 568dp screen before the
/// worker saw any content. Body copy is never clamped — it scrolls.
class KitTabHeader extends StatelessWidget {
  const KitTabHeader({
    super.key,
    required this.title,
    this.actions = const <Widget>[],
  });

  final String title;

  /// Trailing glyphs, each already a 48dp hit box — see [KitHeaderIconAction]
  /// and [KitFeedbackAction].
  final List<Widget> actions;

  /// The height of the title / action row, so a caller can reason about its
  /// own layout without re-deriving it.
  static const double rowHeight = OnboardingLayout.tabHeaderRowHeight;

  @override
  Widget build(BuildContext context) {
    final double top = MediaQuery.paddingOf(context).top;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: MediaQuery.withClampedTextScaling(
        maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
        child: Container(
          width: double.infinity,
          color: OnboardingColors.shiftBlue,
          padding: EdgeInsets.only(top: top, left: 16, right: 3),
          child: KitContentColumn(
            // minHeight, not a fixed height: the title is allowed a second
            // line (see below) and the row grows for it rather than slicing it.
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: rowHeight),
              child: Row(
                children: <Widget>[
                  Container(
                    width: 4,
                    height: 18,
                    decoration: BoxDecoration(
                      color: OnboardingColors.safetyYellow,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                  const SizedBox(width: 8),
                  // `Expanded`, and NO `Spacer()` after it. A `Spacer` IS an
                  // `Expanded(flex: 1)`, so it competed with a `Flexible(flex:
                  // 1)` title for the free space and took half of it whatever
                  // the title needed — 'Kaam milega.' asked for 240dp, was
                  // handed 107 and rendered 'Kaam mil…' on a 390dp phone.
                  // Expanded alone takes what the actions do not, which also
                  // puts the actions ON the content column's right edge
                  // instead of 47-179dp short of it.
                  Expanded(
                    child: Text(
                      title,
                      // TWO lines, not one. With three 48dp actions a 320dp
                      // screen leaves the title 137dp, and at the 1.3 chrome
                      // clamp none of the real tab titles fits one line of
                      // that — 'Kaam milega.' rendered as 'Kaa…'. Two lines of
                      // 137 hold every one of them, so the row grows by 32dp
                      // on the one surface that needs it instead of slicing
                      // the page's name to three characters.
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: OnboardingTypography.anek(
                        size: 20,
                        weight: FontWeight.w800,
                        height: 1.25,
                        color: OnboardingColors.textOnBlue,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  ...actions,
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
