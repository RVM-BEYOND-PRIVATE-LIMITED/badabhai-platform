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
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppMotion.errorReveal,
  )..addStatusListener(_onStatus);

  late final CurvedAnimation _curved = CurvedAnimation(
    parent: _controller,
    curve: AppMotion.easeOut,
    reverseCurve: AppMotion.easeIn,
  );

  /// The line on show — kept while a cleared error fades out.
  String? _shown;
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _controller.duration = AppMotion.resolve(context, AppMotion.errorReveal);
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
      final bool appearing = _shown == null ||
          _controller.status == AnimationStatus.reverse ||
          _controller.status == AnimationStatus.dismissed;
      _shown = next;
      if (appearing) _controller.forward();
    } else if (_shown != null) {
      if (_controller.duration == Duration.zero) {
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
    _curved.dispose();
    _controller.dispose();
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
