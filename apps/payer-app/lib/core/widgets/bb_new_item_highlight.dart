import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_motion.dart';
import 'bb_card.dart';

/// "Show me the row I just made" — a ONE-SHOT request a host hands to a list
/// (#2596: Post a job → land on Jobs with the new card highlighted).
///
/// [claim] answers true exactly once, for the first row built with [id]; every
/// later build — a refetch, a scroll back, a revisit of the tab — gets false,
/// so the highlight never replays.
class BbHighlightRequest {
  BbHighlightRequest(this.id);

  /// The id of the row to highlight (a posting id).
  final String id;

  bool _claimed = false;

  /// True once the highlight has been handed to a row.
  bool get claimed => _claimed;

  /// True for the first call whose [rowId] is [id]; false otherwise.
  bool claim(String? rowId) {
    if (_claimed || rowId == null || rowId != id) return false;
    _claimed = true;
    return true;
  }
}

/// Wraps one list row. When mounted [active], it scrolls the row into view and
/// paints its card's surface [AppColors.haldiTint] (the brand's soft yellow,
/// ≈20% of haldi on white), easing back to [AppColors.surfaceCard] over
/// [AppMotion.highlightFade], ease-in.
///
/// Only the SURFACE changes ([BbCardSurfaceTint], read by the row's [BbCard]):
/// every token on the card — text, buttons, badges, the hairline — renders
/// exactly as it always does. No new colour token and no alpha tint.
///
/// Wrap EVERY row (inactive ones cost one element) so the highlighted row keeps
/// its element — and its fade — across rebuilds. [active] is read once, at
/// mount. With animations disabled the scroll jumps and the tint holds for the
/// same time, then goes without a fade: the "this one is new" cue stays, the
/// motion does not.
class BbNewItemHighlight extends StatefulWidget {
  const BbNewItemHighlight({
    super.key,
    required this.active,
    required this.child,
  });

  /// Highlight this row (read at mount only).
  final bool active;

  final Widget child;

  /// The surface scope of an [active] row — for widget tests. It stays in the
  /// tree after the fade (with a null colour), so read its colour.
  @visibleForTesting
  static const Key tintKey = Key('bb_new_item_highlight_tint');

  @override
  State<BbNewItemHighlight> createState() => _BbNewItemHighlightState();
}

class _BbNewItemHighlightState extends State<BbNewItemHighlight>
    with SingleTickerProviderStateMixin {
  late final bool _playing = widget.active;

  // `preserve`: the tint's lifetime is how long the cue stays readable; the
  // platform's animation scaling must not shorten it (the fade itself is gated
  // in [didChangeDependencies]).
  AnimationController? _controller;
  Animation<double>? _fade;
  bool _started = false;

  @override
  void initState() {
    super.initState();
    if (_playing) {
      _controller = AnimationController(
        vsync: this,
        duration: AppMotion.highlightFade,
        animationBehavior: AnimationBehavior.preserve,
      );
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final AnimationController? controller = _controller;
    if (controller == null) return;
    final bool reduced = AppMotion.reduced(context);
    // Exit is ease-in; with animations disabled the tint holds, then cuts.
    _fade = CurvedAnimation(
      parent: controller,
      curve: reduced ? const Threshold(1) : AppMotion.easeIn,
    );
    if (_started) return;
    _started = true;
    controller.forward();
    WidgetsBinding.instance.addPostFrameCallback((_) => _reveal());
  }

  /// Bring the row fully on screen, moving as little as possible.
  void _reveal() {
    if (!mounted) return;
    Scrollable.ensureVisible(
      context,
      duration: AppMotion.resolve(context, AppMotion.page),
      curve: AppMotion.easeOut,
      alignmentPolicy: ScrollPositionAlignmentPolicy.keepVisibleAtEnd,
    );
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Animation<double>? fade = _fade;
    if (!_playing || fade == null) return widget.child;
    // The scope stays in the tree after the fade (null: the card's own white)
    // so the row's subtree is never re-parented — and so never remounted.
    return AnimatedBuilder(
      animation: fade,
      child: widget.child,
      builder: (BuildContext context, Widget? child) => BbCardSurfaceTint(
        key: BbNewItemHighlight.tintKey,
        color: fade.value >= 1
            ? null
            : Color.lerp(AppColors.haldiTint, AppColors.surfaceCard, fade.value),
        child: child!,
      ),
    );
  }
}
