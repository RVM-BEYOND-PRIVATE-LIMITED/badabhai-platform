import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

/// #2592 (M4) — what the shell tells a kept-alive tab branch.
///
/// The tabs live in an `IndexedStack`, so leaving one hides it with its data,
/// filters and scroll intact. Returning to it must not throw that away behind a
/// skeleton or spinner: the shell sends [refresh] instead, and each screen
/// re-reads its API QUIETLY ([BbTabRefreshListener]) — the old rows stay on
/// screen until the fresh ones land.
class BbTabSignals {
  final _Ping _refreshes = _Ping();
  final _Ping _reselects = _Ping();

  /// Fires once per return to the tab.
  Listenable get refreshes => _refreshes;

  /// Fires when the tab already on screen is tapped again.
  Listenable get reselects => _reselects;

  /// The tab was selected again — re-read quietly.
  void refresh() => _refreshes.ping();

  /// The tab on screen was tapped again (the shell scrolls it to the top).
  void reselect() => _reselects.ping();

  void dispose() {
    _refreshes.dispose();
    _reselects.dispose();
  }
}

class _Ping extends ChangeNotifier {
  void ping() => notifyListeners();
}

/// Hands one tab branch its [BbTabSignals].
class BbTabScope extends InheritedWidget {
  const BbTabScope({super.key, required this.signals, required super.child});

  final BbTabSignals signals;

  /// The signals of the tab [context] sits in, or null outside a tab (a screen
  /// pushed as an overlay or a route).
  static BbTabSignals? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<BbTabScope>()?.signals;

  @override
  bool updateShouldNotify(BbTabScope oldWidget) => signals != oldWidget.signals;
}

/// Lets a [State] hear the shell return to the tab it sits in
/// ([onTabReturn]) and re-tap it ([onTabReselect]). A no-op outside a tab.
/// The shell sends both after the frame that applied the selection, so
/// [State.widget] already holds the new configuration when they run.
mixin BbTabReturnMixin<T extends StatefulWidget> on State<T> {
  BbTabSignals? _tabSignals;

  /// The shell came back to this tab.
  void onTabReturn();

  /// The tab on screen was tapped again. Nothing by default.
  void onTabReselect() {}

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final BbTabSignals? next = BbTabScope.maybeOf(context);
    if (identical(next, _tabSignals)) return;
    _unsubscribe();
    _tabSignals = next;
    next?.refreshes.addListener(onTabReturn);
    next?.reselects.addListener(onTabReselect);
  }

  void _unsubscribe() {
    _tabSignals?.refreshes.removeListener(onTabReturn);
    _tabSignals?.reselects.removeListener(onTabReselect);
  }

  @override
  void dispose() {
    _unsubscribe();
    super.dispose();
  }
}

/// Calls [onRefresh] — with this widget's own context, so it can read the
/// screen's cubits — every time the shell returns to the tab it sits in. A
/// no-op outside a tab.
///
/// [enabled] false marks a hidden sub-view (Find's other view). It is read a
/// frame after the return, so a screen that switches what it shows on that
/// same return (Find opening All candidates) refreshes the view it switched
/// TO. A hidden view does not re-read on the return — a view the payer may
/// never look at again costs no request — but it remembers it missed one and
/// re-reads, once, the next time it is shown, so it is never left showing
/// rows from before the return.
class BbTabRefreshListener extends StatefulWidget {
  const BbTabRefreshListener({
    super.key,
    required this.onRefresh,
    required this.child,
    this.enabled = true,
  });

  final void Function(BuildContext context) onRefresh;
  final Widget child;
  final bool enabled;

  @override
  State<BbTabRefreshListener> createState() => _BbTabRefreshListenerState();
}

class _BbTabRefreshListenerState extends State<BbTabRefreshListener>
    with BbTabReturnMixin<BbTabRefreshListener> {
  /// True until the end of the frame this view was built in. A return heard
  /// then is the one that built it (Find's Applicants view, rebuilt for a Jobs
  /// card's "Applicants"): its cubit is already loading fresh rows, and a
  /// re-read would only fetch them twice.
  bool _justBuilt = true;

  /// A return arrived while this view was hidden: it re-reads when shown.
  bool _missedReturn = false;

  /// An after-frame check ([_checkAfterFrame]) is already on its way.
  bool _checkScheduled = false;

  @override
  void initState() {
    super.initState();
    SchedulerBinding.instance.addPostFrameCallback((_) => _justBuilt = false);
  }

  @override
  void onTabReturn() {
    if (_justBuilt) return;
    _checkAfterFrame();
  }

  @override
  void didUpdateWidget(BbTabRefreshListener oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_missedReturn && widget.enabled && !oldWidget.enabled) {
      _checkAfterFrame();
    }
  }

  /// After this frame — never during build — re-reads if this view is shown,
  /// else notes the missed return. A return and a catch-up share ONE check:
  /// the return that re-shows a view which missed an earlier one (Find
  /// opening All candidates after a Jobs card's "Applicants") hits both
  /// paths in the same frame, and must still re-read only once.
  void _checkAfterFrame() {
    if (_checkScheduled) return;
    _checkScheduled = true;
    SchedulerBinding.instance
      ..addPostFrameCallback((_) {
        _checkScheduled = false;
        if (!mounted) return;
        if (widget.enabled) {
          _missedReturn = false;
          widget.onRefresh(context);
        } else {
          _missedReturn = true;
        }
      })
      ..ensureVisualUpdate();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
