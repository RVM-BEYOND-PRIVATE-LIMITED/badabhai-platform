import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_motion.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_job_card.dart';

/// One swipeable card: a stable [id] (used for the widget key + the detail
/// route) plus the rendered [data].
class JobDeckItem {
  const JobDeckItem({required this.id, required this.data});

  final String id;
  final BbJobCardData data;
}

/// The signature swipe-to-apply card deck (spec §6 + `.aw-deck` / `.aw-job`).
///
/// Finger-tracks the front card with a small tilt, slides the next real card up
/// from behind as the drag grows, deepens a drag-direction side-band tint (green
/// = apply, red = skip), and on release commits (off-screen fly-out) when the
/// drag passes a fraction of the screen width OR a fling-velocity threshold —
/// otherwise it springs back. The
/// two big buttons drive the SAME commit animation: for low-literacy workers the
/// buttons are the primary affordance and swipe is the enhancement.
class JobDeck extends StatefulWidget {
  const JobDeck({
    super.key,
    required this.cards,
    required this.onApply,
    required this.onSkip,
    this.onTitleTap,
    this.deciding = false,
  });

  /// The visible queue; the head (index 0) is the draggable front card.
  final List<JobDeckItem> cards;

  /// Fired once the front card has committed to the right (apply).
  final VoidCallback onApply;

  /// Fired once the front card has committed to the left (skip).
  final VoidCallback onSkip;

  /// Tapping the front card's title (opens the detail route).
  final ValueChanged<String>? onTitleTap;

  /// While a decision is in flight the deck is locked (mirrors bloc state).
  final bool deciding;

  @override
  State<JobDeck> createState() => _JobDeckState();
}

class _JobDeckState extends State<JobDeck> with SingleTickerProviderStateMixin {
  // Commit when the drag passes this fraction of screen width, OR when the fling
  // velocity passes [_flingVelocity] px/s. Tilt maxes at [_maxAngle] radians.
  static const double _commitFraction = 0.30;
  static const double _flingVelocity = 800;
  static const double _maxAngle = 0.12;

  // How far (px) the behind card peeks below the front card at rest; it slides
  // up to 0 as the front card is dragged away.
  static const double _behindPeek = 14;

  // Peak opacity of the drag-direction side-band tint (right=apply, left=skip).
  static const double _bandMaxAlpha = 0.6;

  late final AnimationController _release;
  Animation<Offset>? _releaseAnim;
  Offset _drag = Offset.zero;
  int _committing = 0; // 0 = settling, 1 = apply (right), -1 = skip (left)

  @override
  void initState() {
    super.initState();
    _release = AnimationController(vsync: this, duration: AppMotion.base)
      ..addListener(() {
        final Animation<Offset>? a = _releaseAnim;
        if (a != null) setState(() => _drag = a.value);
      })
      ..addStatusListener((AnimationStatus s) {
        if (s == AnimationStatus.completed) _onReleaseDone();
      });
  }

