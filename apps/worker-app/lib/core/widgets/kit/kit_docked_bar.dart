import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';
import '../bottom_bar_inset.dart';
import 'kit_content_column.dart';

/// The white docked bar that holds a screen's one committing action — save,
/// send, log out everywhere (spec §2.2's shell, without the questionnaire's
/// listen tile).
///
/// It publishes its measured height to [bottomBarInset], so the app-wide
/// Feedback pill — which lives above the router's Navigator and cannot see this
/// page's bar — floats clear of it instead of sitting on top of the CTA.
class KitDockedBar extends StatefulWidget {
  const KitDockedBar({
    super.key,
    this.maxWidth = OnboardingLayout.maxContentWidth,
    required this.child,
  });

  /// 440 for a form or auth screen, 600 for tab content.
  final double maxWidth;
  final Widget child;

  @override
  State<KitDockedBar> createState() => _KitDockedBarState();
}

class _KitDockedBarState extends State<KitDockedBar> {
  final GlobalKey _barKey = GlobalKey();

  /// What this bar last published, so dispose only clears the inset when it is
  /// still OURS — a pushed route's bar that published after us must not be
  /// reset to 0 by our teardown.
  double _published = 0;

  @override
  void initState() {
    super.initState();
    _publish();
  }

  @override
  void didUpdateWidget(KitDockedBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    _publish();
  }

  @override
  void dispose() {
    final double mine = _published;
    // Deferred: dispose runs during tree finalization, and writing a listened
    // notifier synchronously here would markNeedsBuild the FAB overlay
    // mid-build. The closure touches only the global notifier.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (bottomBarInset.value == mine) bottomBarInset.value = 0;
    });
    super.dispose();
  }

  void _publish() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final double height = _barKey.currentContext?.size?.height ?? 0;
      _published = height;
      bottomBarInset.value = height;
    });
  }

  @override
  Widget build(BuildContext context) {
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: Container(
        key: _barKey,
        padding: EdgeInsets.only(
          left: 16,
          right: 16,
          top: 10,
          bottom: MediaQuery.paddingOf(context).bottom + 10,
        ),
        decoration: const BoxDecoration(
          color: OnboardingColors.paperWhite,
          border: Border(
            top: BorderSide(color: OnboardingColors.borderDefault),
          ),
        ),
        child: KitContentColumn(maxWidth: widget.maxWidth, child: widget.child),
      ),
    );
  }
}
