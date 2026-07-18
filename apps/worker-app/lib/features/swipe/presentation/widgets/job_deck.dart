import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_motion.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_job_card.dart';

/// TalkBack label for the deck's icon-only skip circle (#375).
const String kSkipSemanticLabel = 'Skip karein';

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
/// from behind as the drag grows, and deepens an axis tint with the drag — green
/// (apply) / red (skip) side bands. On release it commits (off-screen fly-out)
/// when the drag passes a fraction of the screen width OR a fling-velocity
/// threshold — right = apply, left = skip — otherwise it springs back. The two
/// big buttons drive the SAME apply/skip commit: for low-literacy workers the
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

  /// #363 — the live drag offset is a ValueNotifier, NOT setState state. It
  /// changes on every pointer-move frame and on every release-animation tick;
  /// routing that through setState rebuilt the ENTIRE deck 60×/s (both full
  /// BbJobCards, the tint band and the CTA row), and with no RepaintBoundary
  /// each frame also re-rasterized BbFestiveCard's blur-20 shadow plus its
  /// dashed-border CustomPaint — on the low-end Androids this product targets.
  /// Only the moving Transform + the tint band listen to it now.
  final ValueNotifier<Offset> _drag = ValueNotifier<Offset>(Offset.zero);

  // 0 = settling, 1 = apply (right), -1 = skip (left).
  int _committing = 0;

  @override
  void initState() {
    super.initState();
    _release = AnimationController(vsync: this, duration: AppMotion.base)
      ..addListener(() {
        final Animation<Offset>? a = _releaseAnim;
        // #363 — notifier only: a release tick repaints the moving card, it
        // does not rebuild the deck.
        if (a != null) _drag.value = a.value;
      })
      ..addStatusListener((AnimationStatus s) {
        if (s == AnimationStatus.completed) _onReleaseDone();
      });
  }

  @override
  void dispose() {
    _release.dispose();
    _drag.dispose();
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
      _drag.value = Offset.zero;
      return;
    }
    if (newHead != oldHead) {
      // The committed card was accepted and the queue advanced — show the new
      // head from rest.
      _committing = 0;
      _releaseAnim = null;
      _drag.value = Offset.zero;
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
    // Track the full 2D drag 1:1 so the card follows the finger vertically as
    // well as horizontally — but a vertical drag is pure follow-the-finger with
    // a snap-back (#374): it commits nothing and must LOOK like it commits
    // nothing.
    _drag.value += Offset(d.delta.dx, d.delta.dy);
  }

  void _onPanEnd(DragEndDetails d, double width) {
    if (_locked) return;
    final double vx = d.velocity.pixelsPerSecond.dx;
    final Offset drag = _drag.value;
    // Vertical swipes do nothing → snap back. The up-swipe used to "add to
    // Priority", but no prioritize route exists: the repository method was an
    // empty no-op that still fired a "Priority" success toast, so the worker's
    // intent was silently discarded. Removed rather than faked.
    if (drag.dx > _commitFraction * width || vx > _flingVelocity) {
      _flyOff(1, width);
    } else if (drag.dx < -_commitFraction * width || vx < -_flingVelocity) {
      _flyOff(-1, width);
    } else {
      _snapBack();
    }
  }

  void _snapBack() {
    _committing = 0;
    _releaseAnim = Tween<Offset>(begin: _drag.value, end: Offset.zero).animate(
      CurvedAnimation(parent: _release, curve: AppMotion.stamp),
    );
    _release.forward(from: 0);
    _publishLock();
  }

  void _flyOff(int dir, double width) {
    _committing = dir;
    final Offset end = Offset(dir * width * 1.5, _drag.value.dy);
    _releaseAnim = Tween<Offset>(begin: _drag.value, end: end)
        .animate(CurvedAnimation(parent: _release, curve: AppMotion.easeIn));
    _release.forward(from: 0);
    _publishLock();
  }

  /// #363 — the drag no longer goes through setState, so nothing else rebuilds
  /// the deck when a release STARTS. [_locked] gates the CTA row and the card's
  /// title tap, and it has to bite the instant a commit begins or a fast second
  /// tap could double-commit (or navigate off) a card already flying away.
  /// Called once per gesture, never per frame.
  void _publishLock() {
    if (mounted) setState(() {});
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
    final List<JobDeckItem> cards = widget.cards;

    // #363 — this build now runs only on a discrete change (new head, lock
    // flip, queue length), never per drag frame. The LayoutBuilder it used to
    // sit inside existed solely to feed the card height to the up-swipe
    // progress, which #374 deleted.
    return Column(
      children: <Widget>[
        Expanded(
          child: Stack(
            clipBehavior: Clip.none,
            alignment: Alignment.topCenter,
            children: <Widget>[
              // The behind card is the next REAL job, rendered at full size /
              // full fidelity. It peeks below the front card and animates up to
              // the front position as the front card is dragged away.
              if (cards.length > 1) _behind(cards[1], width),
              _front(cards.first, width),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
        _ctaRow(width),
      ],
    );
  }

  /// How far the drag has travelled toward a commit, 0..1 — HORIZONTAL only:
  /// left/right are the only axes that commit anything (#374).
  double _progress(Offset drag, double width) =>
      (drag.dx.abs() / (_commitFraction * width)).clamp(0.0, 1.0);

  /// The next job's full [BbJobCard], peeking below the front card. As the front
  /// card is dragged away (progress -> 1) it slides up to the front (offset 0),
  /// "promoting" the next card. Only the front card is interactive.
  ///
  /// #363 — the card subtree is built ONCE and handed to the builder as `child`,
  /// so a drag frame re-runs only the Transform; the RepaintBoundary keeps
  /// BbFestiveCard's blur shadow + dashed-border CustomPaint out of the repaint.
  Widget _behind(JobDeckItem item, double width) {
    return IgnorePointer(
      child: ValueListenableBuilder<Offset>(
        valueListenable: _drag,
        child: RepaintBoundary(child: BbJobCard(data: item.data)),
        builder: (BuildContext ctx, Offset drag, Widget? child) {
          // #374 — promotion follows the HORIZONTAL commit progress only. An
          // up-drag used to promote the next card too, which read as "this is
          // about to commit" for a gesture that does nothing.
          final double dy = _behindPeek * (1 - _progress(drag, width));
          return Transform.translate(offset: Offset(0, dy), child: child);
        },
      ),
    );
  }

  Widget _front(JobDeckItem item, double width) {
    // #363 — built once per head/lock change, NOT per drag frame.
    final Widget card = RepaintBoundary(
      child: BbJobCard(
        data: item.data,
        // Gate the title tap too: during a commit/decision the (stale)
        // head must not open a detail for a card already being applied.
        onTitleTap: (_locked || widget.onTitleTap == null)
            ? null
            : () => widget.onTitleTap!(item.id),
      ),
    );

    return ValueListenableBuilder<Offset>(
      valueListenable: _drag,
      child: card,
      builder: (BuildContext ctx, Offset drag, Widget? child) {
        return Transform.translate(
          offset: drag,
          child: Transform.rotate(
            angle: (drag.dx / width) * _maxAngle,
            alignment: const Alignment(0, 1.5), // pivot near bottom-centre
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onPanUpdate: _onPanUpdate,
              onPanEnd: (DragEndDetails d) => _onPanEnd(d, width),
              child: Stack(
                children: <Widget>[
                  child!,
                  // Drag-direction side-band tint: green from the left edge on
                  // an apply drag, red from the right edge on a skip drag.
                  // Decorative — clipped to the card radius, never intercepts
                  // the drag. This is the ONLY tint left: the golden "add to
                  // Priority" band that ramped on an up-swipe was removed with
                  // #374, because the action behind it no longer exists and a
                  // deepening tint promised a commit that never came.
                  Positioned.fill(
                    child: _sideBand(drag, _progress(drag, width)),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  /// A directional tint band that deepens with drag [progress]: green hugging the
  /// LEFT edge while dragging right (apply), red hugging the RIGHT edge while
  /// dragging left (skip) — i.e. the tint sits on the side OPPOSITE the drag.
  /// Absent when centred.
  Widget _sideBand(Offset drag, double progress) {
    final double dx = drag.dx;
    // Centred: no tint at all.
    if (dx == 0) return const IgnorePointer(child: SizedBox.shrink());

    final bool toApply = dx > 0;
    final double alpha = _bandMaxAlpha * progress;
    final Color edge = toApply ? AppColors.success : AppColors.danger;
    final LinearGradient gradient = LinearGradient(
      begin: toApply ? Alignment.centerLeft : Alignment.centerRight,
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

  // #374 — `_goldBand` lived here: a saffron bottom tint that deepened as the
  // worker dragged UP, labelled "add to Priority". The action behind it was
  // deleted (an empty repository no-op that still toasted success), but the
  // affordance survived, so the card charged up a committed-looking gradient
  // and then just snapped back — the exact fake-feedback the removal targeted.
  // Do not reintroduce it before a real prioritize route ships.

  Widget _ctaRow(double width) {
    return Row(
      children: <Widget>[
        // #375 — an icon-only control announces nothing to TalkBack: a worker
        // hears "button" with no idea it skips the job. Labelled like the voice
        // screen's mic.
        Semantics(
          button: true,
          label: kSkipSemanticLabel,
          child: Material(
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
