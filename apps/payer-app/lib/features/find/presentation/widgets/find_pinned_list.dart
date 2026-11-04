import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_motion.dart';
import '../../../../core/theme/app_spacing.dart';

/// A Find view's layout (#2593): [header] — the filters and the counts — stays
/// PINNED at the top while [list] scrolls under it. Both used to scroll away
/// as the list's first row, so a payer deep in the list lost the count and had
/// to scroll back up to change a filter.
///
/// Once the list has scrolled beneath the header, a soft shadow fades in under
/// it ([AppMotion.headerShadow], opacity only; at once under reduced motion),
/// and fades out when the list is back at the top. The shadow is the border
/// token, blurred — no new colour.
///
/// The header can never starve the list: it takes at most [maxHeaderShare] of
/// the view's height. On a short screen — a phone turned sideways, large text,
/// a tall filtered header — it scrolls within that share instead of pushing
/// the list down to nothing (or overflowing); the list always keeps the rest.
class FindPinnedList extends StatefulWidget {
  const FindPinnedList({super.key, required this.header, required this.list});

  /// The pinned block. It stays put while the list scrolls; only when it is
  /// taller than [maxHeaderShare] of the view does it scroll, on its own.
  final Widget header;

  /// The view's vertical scroll view.
  final Widget list;

  /// The most of the view's height the [header] may take.
  static const double maxHeaderShare = 0.5;

  /// Key of the shadow's [AnimatedOpacity] (for widget tests).
  @visibleForTesting
  static const Key shadowKey = Key('find_pinned_header_shadow');

  /// Key of the area under the header that holds [list] (for widget tests).
  @visibleForTesting
  static const Key listAreaKey = Key('find_pinned_list_area');

  @override
  State<FindPinnedList> createState() => _FindPinnedListState();
}

class _FindPinnedListState extends State<FindPinnedList> {
  /// The list has scrolled under the header.
  bool _under = false;

  /// Reads the list's own scroll position — a scroll, or a content change that
  /// moved it (a refetch that clamps a long list back to its top).
  bool _onMetrics(ScrollMetrics metrics, int depth) {
    if (depth != 0 || metrics.axis != Axis.vertical) return false;
    final bool under = metrics.extentBefore > 0;
    if (under != _under) setState(() => _under = under);
    return false;
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          ConstrainedBox(
            constraints: BoxConstraints(
              maxHeight: constraints.maxHeight * FindPinnedList.maxHeaderShare,
            ),
            child: SingleChildScrollView(
              // Never the tab's primary scroll controller: that is the list's
              // (re-tapping the tab scrolls the list to the top, #2592).
              primary: false,
              child: widget.header,
            ),
          ),
          Expanded(
            child: Stack(
              key: FindPinnedList.listAreaKey,
              children: <Widget>[
                NotificationListener<ScrollMetricsNotification>(
                  onNotification: (ScrollMetricsNotification n) =>
                      _onMetrics(n.metrics, n.depth),
                  child: NotificationListener<ScrollNotification>(
                    onNotification: (ScrollNotification n) =>
                        _onMetrics(n.metrics, n.depth),
                    child: widget.list,
                  ),
                ),
                Positioned(
                  top: 0,
                  left: 0,
                  right: 0,
                  child: IgnorePointer(
                    child: AnimatedOpacity(
                      key: FindPinnedList.shadowKey,
                      opacity: _under ? 1 : 0,
                      duration:
                          AppMotion.resolve(context, AppMotion.headerShadow),
                      curve: _under ? AppMotion.easeOut : AppMotion.easeIn,
                      child: const _HeaderShadow(),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The soft shadow the header casts down onto the list: a blurred band of the
/// hairline token along the list's top edge (the half above it is clipped).
class _HeaderShadow extends StatelessWidget {
  const _HeaderShadow();

  @override
  Widget build(BuildContext context) {
    return const DecoratedBox(
      decoration: BoxDecoration(
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: AppColors.border,
            blurRadius: AppSpacing.s2,
            spreadRadius: AppSpacing.gap2,
          ),
        ],
      ),
      child: SizedBox(width: double.infinity, height: AppSpacing.gap2),
    );
  }
}
