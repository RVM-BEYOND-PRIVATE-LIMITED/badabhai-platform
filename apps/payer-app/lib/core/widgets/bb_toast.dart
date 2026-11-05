import 'dart:async';

import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_motion.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// The one voice a BadaBhai toast speaks in (#2690). Tone decides its colour
/// and how long it stays: success / info are quiet, error is tinted (never a
/// saturated red block), and an action (Undo / Retry / View) stays longest.
enum BbToastTone { success, info, error, action }

/// Static contract of [showBbToast] — the values tests and callers share.
abstract final class BbToast {
  BbToast._();

  /// At most this many toasts are alive at once (one visible, two queued).
  static const int maxQueued = 3;

  /// success / info stay 4s, error 6s, an action 8s (issue #2690 rule 2).
  static Duration durationFor(BbToastTone tone) => switch (tone) {
        BbToastTone.success || BbToastTone.info =>
          const Duration(seconds: 4),
        BbToastTone.error => const Duration(seconds: 6),
        BbToastTone.action => const Duration(seconds: 8),
      };
}

/// One optional action on a toast (Undo / Retry / View).
@immutable
class BbToastAction {
  const BbToastAction({required this.label, required this.onPressed});

  final String label;
  final VoidCallback onPressed;
}

/// The app's only toast. Routed through [ScaffoldMessenger] so it survives
/// navigation and sits above the bottom bar / safe area.
///
/// #2690 — one visible at a time (the messenger queues; we cap the outstanding
/// count at [BbToast.maxQueued]), per-[tone] durations, at most one action,
/// polite live-region announcements, swipe-to-dismiss, and an entrance that
/// rises [AppMotion.riseOffset] px over [AppMotion.base] (zero under reduced
/// motion). Pausing on hover/focus/press is handled by the body's timer.
void showBbToast(
  BuildContext context, {
  required String title,
  required String message,
  IconData icon = Icons.check_circle_rounded,
  BbToastTone tone = BbToastTone.success,
  BbToastAction? action,
  Duration? duration,
}) {
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
  final int outstanding = _outstanding[messenger] ?? 0;
  if (outstanding >= BbToast.maxQueued) return;

  final Duration stay = duration ??
      BbToast.durationFor(
        action == null ? tone : BbToastTone.action,
      );
  final BbToastAction? effectiveAction = action == null
      ? null
      : BbToastAction(
          label: action.label,
          onPressed: () {
            messenger.hideCurrentSnackBar();
            action.onPressed();
          },
        );
  final MediaQueryData media = MediaQuery.of(context);
  final bool desktop = media.size.shortestSide >= 600;
  final double safeBottom = media.padding.bottom;

  _outstanding[messenger] = outstanding + 1;
  final ScaffoldFeatureController<SnackBar, SnackBarClosedReason> controller =
      messenger.showSnackBar(
    SnackBar(
      // The body owns the real timer so hover / focus / press can pause it.
      // A day keeps the framework's own timer from racing that one.
      duration: const Duration(days: 1),
      backgroundColor: Colors.transparent,
      elevation: 0,
      behavior: SnackBarBehavior.floating,
      padding: EdgeInsets.zero,
      dismissDirection: DismissDirection.horizontal,
      margin: EdgeInsets.fromLTRB(
        AppSpacing.s4,
        0,
        AppSpacing.s4,
        AppSpacing.s5 + safeBottom,
      ),
      content: _ToastBody(
        title: title,
        message: message,
        icon: icon,
        tone: tone,
        action: effectiveAction,
        stay: stay,
        onTimeout: () => messenger.hideCurrentSnackBar(),
        desktop: desktop,
      ),
    ),
  );
  controller.closed.whenComplete(() {
    final int left = (_outstanding[messenger] ?? 1) - 1;
    _outstanding[messenger] = left < 0 ? 0 : left;
  });
}

/// Drops the toast on show (and lets the next queued one rise). The one
/// supported way to clear a toast — never a direct [ScaffoldMessenger] call.
void hideBbToast(BuildContext context) {
  ScaffoldMessenger.of(context).hideCurrentSnackBar();
}

/// Outstanding toasts per messenger, so the queue never exceeds
/// [BbToast.maxQueued] even though the messenger itself is unbounded.
final Expando<int> _outstanding = Expando<int>('bb_toast_outstanding');

