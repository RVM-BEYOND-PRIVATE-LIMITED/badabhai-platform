import 'profiling_tier.dart';

/// What a navigation into `Routes.tradeForm` is asking for.
///
/// `extra` on that route has carried a bare section-key STRING since #1566 and
/// still may — this is additive, and the router reads both shapes. A typed
/// object exists because #1698 needs a SECOND thing on the same navigation
/// (the upgrade view), and two positional meanings on one untyped `extra` is
/// how a section key silently becomes a boolean.
class TradeFormArgs {
  const TradeFormArgs({this.sectionKey, this.upgradeView = false});

  /// The résumé-menu section walk's `option_key`, or null for the full walk.
  final String? sectionKey;

  /// Open `?view=upgrade` — only the questions the worker has not answered
  /// yet. Set for exactly one navigation, straight after a tier upgrade.
  final bool upgradeView;
}

/// What the tier chooser needs to draw itself and to know how to leave.
///
/// The [state] is fetched by the CALLER, before navigating, so the screen never
/// opens on a spinner and can never be the thing that shows a network error —
/// when the read fails or tiers are off, the caller opens the form instead and
/// this screen is never built.
class TierChoiceArgs {
  const TierChoiceArgs({
    required this.state,
    required this.entry,
    this.sectionKey,
  });

  final TierState state;
  final TierEntry entry;

  /// Forwarded to the form untouched, so a section walk that happens to pass
  /// through the chooser still opens on its section.
  final String? sectionKey;
}

/// How the worker reached the tier chooser, which decides how they leave it.
///
/// The roads into the trade form navigate differently — chat `push`es it, the
/// profile preview `go`es (clearing the stack, "the point of no return") — so a
/// chooser that always popped would strand a worker who arrived by `go`, and
/// one that always `go`es would eat the chat behind it.
enum TierEntry {
  /// Pushed from the chat's form-offer card. Back returns to the chat.
  pushed,

  /// Reached by `go` from the profile preview. Nothing to pop to.
  replaced,

  /// "Add more detail" from the Résumé tab: an upgrade, not a first choice.
  upgrade,
}
