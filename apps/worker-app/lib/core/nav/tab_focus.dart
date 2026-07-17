import 'package:flutter/widgets.dart';

/// Indices of the four shell tabs, in [StatefulShellRoute] branch order.
///
/// Named rather than bare ints so a tab root cannot silently listen for the
/// wrong one if the branch order ever changes.
abstract final class TabIndex {
  static const int jobs = 0;
  static const int resume = 1;
  static const int profile = 2;
  static const int alerts = 3;
}

/// Which shell tab is currently visible.
///
/// [StatefulShellRoute.indexedStack] keeps every visited branch MOUNTED, so a
/// tab root's `GoRoute.builder` — and therefore its `create:` and `initState` —
/// runs exactly ONCE, on first visit. Switching back to a tab shows whatever its
/// cubit last emitted, however stale. Nothing re-runs, because nothing is
/// rebuilt.
///
/// That is not a DI problem (the cubits are `registerFactory`): the IndexedStack
/// holds the Elements, and their cubits with them. So the app needs an explicit
/// "this tab is now visible" signal, which is this.
///
/// A locator singleton rather than an InheritedWidget: the tab roots sit inside
/// their own branch Navigators, below the shell, and an inherited lookup across
/// that boundary is exactly the kind of thing that breaks quietly.
class TabFocus extends ValueNotifier<int> {
  TabFocus([super.initialIndex = TabIndex.jobs]);
}

/// Calls [onFocused] whenever [index] becomes the active tab.
///
/// Wrap a tab ROOT with this to refetch on tab switch. It fires on CHANGE only,
/// never on mount: a branch's first build already loads via its `create:`, and
/// firing here too would double-load.
///
/// It deliberately does NOT dedupe further — the cubit owns the
/// already-loading guard, because only the cubit knows whether a load is in
/// flight, and the tap handler sets [TabFocus] before the branch builds, which
/// can still race a first-visit `create:` load.
class TabFocusRefetch extends StatefulWidget {
  const TabFocusRefetch({
    super.key,
    required this.tabFocus,
    required this.index,
    required this.onFocused,
    required this.child,
  });

  final TabFocus tabFocus;

  /// The tab this subtree belongs to — see [TabIndex].
  final int index;

  /// Invoked when this tab becomes visible. Must be cheap and idempotent: the
  /// callee is expected to ignore the call when a load is already in flight.
  final VoidCallback onFocused;

  final Widget child;

  @override
  State<TabFocusRefetch> createState() => _TabFocusRefetchState();
}

class _TabFocusRefetchState extends State<TabFocusRefetch> {
  @override
  void initState() {
    super.initState();
    widget.tabFocus.addListener(_onTabChanged);
  }

  @override
  void dispose() {
    widget.tabFocus.removeListener(_onTabChanged);
    super.dispose();
  }

  void _onTabChanged() {
    if (!mounted) return;
    if (widget.tabFocus.value != widget.index) return;
    widget.onFocused();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
