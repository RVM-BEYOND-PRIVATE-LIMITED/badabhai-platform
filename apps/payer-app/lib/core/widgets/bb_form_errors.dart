import 'package:flutter/foundation.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

import '../theme/app_haptics.dart';
import '../theme/app_motion.dart';
import 'bb_shake.dart';

/// Inline validation for one form (#2595, M7): which controls are wrong, and
/// the "take me to it" when a submit is refused.
///
/// The screen owns the RULES — a map of control → message, built fresh from
/// its state. This owns the contract every form shares, which used to be a
/// toast that only named the field:
///  - [show] puts each error AT its control (`errors[field]` → the control's
///    `errorText`) and, once that frame is painted, [revealFirst]: the topmost
///    erroring control scrolls into view, shakes once and fires the error
///    haptic.
///  - [settle] runs on every edit: an error disappears the moment its control
///    is fixed, but a NEW one waits for the next submit — no nagging while the
///    payer is still filling the form in.
///
/// Wrap each validated control in `BbShake(key: errors.anchor(field), …)`.
/// "First" is decided by where the controls actually sit on screen (top to
/// bottom, then left to right), so a form whose layout differs by role never
/// needs a second ordering to keep in sync.
class BbFormErrors<F extends Object> {
  Map<F, String> _errors = <F, String>{};
  final Map<F, GlobalKey<BbShakeState>> _anchors =
      <F, GlobalKey<BbShakeState>>{};

  /// The error on show at [field], or null.
  String? operator [](F field) => _errors[field];

  /// True when no error is on show.
  bool get isEmpty => _errors.isEmpty;

  /// The errors on show, keyed by control.
  Map<F, String> get current => Map<F, String>.unmodifiable(_errors);

  /// The [BbShake] key that anchors [field] — one per control, stable for the
  /// life of the form.
  GlobalKey<BbShakeState> anchor(F field) => _anchors.putIfAbsent(
        field,
        () => GlobalKey<BbShakeState>(debugLabel: 'field:$field'),
      );

  /// Puts [errors] on show (replacing any). When there are some, the first is
  /// revealed after the frame that paints them — call inside `setState`.
  /// Returns true when the form was refused (there were errors).
  bool show(Map<F, String> errors) {
    _errors = Map<F, String>.of(errors);
    if (_errors.isEmpty) return false;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // ignore: discarded_futures — the reveal runs on its own.
      revealFirst();
    });
    return true;
  }

  /// Re-checks the errors on show against [fresh] (the rules run again): a
  /// fixed control's error drops, one still failing keeps its CURRENT message,
  /// and nothing new is added. Returns true when what is on show changed.
  bool settle(Map<F, String> fresh) {
    if (_errors.isEmpty) return false;
    final Map<F, String> next = <F, String>{
      for (final F field in _errors.keys)
        if (fresh[field] case final String message) field: message,
    };
    if (mapEquals(next, _errors)) return false;
    _errors = next;
    return true;
  }

  /// Scrolls the topmost erroring control into view (when it is not already
  /// wholly on screen), then shakes it with the error haptic.
  Future<void> revealFirst() async {
    final BbShakeState? target = _topmost();
    if (target == null) return;
    await _scrollIntoView(target.context);
    if (!target.mounted) return;
    target.shake();
    // ignore: discarded_futures — fire-and-forget double tick.
    AppHaptics.error();
  }

  /// Where a revealed control lands in its viewport: near the top, with a
  /// little of the form above it for context.
  static const double revealAlignment = 0.1;

  BbShakeState? _topmost() {
    BbShakeState? best;
    Offset? bestAt;
    for (final F field in _errors.keys) {
      final BbShakeState? state = _anchors[field]?.currentState;
      if (state == null || !state.mounted) continue;
      final RenderObject? box = state.context.findRenderObject();
      if (box is! RenderBox || !box.attached || !box.hasSize) continue;
      final Offset at = box.localToGlobal(Offset.zero);
      final bool above = bestAt == null ||
          at.dy < bestAt.dy - 0.5 ||
          ((at.dy - bestAt.dy).abs() <= 0.5 && at.dx < bestAt.dx);
      if (above) {
        best = state;
        bestAt = at;
      }
    }
    return best;
  }

  static Future<void> _scrollIntoView(BuildContext context) {
    final RenderObject? object = context.findRenderObject();
    final ScrollableState? scrollable = Scrollable.maybeOf(context);
    if (object == null || scrollable == null) return Future<void>.value();
    final RenderAbstractViewport? viewport =
        RenderAbstractViewport.maybeOf(object);
    if (viewport == null) return Future<void>.value();
    final double pixels = scrollable.position.pixels;
    // The scroll offsets that would put the control's top at the viewport's
    // top, and its bottom at the viewport's bottom: between the two, all of it
    // is already on screen and the form does not move.
    final double showAtTop = viewport.getOffsetToReveal(object, 0).offset;
    final double showAtBottom = viewport.getOffsetToReveal(object, 1).offset;
    if (pixels <= showAtTop + 0.5 && pixels >= showAtBottom - 0.5) {
      return Future<void>.value();
    }
    return Scrollable.ensureVisible(
      context,
      alignment: revealAlignment,
      duration: AppMotion.resolve(context, AppMotion.base),
      curve: AppMotion.easeOut,
    );
  }
}