class _ToastBody extends StatefulWidget {
  const _ToastBody({
    required this.title,
    required this.message,
    required this.icon,
    required this.tone,
    required this.action,
    required this.stay,
    required this.onTimeout,
    required this.desktop,
  });

  final String title;
  final String message;
  final IconData icon;
  final BbToastTone tone;
  final BbToastAction? action;
  final Duration stay;
  final VoidCallback onTimeout;
  final bool desktop;

  @override
  State<_ToastBody> createState() => _ToastBodyState();
}

class _ToastBodyState extends State<_ToastBody> {
  Timer? _timer;
  bool _hovering = false;
  bool _focused = false;
  bool _pressed = false;

  bool get _paused => _hovering || _focused || _pressed;

  @override
  void initState() {
    super.initState();
    _restart();
  }

  @override
  void didUpdateWidget(_ToastBody oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.stay != widget.stay) _restart();
  }

  void _restart() {
    _timer?.cancel();
    if (_paused) return;
    _timer = Timer(widget.stay, widget.onTimeout);
  }

  void _setPaused(void Function() change) {
    setState(change);
    if (_paused) {
      _timer?.cancel();
    } else {
      _restart();
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bool error = widget.tone == BbToastTone.error;
    final Color background =
        error ? AppColors.dangerTint : AppColors.surfaceInk;
    final Color titleColor = error ? AppColors.danger : AppColors.paper1;
    final Color messageColor = error ? AppColors.danger : AppColors.ink200;
    final Color iconColor = switch (widget.tone) {
      BbToastTone.success => AppColors.green300,
      BbToastTone.info => AppColors.onBlueMuted,
      BbToastTone.error => AppColors.danger,
      BbToastTone.action => AppColors.haldi,
    };

    final Widget card = Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s4,
        vertical: AppSpacing.s3,
      ),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(AppRadii.md),
        border: error ? Border.all(color: AppColors.red100) : null,
      ),
      child: Row(
        children: <Widget>[
          Icon(widget.icon, color: iconColor, size: 24),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  widget.title,
                  style: AppTypography.body(
                    size: AppTypography.sizeBase,
                    weight: FontWeight.w700,
                    color: titleColor,
                  ),
                ),
                Text(
                  widget.message,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: messageColor,
                  ),
                ),
              ],
            ),
          ),
          if (widget.action != null)
            TextButton(
              onPressed: widget.action!.onPressed,
              style: TextButton.styleFrom(
                foregroundColor: error ? AppColors.danger : AppColors.haldi,
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.s2,
                ),
                minimumSize: const Size(0, AppSpacing.tap),
              ),
              child: Text(widget.action!.label),
            ),
        ],
      ),
    );

    final Widget sized = widget.desktop
        ? Align(
            alignment: Alignment.centerRight,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: card,
            ),
          )
        : card;

    final Widget body = MouseRegion(
      onEnter: (_) => _setPaused(() => _hovering = true),
      onExit: (_) => _setPaused(() => _hovering = false),
      child: Focus(
        onFocusChange: (bool focused) =>
            _setPaused(() => _focused = focused),
        child: Listener(
          onPointerDown: (_) => _setPaused(() => _pressed = true),
          onPointerUp: (_) => _setPaused(() => _pressed = false),
          onPointerCancel: (_) => _setPaused(() => _pressed = false),
          child: Semantics(
            liveRegion: true,
            container: true,
            child: sized,
          ),
        ),
      ),
    );

    return BbToastRise(child: body);
  }
}

/// The toast's entrance: a fade + [AppMotion.riseOffset] rise over
/// [AppMotion.base], opacity + transform only, instant under reduced motion.
class BbToastRise extends StatelessWidget {
  const BbToastRise({super.key, required this.child});

  /// The toast's travel — the motion rules' 6px cap.
  static const double distance = AppMotion.riseOffset;

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final Duration duration = AppMotion.resolve(context, AppMotion.base);
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0, end: 1),
      duration: duration,
      curve: AppMotion.easeOut,
      builder: (BuildContext context, double t, Widget? child) => Opacity(
        opacity: t,
        child: Transform.translate(
          offset: Offset(0, (1 - t) * distance),
          child: child,
        ),
      ),
      child: child,
    );
  }
}
