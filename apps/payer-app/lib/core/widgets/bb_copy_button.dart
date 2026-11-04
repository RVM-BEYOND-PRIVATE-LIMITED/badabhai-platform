import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_motion.dart';
import 'bb_button.dart';

/// A [BbButton] that copies [text] to the clipboard and says so in place
/// (#2596): its copy icon morphs into a check and the label reads
/// [copiedLabel] for [AppMotion.copiedHold], then both turn back. The morph IS
/// the confirmation — no toast on top of it.
///
/// Only for opaque, non-capability strings (the in-app relay handle). A signed
/// URL must never ride the clipboard (#354).
///
/// Ticker-driven (no timers) so widget tests settle. With animations disabled
/// the icon swaps without the morph; the check still holds for the full time,
/// because it is the message, not decoration.
class BbCopyButton extends StatefulWidget {
  const BbCopyButton({
    super.key,
    required this.text,
    required this.label,
    this.copiedLabel = 'Copied',
    this.variant = BbButtonVariant.primary,
    this.size = BbButtonSize.lg,
    this.block = false,
  });

  /// What lands on the clipboard.
  final String text;

  /// The resting label ("Copy relay handle").
  final String label;

  /// The label while the check shows.
  final String copiedLabel;

  final BbButtonVariant variant;
  final BbButtonSize size;
  final bool block;

  /// The resting and the confirmed icon — solid, rounded (brand icon rules).
  static const IconData copyIcon = Icons.file_copy_rounded;
  static const IconData copiedIcon = Icons.check_circle_rounded;

  @override
  State<BbCopyButton> createState() => _BbCopyButtonState();
}

class _BbCopyButtonState extends State<BbCopyButton>
    with SingleTickerProviderStateMixin {
  // Times the hold only. `preserve`: the platform's animation scaling must not
  // cut the confirmation short.
  late final AnimationController _hold;

  bool _copied = false;

  @override
  void initState() {
    super.initState();
    _hold = AnimationController(
      vsync: this,
      duration: AppMotion.copiedHold,
      animationBehavior: AnimationBehavior.preserve,
    )..addStatusListener(_onHoldStatus);
  }

  void _onHoldStatus(AnimationStatus status) {
    if (status == AnimationStatus.completed && mounted) {
      setState(() => _copied = false);
    }
  }

  Future<void> _copy() async {
    try {
      await Clipboard.setData(ClipboardData(text: widget.text));
    } on PlatformException {
      // Fail closed: never claim "Copied" for a write that did not happen.
      return;
    }
    if (!mounted) return;
    setState(() => _copied = true);
    // A second tap while the check shows copies again and restarts the hold.
    _hold.forward(from: 0);
  }

  @override
  void dispose() {
    _hold.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Duration morph = AppMotion.resolve(context, AppMotion.fast);
    // A live region, so a screen reader hears "Copied" when the label flips.
    return Semantics(
      liveRegion: true,
      child: BbButton(
        label: _copied ? widget.copiedLabel : widget.label,
        variant: widget.variant,
        size: widget.size,
        block: widget.block,
        onPressed: _copy,
        leading: AnimatedSwitcher(
          duration: morph,
          switchInCurve: AppMotion.easeOut,
          switchOutCurve: AppMotion.easeIn,
          transitionBuilder: (Widget child, Animation<double> animation) =>
              FadeTransition(
            opacity: animation,
            child: ScaleTransition(
              scale: Tween<double>(begin: 0.6, end: 1).animate(animation),
              child: child,
            ),
          ),
          child: Icon(
            _copied ? BbCopyButton.copiedIcon : BbCopyButton.copyIcon,
            key: ValueKey<bool>(_copied),
          ),
        ),
      ),
    );
  }
}
