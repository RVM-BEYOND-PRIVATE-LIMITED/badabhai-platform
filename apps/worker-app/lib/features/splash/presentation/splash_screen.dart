import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_logo.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../router.dart';

/// Splash + welcome. Brand-forward, reassuring, low-text: the logo, the
/// "no test, just talk" promise, and one green CTA.
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
    return BbScaffold(
      body: Column(
        children: <Widget>[
          const Spacer(flex: 3),
          const BbLogo(size: 104, withWordmark: true),
          const SizedBox(height: AppSpacing.s4),
          Text(
            'Your placement bhai for factory jobs',
            textAlign: TextAlign.center,
            style: AppTypography.body(
              size: AppTypography.sizeMd,
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: AppSpacing.s3),
          // The brand promise — no exam, just a chat.
          Text(
            'No test. Just talk.',
            textAlign: TextAlign.center,
            style: AppTypography.display(
              size: AppTypography.sizeLg,
              color: AppColors.textBrand,
            ),
          ),
          const Spacer(flex: 4),
          BbButton(
            label: 'Get started',
            block: true,
            iconRight: Icons.arrow_forward_rounded,
            onPressed: () => context.go(Routes.phoneLogin),
          ),
          const SizedBox(height: AppSpacing.s8),
        ],
      ),
    );
  }
}
