import 'package:flutter/material.dart';

import '../theme/app_haptics.dart';
import '../theme/app_motion.dart';
import 'bb_success_stamp.dart';

/// A brief, non-blocking success celebration: plays [BbSuccessStamp] once over
/// the current screen, holds, then fades itself out. This is the shared "this
/// worked" beat for the payer's flagship conversion moments — the unlock
/// reveal and a successful invite mint (#1077). No confetti.
///
/// Mount it ONLY for the moment itself (#2596): the reveal gates it on
/// `RevealArgs.justUnlocked`, so opening an earlier unlock with "View" never
/// replays it. With [haptic] it fires the medium [AppHaptics.confirm] as the
/// stamp lands — once per mount, never on a rebuild. With [announcement] it is
/// a polite live region (as a SnackBar is), so TalkBack / VoiceOver say the
/// success the toast it replaced used to say.
///
/// Purely ticker-driven (no timers) so widget tests settle cleanly under
/// `pumpAndSettle`, and wrapped in [IgnorePointer] so the actions beneath it
/// stay tappable while it plays. Drop it into a [Stack] via `Positioned.fill`.
///
/// With animations disabled the stamp appears at full size, holds for the same
/// time, and goes without a fade — the confirmation stays, the motion does not.
class BbStampCelebration extends StatefulWidget {
  const BbStampCelebration({
    super.key,
    this.icon = Icons.check_rounded,
    this.haptic = false,
    this.announcement,
  });

  final IconData icon;

  /// Fire [AppHaptics.confirm] (a medium impact) as the stamp lands.
  final bool haptic;

  /// What a screen reader announces as the stamp appears (a live region);
  /// null keeps the stamp silent (purely decorative).
  final String? announcement;

  /// How long the stamp is on screen: it lands ([AppMotion.stampLand]), holds
  /// ([AppMotion.slow]), then fades ([AppMotion.base]).
  static final Duration lifetime =
      AppMotion.stampLand + AppMotion.slow + AppMotion.base;

  @override
  State<BbStampCelebration> createState() => _BbStampCelebrationState();
}

class _BbStampCelebrationState extends State<BbStampCelebration>
    with SingleTickerProviderStateMixin {
  // `preserve`: the lifetime is how long the confirmation stays readable, so
  // the platform's own animation scaling must not shorten it — the motion
  // inside is gated separately (see [BbSuccessStamp] and [_fadeCurve]).
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: BbStampCelebration.lifetime,
    animationBehavior: AnimationBehavior.preserve,
  );

  /// Where the exit fade starts: after the land ([AppMotion.stampLand]) and a
  /// hold of [AppMotion.slow]; the remaining [AppMotion.base] is the fade.
  static final double _fadeStart =
      (AppMotion.stampLand + AppMotion.slow).inMicroseconds /
          BbStampCelebration.lifetime.inMicroseconds;

  late Animation<double> _fade;
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Exit is ease-in; with animations disabled it is a cut at the very end.
    final Curve fadeCurve = AppMotion.reduced(context)
        ? const Threshold(1)
        : Interval(_fadeStart, 1, curve: AppMotion.easeIn);
    _fade = Tween<double>(begin: 1, end: 0)
        .animate(CurvedAnimation(parent: _controller, curve: fadeCurve));
    if (!_started) {
      _started = true;
      _controller.forward();
      if (widget.haptic) AppHaptics.confirm();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Widget stamp = BbSuccessStamp(icon: widget.icon);
    final String? announcement = widget.announcement;
    return IgnorePointer(
      child: FadeTransition(
        opacity: _fade,
        child: Center(
          child: announcement == null
              ? stamp
              : Semantics(
                  container: true,
                  liveRegion: true,
                  label: announcement,
                  child: ExcludeSemantics(child: stamp),
                ),
        ),
      ),
    );
  }
}
