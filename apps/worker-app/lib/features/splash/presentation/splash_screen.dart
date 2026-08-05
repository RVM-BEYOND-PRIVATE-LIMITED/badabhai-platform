import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../router.dart';

/// Splash + welcome — kit **01 Splash**: a deep-blue field with the centred
/// brand lockup (haldi 'BB' tile + 'BadaBhai' wordmark + tagline), the "no test,
/// just talk" promise, one haldi CTA, and the kit's haldi accent strip along the
/// bottom edge. Blue is the app's dark surface (design law §2), so the mark leads
/// with a haldi tile and a white wordmark rather than [BbLogo]'s blue squircle,
/// which would vanish here. No bare spinner-void — the brand carries the moment.
///
/// Deliberately DI-free and bloc-free (no API): it is the initial route, so
/// pumping the app in a widget test must not require the service locator.
///
/// The "bhasha first" language picker is HIDDEN FOR NOW (with the Settings
/// 'Bhasha' row). It wrote `X-Locale` but no translated strings existed behind
/// it, so picking मराठी changed nothing a worker could see — it offered a choice
/// the app could not honour. Every worker now keeps the [LocaleStore] default
/// (`hi`), so the `X-Locale` header is unchanged and the store stays wired.
/// Restore this together with real localization (i18n package + a translated
/// string registry) — see docs/registers/future-improvements.md.
class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.blue,
      body: SafeArea(
        child: Column(
          children: <Widget>[
            Expanded(
              child: Padding(
                padding:
                    const EdgeInsets.symmetric(horizontal: AppSpacing.gutter),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    const Spacer(flex: 3),
                    // Brand lockup — haldi tile with a deep-blue 'BB'.
                    Center(
                      child: Container(
                        width: 72,
                        height: 72,
                        decoration: BoxDecoration(
                          color: AppColors.haldi,
                          borderRadius: BorderRadius.circular(AppRadii.md),
                        ),
                        alignment: Alignment.center,
                        child: Text(
                          'BB',
                          style: AppTypography.display(
                            size: AppTypography.size2xl,
                            weight: FontWeight.w800,
                            color: AppColors.blue,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: AppSpacing.s4),
                    Text(
                      'BadaBhai',
                      textAlign: TextAlign.center,
                      style: AppTypography.display(
                        size: AppTypography.size2xl,
                        weight: FontWeight.w800,
                        color: AppColors.onBlue,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.s2),
                    // PERSONA: was 'Your placement bhai for factory jobs'. The
                    // brand name "Bada Bhai" is exempt from the vocative ban, but
                    // a bare `bhai` is not — and this line is the first copy a
                    // worker ever reads, so it sets the register. "team" keeps
                    // the meaning at the same length.
                    Text(
                      'Your placement team for factory jobs',
                      textAlign: TextAlign.center,
                      style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        color: AppColors.onBlueMuted,
                      ),
                    ),
                    const Spacer(flex: 2),
                    // The brand promise — no exam, just a chat. Haldi = josh.
                    Text(
                      'No test. Just talk.',
                      textAlign: TextAlign.center,
                      style: AppTypography.display(
                        size: AppTypography.sizeLg,
                        color: AppColors.haldi,
                      ),
                    ),
                    const Spacer(flex: 3),
                    BbButton(
                      label: 'Get started',
                      block: true,
                      iconRight: Icons.arrow_forward_rounded,
                      onPressed: () => context.go(Routes.phoneLogin),
                    ),
                    const SizedBox(height: AppSpacing.s6),
                  ],
                ),
              ),
            ),
            // Kit 01 — the haldi accent strip along the bottom edge.
            Container(height: 6, color: AppColors.haldi),
          ],
        ),
      ),
    );
  }
}
