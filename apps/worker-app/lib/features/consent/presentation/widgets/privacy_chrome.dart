import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';

// The privacy screens' shared chrome — the consent screen and the
// employer-sharing prompt wear the same header and shield.

/// The kit's privacy top bar: a navy strip with a back arrow, `YOUR PRIVACY`
/// centred in safety yellow, and an India flag chip.
///
/// Both side slots are a fixed 48px so the title is TRULY centred whether or
/// not the back arrow is drawn (it is absent on the onboarding path).
class PrivacyTopBar extends StatelessWidget {
  const PrivacyTopBar({super.key, this.onBack});

  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: Container(
        color: OnboardingColors.shiftBlue,
        padding: EdgeInsets.only(
          top: MediaQuery.paddingOf(context).top + 10,
          bottom: 16,
          left: 16,
          right: 16,
        ),
        child: Center(
          heightFactor: 1,
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: OnboardingLayout.maxContentWidth,
            ),
            child: Row(
              children: <Widget>[
                SizedBox(
                  width: OnboardingLayout.tapTarget,
                  child: onBack == null
                      ? null
                      : IconButton(
                          tooltip: 'Wapas',
                          onPressed: onBack,
                          padding: EdgeInsets.zero,
                          alignment: Alignment.centerLeft,
                          constraints: const BoxConstraints.tightFor(
                            width: OnboardingLayout.tapTarget,
                            height: OnboardingLayout.tapTarget,
                          ),
                          // Spec §2.1's glyph, so back means the same shape
                          // here as on every other header in the flow.
                          icon: const Icon(
                            Icons.arrow_back_rounded,
                            color: OnboardingColors.textOnBlue,
                            size: 22,
                          ),
                        ),
                ),
                Expanded(
                  child: Text(
                    'YOUR PRIVACY',
                    textAlign: TextAlign.center,
                    style: OnboardingTypography.anek(
                      size: 18,
                      weight: FontWeight.w800,
                      color: OnboardingColors.safetyYellow,
                      letterSpacing: 1,
                    ),
                  ),
                ),
                SizedBox(
                  width: OnboardingLayout.tapTarget,
                  child: Center(
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 6,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      // A WORD, not the flag emoji. The app bundles
                      // Latin-subset faces only, so a regional-indicator pair
                      // has no glyph of its own and fell through to whatever
                      // emoji font the ROM happened to ship — two tofu boxes
                      // on a device without one, in the header of the screen
                      // that has to look the most trustworthy in the app.
                      child: Text(
                        'INDIA',
                        style: OnboardingTypography.inter(
                          size: 9,
                          weight: FontWeight.w800,
                          letterSpacing: 0.6,
                          color: OnboardingColors.textOnBlue,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The kit's shield disc: a soft-blue 54x54 circle carrying the navy shield
/// outline, ON THE CANVAS.
///
/// Spec §3.5 asks for the disc and nothing else. The white card that used to
/// wrap it burned about 70dp of a DPDP gate screen that already has to scroll
/// to reach its 'I agree' tick — on a 320x568 handset at a large system font
/// that is the difference between the tick being on the page and being below
/// the fold.
class PrivacyShieldDisc extends StatelessWidget {
  const PrivacyShieldDisc({super.key});

  @override
  Widget build(BuildContext context) {
    return Align(
      child: Container(
        width: 54,
        height: 54,
        decoration: const BoxDecoration(
          color: OnboardingColors.shieldCircle,
          shape: BoxShape.circle,
        ),
        child: const Icon(
          Icons.shield_outlined,
          color: OnboardingColors.shiftBlue,
          size: 28,
        ),
      ),
    );
  }
}
