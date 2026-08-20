import 'package:flutter/foundation.dart';

/// The height (in logical px, ABOVE the system safe-area inset) of the CURRENT
/// page's bottom bar / sticky CTA — or 0 when it has none (#1071).
///
/// It exists because the app-wide Feedback FAB ([FeedbackFabOverlay]) lives in
/// the `MaterialApp` builder, ABOVE the router's Navigator, so it cannot see the
/// `Scaffold.bottomNavigationBar` of whatever page is on screen. [BbScaffold]
/// measures its own bottom bar after layout and publishes the height here; the
/// overlay reads it and floats clear.
///
/// Single writer by convention: the top-most [BbScaffold] owns the value, and it
/// resets to 0 on dispose. The overlay [max]es it against its own default inset,
/// so a stale 0 only ever degrades to the default float height — never an
/// overlap that hides the CTA underneath.
final ValueNotifier<double> bottomBarInset = ValueNotifier<double>(0);
