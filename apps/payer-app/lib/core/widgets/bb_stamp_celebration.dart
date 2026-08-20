import 'package:flutter/material.dart';

import '../theme/app_motion.dart';
import 'bb_success_stamp.dart';

/// A brief, non-blocking success celebration: plays [BbSuccessStamp] once over
/// the current screen, holds, then fades itself out. This is the shared "this
/// worked" beat for the payer's flagship conversion moments — the ₹40 unlock
/// reveal and a successful invite mint (#1077).
///
/// Purely ticker-driven (no timers) so widget tests settle cleanly under
/// `pumpAndSettle`, and wrapped in [IgnorePointer] so the actions beneath it
/// stay tappable while it plays. Drop it into a [Stack] via `Positioned.fill`,
/// gated on the success state — remounting on each fresh success replays it.
class BbStampCelebration extends StatefulWidget {
  const BbStampCelebration({super.key, this.icon = Icons.check});

  final IconData icon;

  @override
  State<BbStampCelebration> createState() => _BbStampCelebrationState();
}

class _BbStampCelebrationState extends State<BbStampCelebration>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    // The stamp lands, holds, then the tail fades the whole thing away.
    duration: AppMotion.slower + AppMotion.slow,
  );

  // Full opacity for the first ~70%, then ease out over the tail.
  late final Animation<double> _fade = Tween<double>(begin: 1, end: 0).animate(
    CurvedAnimation(
      parent: _controller,
      curve: const Interval(0.7, 1, curve: AppMotion.easeOut),
    ),
  );

  @override
  void initState() {
    super.initState();
    _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: FadeTransition(
        opacity: _fade,
        child: Center(child: BbSuccessStamp(icon: widget.icon)),
      ),
    );
  }
}
