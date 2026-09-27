import 'package:flutter/material.dart';

import '../theme/onboarding_theme.dart';
import 'onboarding/brand_badge.dart';

/// The BadaBhai lockup at the FOOT of a job card, centred — the same mark and
/// wordmark the headers carry in their top-right corner ([BrandBadge]), so a
/// card that travels (a screenshot a worker forwards on WhatsApp) still says
/// where it came from.
///
/// A LIGHT-GREY ROUNDED PLATE BEHIND IT, and that is what makes the mark
/// visible. The mark is a shipped PNG whose two figures are amber and
/// NEAR-WHITE (measured: ~62% `#E0A020`, ~38% `#E0E0E0`), drawn for the navy
/// header. On the card's white paper the pale figure vanished into the page —
/// the owner saw exactly that. `pillMutedBg` (`#F1F5F9`) is darker than the
/// figure, so it separates from the paper and the figure separates from it,
/// with a hairline to close the shape.
///
/// NOT A BUTTON. The plate hugs the lockup by 5dp and carries no elevation, no
/// fill weight and no tap target — it is a signature on the card, not a control
/// the worker can press (the earlier navy pill read as one).
///
/// The wordmark is drawn in ink rather than the header's white, because this
/// one sits on a light surface.
///
/// FIXED AND SEPARATE. It is never part of the card's flowing content: the deck
/// card reserves its height and clips the content ABOVE it, and the list card
/// appends it after a hairline. Card text can therefore never overlap it.
class JobCardBrandFooter extends StatelessWidget {
  const JobCardBrandFooter({super.key, this.topGap = 12});

  /// Space between the card's content and the lockup.
  final double topGap;

  /// How far the plate extends past the lockup, top and bottom.
  static const double platePadding = 5;

  /// The space to the RIGHT of the wordmark.
  static const double platePaddingRight = 10;

  /// The space to the LEFT of the mark — ZERO, and that is an optical
  /// correction, not a mistake.
  ///
  /// MEASURED on the shipped PNG: the mark is two figures, and the PALE one
  /// (`#E0E0E0`) occupies the whole left half of the image box (source columns
  /// 6–454 of 1080). On this plate's `#F1F5F9` it is invisible, so the eye sees
  /// the logo begin at the AMBER figure — which starts 10.8dp into the 22dp
  /// box. With 10dp of padding as well, the left gap READ as ~21dp against the
  /// right's 10dp, which is exactly what the owner saw.
  ///
  /// Zero here puts the first VISIBLE ink 10.8dp from the plate's edge, within
  /// a dp of the right side. The day the mark ships with a figure that reads on
  /// a light surface, this goes back to matching [platePaddingRight].
  static const double platePaddingLeft = 0;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(top: topGap),
      child: Center(
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: OnboardingColors.pillMutedBg,
            // `note` (12), not `badge` (20). MEASURED: the box padding was an
            // exact 5 on all four sides, yet the right read as tighter — a 20dp
            // arc on a 32dp-tall plate curves in exactly where the wordmark
            // sits, while the image's straight left edge keeps its full gap. A
            // 12 keeps the corner round without eating the text's air.
            borderRadius: BorderRadius.circular(OnboardingRadii.note),
            border: Border.all(color: OnboardingColors.borderSubtle),
          ),
          child: Padding(
            // OPTICALLY equal, not numerically — see [platePaddingLeft].
            padding: const EdgeInsets.fromLTRB(
              platePaddingLeft,
              platePadding,
              platePaddingRight,
              platePadding,
            ),
            // CHROME, SO ITS TEXT IS CLAMPED — the same 1.3 ceiling the Shift
            // Blue header puts on this very lockup. Unclamped, a 2.0 text scale
            // doubled the wordmark and pushed it 20px past a 320dp card (caught
            // by the kit matrix). A brand mark is not content a worker needs to
            // read larger; the job's own text scales freely.
            child: MediaQuery.withClampedTextScaling(
              maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
              // The lockup itself is never re-drawn here — one source, every
              // screen (see [BrandBadge]).
              child: const BrandBadge(wordmarkColor: OnboardingColors.ink900),
            ),
          ),
        ),
      ),
    );
  }
}
