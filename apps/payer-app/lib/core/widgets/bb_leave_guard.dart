import 'package:flutter/material.dart';

import 'bb_alert_dialog.dart';

/// What to ask before a task holding unsaved input is left (#2595, M7).
@immutable
class BbLeavePrompt {
  const BbLeavePrompt({
    required this.title,
    required this.message,
    this.leaveLabel = 'Discard',
    this.stayLabel = 'Keep editing',
  });

  final String title;
  final String message;

  /// The (crimson) action that leaves and throws the input away.
  final String leaveLabel;

  /// The quiet action that keeps the payer where they are.
  final String stayLabel;

  /// Asks. True = leave (the input is discarded); false = stay — which is also
  /// what tapping outside the dialog means.
  Future<bool> confirm(BuildContext context) => showBbConfirm(
        context,
        title: title,
        message: message,
        confirmLabel: leaveLabel,
        cancelLabel: stayLabel,
        destructive: true,
      );

  /// Runs [leave] straight away when nothing would be lost ([dirty] false),
  /// otherwise asks first and runs it only when the payer chooses to leave.
  void guard(
    BuildContext context, {
    required bool dirty,
    required VoidCallback leave,
  }) {
    if (!dirty) {
      leave();
      return;
    }
    confirm(context).then((bool confirmed) {
      if (confirmed && context.mounted) leave();
    });
  }
}

/// Guards a task screen's unsaved input against a leave the payer did not mean
/// (#2595, M7): the system Back, a bottom-nav tap or a back arrow on a dirty
/// form asks before discarding it.
///
/// Two homes, picked automatically:
///  - **A pushed route** (the Edit screens): a [PopScope] intercepts the system
///    Back and `Navigator.maybePop`, asks when [hasUnsavedChanges], and pops
///    on "leave". Pass [watch] (the form's text controllers) so a clean form
///    keeps the Android predictive-back gesture; without it the route never
///    pops on its own and every back is decided here.
///  - **An in-shell overlay** (Post, the AI chat — setState state on the
///    shell's ONE route, so a [PopScope] here would fight the shell's): the
///    guard registers with the nearest [BbLeaveGuardScope], and the shell asks
///    it before its own system Back or nav tap leaves the overlay.
///
/// [hasUnsavedChanges] is read at the moment of leaving, never cached — typing
/// does not rebuild a form, but it must still count. A screen's own back arrow
/// asks through [BbLeavePrompt.guard] with the same prompt.
class BbLeaveGuard extends StatefulWidget {
  const BbLeaveGuard({
    super.key,
    required this.hasUnsavedChanges,
    required this.prompt,
    this.watch,
    required this.child,
  });

  final bool Function() hasUnsavedChanges;
  final BbLeavePrompt prompt;

  /// Rebuilds the route-mode [PopScope] when it fires, so `canPop` follows
  /// input that does not rebuild the screen (typing). Ignored in a scope.
  final Listenable? watch;

  final Widget child;

  @override
  State<BbLeaveGuard> createState() => _BbLeaveGuardState();
}

class _BbLeaveGuardState extends State<BbLeaveGuard> {
  BbLeaveGuardController? _controller;

  bool get _dirty => widget.hasUnsavedChanges();

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final BbLeaveGuardController? next = BbLeaveGuardScope.maybeOf(context);
    if (!identical(next, _controller)) {
      _controller?._detach(this);
      _controller = next?.._attach(this);
    }
  }

  @override
  void dispose() {
    _controller?._detach(this);
    super.dispose();
  }

  void _onPopInvoked(bool didPop, Object? result) {
    if (didPop) return;
    widget.prompt.guard(
      context,
      dirty: _dirty,
      leave: () => Navigator.of(context).pop(result),
    );
  }

  @override
  Widget build(BuildContext context) {
    // In a shell the host owns every leave; this only answers its questions.
    if (_controller != null) return widget.child;
    final Listenable? watch = widget.watch;
    if (watch == null) {
      return PopScope<Object?>(
        canPop: false,
        onPopInvokedWithResult: _onPopInvoked,
        child: widget.child,
      );
    }
    return ListenableBuilder(
      listenable: watch,
      child: widget.child,
      builder: (BuildContext context, Widget? child) => PopScope<Object?>(
        canPop: !_dirty,
        onPopInvokedWithResult: _onPopInvoked,
        child: child!,
      ),
    );
  }
}

/// The host half of [BbLeaveGuard] for in-shell overlays: put one above the
/// overlay, with a controller the host keeps. The overlay's guard registers
/// with it; the host calls [BbLeaveGuardController.leaveThen] for every leave
/// it owns (system Back, a nav tap).
class BbLeaveGuardScope extends InheritedWidget {
  const BbLeaveGuardScope({
    super.key,
    required this.controller,
    required super.child,
  });

  final BbLeaveGuardController controller;

  static BbLeaveGuardController? maybeOf(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<BbLeaveGuardScope>()
      ?.controller;

  @override
  bool updateShouldNotify(BbLeaveGuardScope oldWidget) =>
      !identical(controller, oldWidget.controller);
}

/// Owned by the host of a [BbLeaveGuardScope]: knows the guard of the task on
/// show (if any) and asks it before the host leaves.
class BbLeaveGuardController {
  _BbLeaveGuardState? _guard;

  /// True when the task on show holds input a leave would discard.
  bool get hasUnsavedChanges {
    final _BbLeaveGuardState? guard = _guard;
    return guard != null && guard.mounted && guard._dirty;
  }

  /// Runs [leave] — at once when nothing would be lost, otherwise only after
  /// the task's prompt is confirmed.
  void leaveThen(VoidCallback leave) {
    final _BbLeaveGuardState? guard = _guard;
    if (guard == null || !guard.mounted) {
      leave();
      return;
    }
    guard.widget.prompt.guard(
      guard.context,
      dirty: guard._dirty,
      leave: leave,
    );
  }

  /// Forgets the guarded task — call when it is dismissed, so a task still
  /// animating out is never asked about again (e.g. on the NEXT overlay).
  void release() => _guard = null;

  void _attach(_BbLeaveGuardState guard) => _guard = guard;

  void _detach(_BbLeaveGuardState guard) {
    if (identical(_guard, guard)) _guard = null;
  }
}