  @override
  void dispose() {
    _release.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(JobDeck oldWidget) {
    super.didUpdateWidget(oldWidget);
    final String? newHead = widget.cards.isEmpty ? null : widget.cards.first.id;
    final String? oldHead =
        oldWidget.cards.isEmpty ? null : oldWidget.cards.first.id;

    if (widget.cards.isEmpty) {
      // Queue drained / refreshed away mid-flight: stop without re-firing.
      if (_release.isAnimating) _release.stop();
      _committing = 0;
      _releaseAnim = null;
      _drag = Offset.zero;
      return;
    }
    if (newHead != oldHead) {
      // The committed card was accepted and the queue advanced — show the new
      // head from rest.
      _committing = 0;
      _releaseAnim = null;
      _drag = Offset.zero;
      return;
    }
    // Head unchanged: a commit that just failed (deciding fell back to false)
    // springs the off-screen card back into view and unlocks.
    if (_committing != 0 && oldWidget.deciding && !widget.deciding) {
      _snapBack();
    }
  }

  // Locked for the whole in-flight commit — not just the animation — so a fast
  // second tap cannot double-commit (or double-navigate) the same card.
  bool get _locked =>
      widget.deciding || _release.isAnimating || _committing != 0;

  void _onPanUpdate(DragUpdateDetails d) {
    if (_locked) return;
    // Horizontal is 1:1; vertical only loosely follows the finger.
    setState(() => _drag += Offset(d.delta.dx, d.delta.dy * 0.2));
  }

  void _onPanEnd(DragEndDetails d, double width) {
    if (_locked) return;
    final double vx = d.velocity.pixelsPerSecond.dx;
    if (_drag.dx > _commitFraction * width || vx > _flingVelocity) {
      _flyOff(1, width);
    } else if (_drag.dx < -_commitFraction * width || vx < -_flingVelocity) {
      _flyOff(-1, width);
    } else {
      _snapBack();
    }
  }

  void _snapBack() {
    _committing = 0;
    _releaseAnim = Tween<Offset>(begin: _drag, end: Offset.zero).animate(
      CurvedAnimation(parent: _release, curve: AppMotion.stamp),
    );
    _release.forward(from: 0);
  }

  void _flyOff(int dir, double width) {
    _committing = dir;
    _releaseAnim = Tween<Offset>(
      begin: _drag,
      end: Offset(dir * width * 1.5, _drag.dy),
    ).animate(CurvedAnimation(parent: _release, curve: AppMotion.easeIn));
    _release.forward(from: 0);
  }

  void _onReleaseDone() {
    final int dir = _committing;
    _releaseAnim = null;
    if (dir == 0) {
      // Snap-back finished; the card already settled at rest.
      if (mounted) setState(() {});
      return;
    }
    // Commit finished: HOLD the card off-screen and stay locked (_committing is
    // left set) until the parent advances the queue — on success
    // didUpdateWidget resets to the next card; on failure it springs this one
    // back. This keeps the visual + lock state tied to the real outcome.
    if (mounted) setState(() {});
    if (dir == 1) {
      widget.onApply();
    } else {
      widget.onSkip();
    }
  }

  @override
  Widget build(BuildContext context) {
    final double width = MediaQuery.of(context).size.width;
    if (widget.cards.isEmpty || width <= 0) return const SizedBox.shrink();
    final double progress =
        (_drag.dx.abs() / (_commitFraction * width)).clamp(0.0, 1.0);

    return Column(
      children: <Widget>[
        Expanded(
          child: LayoutBuilder(
            builder: (BuildContext ctx, BoxConstraints cons) {
              final List<JobDeckItem> cards = widget.cards;
              return Stack(
                clipBehavior: Clip.none,
                alignment: Alignment.topCenter,
                children: <Widget>[
                  // The behind card is the next REAL job, rendered at full size /
                  // full fidelity. It peeks below the front card and animates up to
                  // the front position as the front card is dragged away.
                  if (cards.length > 1) _behind(cards[1], progress),
                  _front(cards.first, width, progress),
                ],
              );
            },
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
        _ctaRow(width),
      ],
    );
  }

  /// The next job's full [BbJobCard], peeking below the front card. As the front
  /// card is dragged away ([progress] -> 1) it slides up to the front (offset 0),
  /// "promoting" the next card. Only the front card is interactive.
  Widget _behind(JobDeckItem item, double progress) {
    final double dy = _behindPeek * (1 - progress);
    return IgnorePointer(
      child: Transform.translate(
        offset: Offset(0, dy),
        child: BbJobCard(data: item.data),
      ),
    );
  }

  Widget _front(JobDeckItem item, double width, double progress) {
    final double angle = (_drag.dx / width) * _maxAngle;
    return Transform.translate(
      offset: _drag,
      child: Transform.rotate(
        angle: angle,
        alignment: const Alignment(0, 1.5), // pivot near bottom-centre
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onPanUpdate: _onPanUpdate,
          onPanEnd: (DragEndDetails d) => _onPanEnd(d, width),
          child: Stack(
            children: <Widget>[
              BbJobCard(
                data: item.data,
                // Gate the title tap too: during a commit/decision the (stale)
                // head must not open a detail for a card already being applied.
                onTitleTap: (_locked || widget.onTitleTap == null)
                    ? null
                    : () => widget.onTitleTap!(item.id),
              ),
              // Drag-direction side-band tint: green from the right edge on an
              // apply drag, red from the left edge on a skip drag. Decorative —
              // clipped to the card radius and never intercepts the drag.
              Positioned.fill(child: _sideBand(progress)),
            ],
          ),
        ),
      ),
    );
  }

  /// A directional tint band that deepens with drag [progress]: green hugging the
  /// right edge while dragging right (apply), red hugging the left edge while
  /// dragging left (skip), absent when centred.
  Widget _sideBand(double progress) {
    final double dx = _drag.dx;
    // Centred: no tint at all.
    if (dx == 0) return const IgnorePointer(child: SizedBox.shrink());

    final bool toApply = dx > 0;
    final double alpha = _bandMaxAlpha * progress;
    final Color edge = toApply ? AppColors.success : AppColors.danger;
    final LinearGradient gradient = LinearGradient(
      begin: toApply ? Alignment.centerRight : Alignment.centerLeft,
      end: Alignment.center,
      colors: <Color>[
        edge.withValues(alpha: alpha),
        edge.withValues(alpha: 0.0),
      ],
    );

    return IgnorePointer(
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadii.lg),
        child: DecoratedBox(
          decoration: BoxDecoration(gradient: gradient),
        ),
      ),
    );
  }

  Widget _ctaRow(double width) {
    return Row(
      children: <Widget>[
        Material(
          color: AppColors.surfaceCard,
          shape: const CircleBorder(
            side: BorderSide(color: AppColors.borderStrong, width: 2),
          ),
          child: InkWell(
            key: const Key('swipeSkipButton'),
            customBorder: const CircleBorder(),
            onTap: _locked ? null : () => _flyOff(-1, width),
            child: const SizedBox(
              width: 56,
              height: 56,
              child: Icon(Icons.close, color: AppColors.textMuted, size: 26),
            ),
          ),
        ),
        const SizedBox(width: AppSpacing.s3),
        Expanded(
          child: BbButton(
            buttonKey: const Key('swipeApplyButton'),
            label: 'Apply',
            iconLeft: Icons.check,
            onPressed: _locked ? null : () => _flyOff(1, width),
          ),
        ),
      ],
    );
  }
}
