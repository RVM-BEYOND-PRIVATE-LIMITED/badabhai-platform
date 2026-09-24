import 'package:flutter/material.dart';

import '../../../../core/di/locator.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../domain/profiling_tier.dart';
import '../../domain/trade_form_args.dart';
import '../../domain/trade_form_repository.dart';
import '../open_trade_form.dart';

/// The Résumé tab's "Aur detail add karein" entry point (#1698).
const String kAddMoreDetailLabel = 'Aur detail add karein';
const String kAddMoreDetailHint = 'Zyada detail = strong resume';

/// Offers a tier UPGRADE — and renders NOTHING unless the server says there is
/// one to offer.
///
/// It is hidden in every other case: tiers off, a pack not re-seeded, a worker
/// already at Hard, a failed read, no network. `loadTierState()` never throws
/// and answers [TierState.disabled] for all of them, so the Résumé tab is
/// byte-identical to today whenever this feature is not live.
///
/// Self-contained on purpose: the Résumé tab's own cubit knows nothing about
/// profiling tiers, and threading a second feature's state through it would
/// couple the resume read to a form concern. The cost is one extra GET on tab
/// open, which is the same shape as the photo strip's own fail-silent fetch.
class AddMoreDetailButton extends StatefulWidget {
  const AddMoreDetailButton({super.key});

  @override
  State<AddMoreDetailButton> createState() => _AddMoreDetailButtonState();
}

class _AddMoreDetailButtonState extends State<AddMoreDetailButton> {
  TierState _tiers = TierState.disabled;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    // Same optional-locator discipline as `openTradeFormWithTier`: a screen
    // test that wires only the résumé graph must not fail on a feature that is
    // meant to be invisible when it is not configured.
    if (!locator.isRegistered<TradeFormRepository>()) return;
    final TierState tiers = await locator<TradeFormRepository>()
        .loadTierState();
    if (!mounted) return;
    setState(() => _tiers = tiers);
  }

  @override
  Widget build(BuildContext context) {
    if (!_tiers.canUpgrade) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: OutlinedButton.icon(
        onPressed: () =>
            openTradeFormWithTier(context, entry: TierEntry.upgrade),
        icon: const Icon(Icons.add_circle_outline_rounded, size: 16),
        label: Text(
          '$kAddMoreDetailLabel · $kAddMoreDetailHint',
          maxLines: 2,
          textAlign: TextAlign.center,
        ),
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(
            double.infinity,
            OnboardingLayout.tapTarget,
          ),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(OnboardingRadii.docked),
          ),
          side: const BorderSide(color: OnboardingColors.borderDefault),
          backgroundColor: OnboardingColors.paperWhite,
          foregroundColor: OnboardingColors.ink600,
          textStyle: OnboardingTypography.inter(
            size: 13,
            weight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}
