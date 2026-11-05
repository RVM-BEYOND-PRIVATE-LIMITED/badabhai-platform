import 'package:flutter/services.dart' show TextInputAction;
import 'package:flutter/widgets.dart';

/// One text input's place in a [BbFocusChain]: its focus node, the keyboard
/// action it shows, and what that action does. Hand it to `BbField(flow: …)`.
@immutable
class BbFieldFlow {
  const BbFieldFlow({
    required this.focusNode,
    required this.action,
    required this.onAction,
  });

  final FocusNode focusNode;

  /// [TextInputAction.next] mid-chain, [TextInputAction.done] at its end.
  final TextInputAction action;

  /// Moves focus to the next input, or closes the keyboard at the end.
  final VoidCallback onAction;
}

/// Keyboard flow through a form's single-line text inputs (#2595, M7): the
/// keyboard's "next" moves to the following input in [order], and the last
/// one says "done" and closes the keyboard — a run of boxes is filled without
/// reaching for the screen.
///
/// The chain is explicit (not the default focus traversal) because "next"
/// must land on the next TEXT input: the default order would stop on the chips
/// between them and drop the keyboard mid-form. End a chain where the next
/// control needs a tap, so "done" uncovers it. Dispose with the form.
class BbFocusChain<K extends Object> {
  BbFocusChain(List<K> order)
      : assert(order.isNotEmpty),
        _order = List<K>.unmodifiable(order),
        _nodes = <K, FocusNode>{
          for (final K key in order) key: FocusNode(debugLabel: 'flow:$key'),
        };

  final List<K> _order;
  final Map<K, FocusNode> _nodes;

  /// [key]'s flow, or null when [key] is not part of this chain (the input
  /// then keeps the platform default).
  BbFieldFlow? operator [](K key) {
    final int index = _order.indexOf(key);
    if (index < 0) return null;
    final FocusNode node = _nodes[key]!;
    final bool last = index == _order.length - 1;
    return BbFieldFlow(
      focusNode: node,
      action: last ? TextInputAction.done : TextInputAction.next,
      onAction: last ? node.unfocus : _nodes[_order[index + 1]]!.requestFocus,
    );
  }

  /// The focus node of [key] (which must be in the chain).
  FocusNode node(K key) => _nodes[key]!;

  void dispose() {
    for (final FocusNode node in _nodes.values) {
      node.dispose();
    }
  }
}
