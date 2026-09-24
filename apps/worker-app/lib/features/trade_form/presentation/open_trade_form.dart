import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/util/push_once.dart';
import '../../../router.dart';
import '../domain/profiling_tier.dart';
import '../domain/trade_form_args.dart';
import '../domain/trade_form_repository.dart';

/// Opens the trade form, stopping at the tier chooser ONLY when the server says
/// this worker still has to choose (#1698).
///
/// Every road into the form goes through here so the rule lives in ONE place.
/// The rule is deliberately lopsided: the chooser is shown only on an explicit
/// `needs_choice` with cards to draw, and EVERY other answer — the flag off, a
/// pack not re-seeded, a 404 because no form was handed over, a 5xx, no network
/// — opens the form exactly as the app did before tiers existed.
///
/// That is what makes this safe to put in front of a road the worker is already
/// walking. `loadTierState()` never throws (see its contract), so the only way
/// this changes today's behaviour is when the server actively asks it to.
///
/// [entry] decides how the chooser leaves: the chat PUSHES the form (Back
/// returns to the chat), while the profile preview `go`es to it, clearing the
/// stack — "the point of no return" — so there is nothing to pop back to.
Future<void> openTradeFormWithTier(
  BuildContext context, {
  required TierEntry entry,
  String? sectionKey,
}) async {
  // Resolved from the locator only IF it is registered. Production always
  // registers it; a screen-level widget test wires only the graph its own
  // screen needs, and an additive gate must not be the thing that turns those
  // into failures — nor, in the field, a partially-wired graph into a worker
  // who cannot reach their form. Same discipline as `ResumeCubit`'s optional
  // summary repository. Not registered ⇒ today's navigation, unchanged.
  if (!locator.isRegistered<TradeFormRepository>()) {
    _openFormDirectly(context, entry: entry, sectionKey: sectionKey);
    return;
  }
  final TierState tiers = await locator<TradeFormRepository>().loadTierState();
  if (!context.mounted) return;

  if (!tiers.shouldChooseTier) {
    _openFormDirectly(context, entry: entry, sectionKey: sectionKey);
    return;
  }

  final TierChoiceArgs args = TierChoiceArgs(
    state: tiers,
    entry: entry,
    sectionKey: sectionKey,
  );
  switch (entry) {
    case TierEntry.pushed:
      await context.pushOnce(Routes.tierChoice, extra: args);
    case TierEntry.replaced:
    case TierEntry.upgrade:
      context.go(Routes.tierChoice, extra: args);
  }
}

/// Today's navigation, byte for byte — the branch every worker on every box
/// takes while `PROFILING_TIERS_ENABLED` is off.
void _openFormDirectly(
  BuildContext context, {
  required TierEntry entry,
  String? sectionKey,
}) {
  // The section key is still passed as a BARE STRING here, not wrapped: that is
  // what #1566 shipped and what the router has always read, and an unchanged
  // path should produce an unchanged request.
  switch (entry) {
    case TierEntry.pushed:
      context.pushOnce(Routes.tradeForm, extra: sectionKey);
    case TierEntry.replaced:
    case TierEntry.upgrade:
      context.go(Routes.tradeForm, extra: sectionKey);
  }
}
