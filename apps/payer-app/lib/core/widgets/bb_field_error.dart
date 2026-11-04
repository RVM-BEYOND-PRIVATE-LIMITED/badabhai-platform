import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_motion.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// The inline error under a form control (#2595, M7) — a crimson icon + line
/// AT the field the payer has to fix, instead of a toast that only names it.
///
/// Appears with a fade and an [AppMotion.errorTravel] slide down over
/// [AppMotion.errorReveal] (ease-out) and fades out (ease-in) before its row
/// collapses. Opacity + transform only, instant under reduced motion. It is a
/// live region, so a screen reader announces the error as it appears.
///
/// Renders nothing while [text] is null, so a control can always carry one.
class BbFieldError extends StatefulWidget {
  const BbFieldError({super.key, required this.text});

  /// The error to show, or null for none.
  final String? text;

  /// Key of the visible error line (for widget tests).
  @visibleForTesting
  static const Key lineKey = Key('bb_field_error_line');

  @override
  State<BbFieldError> createState() => _BbFieldErrorState();
}

class _BbFieldErrorState extends State<BbFieldError>
    with SingleTickerProviderStateMixin {
  // Created on the first error only: every BbField carries one of these, and a
  // field that never shows an error should cost nothing.
  AnimationController? _controllerOrNull;
  CurvedAnimation? _curvedOrNull;

  AnimationController get _controller => _controllerOrNull ??=
      AnimationController(vsync: this, duration: _duration)
        ..addStatusListener(_onStatus);

  CurvedAnimation get _curved => _curvedOrNull ??= CurvedAnimation(
        parent: _controller,
        curve: AppMotion.easeOut,
        reverseCurve: AppMotion.easeIn,
      );

  /// [AppMotion.errorReveal], or zero under reduced motion.
  Duration _duration = AppMotion.errorReveal;

  /// The line on show — kept while a cleared error fades out.
  String? _shown;
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _duration = AppMotion.resolve(context, AppMotion.errorReveal);
    _controllerOrNull?.duration = _duration;
    if (!_started) {
      _started = true;
      // An error present on the first build still ENTERS (it just appeared).
      if (widget.text != null) {
        _shown = widget.text;
        _controller.forward();
      }
    }
  }

  @override
  void didUpdateWidget(BbFieldError oldWidget) {
    super.didUpdateWidget(oldWidget);
    final String? next = widget.text;
    if (next != null) {
      final AnimationStatus status = _controller.status;
      final bool appearing = _shown == null ||
          status == AnimationStatus.reverse ||
          status == AnimationStatus.dismissed;
      _shown = next;
      if (appearing) _controller.forward();
    } else if (_shown != null) {
      if (_duration == Duration.zero) {
        // Reduced motion: gone at once (clear [_shown] first so the status
        // listener has nothing left to do mid-build).
        _shown = null;
        _controller.value = 0;
      } else {
        _controller.reverse();
      }
    }
  }

  void _onStatus(AnimationStatus status) {
    if (status == AnimationStatus.dismissed &&
        widget.text == null &&
        _shown != null &&
        mounted) {
      setState(() => _shown = null);
    }
  }

  @override
  void dispose() {
    _curvedOrNull?.dispose();
    _controllerOrNull?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final String? text = _shown;
    if (text == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.s2),
      child: FadeTransition(
        opacity: _curved,
        child: AnimatedBuilder(
          animation: _curved,
          builder: (BuildContext context, Widget? child) => Transform.translate(
            offset: Offset(0, -AppMotion.errorTravel * (1 - _curved.value)),
            child: child,
          ),
          child: Semantics(
            liveRegion: true,
            container: true,
            child: Row(
              key: BbFieldError.lineKey,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const Padding(
                  padding: EdgeInsets.only(top: AppSpacing.gap2),
                  child: Icon(
                    Icons.error_rounded,
                    size: 16,
                    color: AppColors.danger,
                  ),
                ),
                const SizedBox(width: AppSpacing.s2),
                Flexible(
                  child: Text(
                    text,
                    style: AppTypography.body(
                      size: AppTypography.sizeSm,
                      color: AppColors.danger,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
