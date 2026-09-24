import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/observability/analytics.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../router.dart';
import '../domain/profiling_tier.dart';
import '../domain/trade_form_args.dart';
import '../domain/trade_form_repository.dart';
import 'widgets/tier_option_card.dart';

/// The screen's copy. Hinglish, Latin script, like every other onboarding
/// screen in this app (there is no l10n plumbing on this road — see the
/// Resume tab's own note).
const String kTierScreenTitle = 'Kitna time de sakte hain?';
const String kTierScreenSubtitle =
    'Jitna zyada batayenge, resume utna hi strong banega.';
const String kTierEasyTitle = 'Easy';
const String kTierEasyDescription = 'Basic profile. Fastest to finish.';
const String kTierMediumTitle = 'Medium';
const String kTierMediumDescription = 'Skills, tools and full work history.';
const String kTierHardTitle = 'Hard';
const String kTierHardDescription = 'Sab kuch — poori detail ke saath.';

/// The upgrade variant's chrome (#1698 "Add more detail").
const String kTierUpgradeTitle = 'Aur detail add karein';
const String kTierUpgradeSubtitle =
    'Jo aapne pehle bataya hai wo dobara nahi poocha jayega.';

/// Shown when the tap could not be recorded. The worker keeps their place —
/// the screen stays up and the card is tappable again.
const String kTierChoiceFailed = 'Choice save nahi ho payi.';

String tierTitleOf(ProfilingTier tier) => switch (tier) {
      ProfilingTier.easy => kTierEasyTitle,
      ProfilingTier.medium => kTierMediumTitle,
      ProfilingTier.hard => kTierHardTitle,
    };

String tierDescriptionOf(ProfilingTier tier) => switch (tier) {
      ProfilingTier.easy => kTierEasyDescription,
      ProfilingTier.medium => kTierMediumDescription,
      ProfilingTier.hard => kTierHardDescription,
    };

/// #1698 — the worker chooses how long profiling takes before the first form
/// question: Easy, Medium or Hard ("BadaBhai Standard").
///
/// THIS SCREEN IS NEVER A GATE THE WORKER CANNOT PASS. It is only ever shown
/// when the server said `needs_choice: true` with cards to draw; every other
/// answer — the flag off, a pack not re-seeded, a 404, no network — opens the
/// full form exactly as the app did before tiers existed. That decision is made
/// by the CALLER (`openTradeFormWithTier`), so this screen is never even built
/// in those cases.
class TierChoiceScreen extends StatefulWidget {
  const TierChoiceScreen({
    super.key,
    required this.state,
    this.entry = TierEntry.pushed,
    this.sectionKey,
  });

  /// Already fetched by the caller, so the screen never opens on a spinner and
  /// can never be the thing that shows a network error.
  final TierState state;
  final TierEntry entry;

  /// Forwarded to the form untouched — the résumé-menu section walk carries a
  /// section key as `extra`, and losing it would silently turn a one-section
  /// edit into the whole form.
  final String? sectionKey;

  @override
  State<TierChoiceScreen> createState() => _TierChoiceScreenState();
}

class _TierChoiceScreenState extends State<TierChoiceScreen> {
  /// The card being confirmed, so the tap paints immediately while the POST is
  /// in flight. There is no confirm step (#1698): a tap IS the choice.
  ProfilingTier? _pending;

  /// Synchronous, like every other open-once latch in this app: on a real
  /// double-tap the disabled state arrives a frame too late (#372).
  bool _choosing = false;

  bool get _isUpgrade => widget.entry == TierEntry.upgrade;

  @override
  void initState() {
    super.initState();
    unawaited(
      BbAnalytics.instance.log(
        _isUpgrade
            ? BbAnalytics.tierUpgradeScreenShown
            : BbAnalytics.tierScreenShown,
      ),
    );
  }

  /// The cards to draw: every priced tier on a first choice, only the tiers the
  /// server says are reachable on an upgrade. A downgrade is a 409 server-side
  /// and is never offered here.
  List<TierEstimate> get _options =>
      _isUpgrade ? widget.state.upgradeOptions : widget.state.tiers;

  Future<void> _choose(TierEstimate option) async {
    if (_choosing) return;
    setState(() {
      _choosing = true;
      _pending = option.tier;
    });
    try {
      final TierChoice? choice = await locator<TradeFormRepository>()
          .chooseTier(option.tier);
      if (!mounted) return;
      final String token = profilingTierWire(option.tier);
      unawaited(
        BbAnalytics.instance.log(
          _isUpgrade
              ? BbAnalytics.tierUpgraded(tier: token)
              : BbAnalytics.tierSelected(tier: token),
        ),
      );
      _openForm(choice);
    } on Failure catch (failure) {
      if (!mounted) return;
      // Say the REAL reason and leave the worker exactly where they are, with
      // every card tappable again. A tier screen must never dead-end.
      setState(() {
        _choosing = false;
        _pending = null;
      });
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(
              '$kTierChoiceFailed ${failureReason(failure).reason}',
            ),
          ),
        );
    }
  }

  /// Opens the form the choice earned.
  ///
  /// `change: "upgraded"` is the ONLY case that asks for the narrowed
  /// `?view=upgrade` form. A first selection, an unchanged re-tap, and a body
  /// this build could not read (`choice == null`) all open the ordinary full
  /// form — the safe arm, because an upgrade view can legitimately be empty.
  void _openForm(TierChoice? choice) {
    final bool upgrade = choice?.needsUpgradeView ?? false;
    final Object? extra = upgrade
        ? const TradeFormArgs(upgradeView: true)
        : (widget.sectionKey == null
              ? null
              : TradeFormArgs(sectionKey: widget.sectionKey));
    // `go` in every case: the tier screen has done its job and must not sit on
    // the stack behind the form, where Back would offer a choice the worker
    // has already made (and the server would answer `unchanged`).
    context.go(Routes.tradeForm, extra: extra);
  }

  void _back() {
    if (widget.entry == TierEntry.pushed && context.canPop()) {
      context.pop();
      return;
    }
    // Arrived by `go` (no stack) or from the Résumé tab: there is nothing to
    // pop to, so return to where that road came from.
    context.go(_isUpgrade ? Routes.resume : Routes.chatProfiling);
  }

  @override
  Widget build(BuildContext context) {
    final List<TierEstimate> options = _options;
    return Scaffold(
      backgroundColor: OnboardingColors.canvasBg,
      body: Column(
        children: <Widget>[
          ShiftBlueHeader(
            title: _isUpgrade ? kTierUpgradeTitle : kTierScreenTitle,
            subtitle: _isUpgrade ? kTierUpgradeSubtitle : kTierScreenSubtitle,
            onBack: _back,
            variant: OnboardingVariant.formFlow,
          ),
          Expanded(
            child: SafeArea(
              top: false,
              child: OnboardingBody(
                padding: const EdgeInsets.fromLTRB(
                  FormFlowLayout.gutter,
                  16,
                  FormFlowLayout.gutter,
                  24,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    for (final TierEstimate option in options)
                      TierOptionCard(
                        estimate: option,
                        title: tierTitleOf(option.tier),
                        description: tierDescriptionOf(option.tier),
                        isSelected: _pending == option.tier,
                        // Disabled only while a tap is in flight, and then for
                        // every card at once — never per-card, which would look
                        // like some tiers are unavailable.
                        onTap: _choosing ? null : () => _choose(option),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
