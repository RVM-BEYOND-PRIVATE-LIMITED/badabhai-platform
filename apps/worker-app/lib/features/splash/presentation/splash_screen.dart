import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../router.dart';

/// The splash artwork. It already carries the logo, the `BADABHAI` wordmark,
/// the `SAB HOJAYEGA` tagline and the handshake — only the button is Flutter.
const String kSplashImageAsset = 'assets/fonts/image/screen.png';

/// Stable finder for the splash artwork in tests.
const Key kSplashImageKey = Key('splash_image');

/// Splash + welcome — onboarding kit **Screen 1**: the full-screen splash
/// artwork with the yellow "Get started" CTA docked at the bottom.
///
/// The image is painted edge to edge (behind the status bar) with
/// [BoxFit.fill], over the kit's shift-blue — the artwork's own background
/// colour — so any area the image does not cover blends in. The button sits
/// inside the safe area, 20px from the edges, capped at the kit's content width
/// on tablets.
///
/// Deliberately DI-free and bloc-free (no API): it is the initial route, so
/// pumping the app in a widget test must not require the service locator.
class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: OnboardingColors.shiftBlue,
      body: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          Image.asset(
            kSplashImageAsset,
            key: kSplashImageKey,
            fit: BoxFit.fill,
            // The brand words live inside the image, so say them to TalkBack.
            semanticLabel: 'BadaBhai. Sab hojayega.',
          ),
          Align(
            alignment: Alignment.bottomCenter,
            child: SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    maxWidth: OnboardingLayout.maxContentWidth,
                  ),
                  child: PrimaryActionButton(
                    label: 'Get started',
                    onPressed: () => context.go(Routes.phoneLogin),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
