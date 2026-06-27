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
/// "no test, just talk" promise, a "bhasha first" language selector, and one
/// green CTA.
///
/// Deliberately DI-free and bloc-free (no API): it is the initial route, so
/// pumping the app in a widget test must not require the service locator. The
/// language picker is **inert** — it tracks a local visual selection only. Real
/// localization (i18n package + persistence + a translated string registry) is
/// a separate deferred workstream; see docs/registers/future-improvements.md.
class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  /// The languages we will launch with, in native script (Devanagari renders via
  /// Baloo 2 / Mukta — both bundled, both carry the glyphs). English last.
  static const List<String> _languages = <String>[
    'हिंदी',
    'मराठी',
    'भोजपुरी',
    'English',
  ];

  /// Visual-only selection. Hindi-first. No persistence, no locale switch —
  /// nothing downstream reads this (the picker is inert by design).
  int _selected = 0;

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
          // "Bhasha first" — pick a language before starting. Inert for the alpha.
          _LanguagePicker(
            languages: _languages,
            selected: _selected,
            onSelect: (int i) => setState(() => _selected = i),
          ),
          const SizedBox(height: AppSpacing.s5),
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

/// Inert language selector: a row of native-script chips, single-select, visual
/// only. Tapping one updates [selected] via [onSelect] — nothing else.
class _LanguagePicker extends StatelessWidget {
  const _LanguagePicker({
    required this.languages,
    required this.selected,
    required this.onSelect,
  });

  final List<String> languages;
  final int selected;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        Text('भाषा चुनें · Choose language',
            style: AppTypography.eyebrow(color: AppColors.textMuted)),
        const SizedBox(height: AppSpacing.s3),
        Wrap(
          alignment: WrapAlignment.center,
          spacing: AppSpacing.s2,
          runSpacing: AppSpacing.s2,
          children: <Widget>[
            for (int i = 0; i < languages.length; i++)
              _LanguageChip(
                label: languages[i],
                selected: i == selected,
                onTap: () => onSelect(i),
              ),
          ],
        ),
      ],
    );
  }
}

class _LanguageChip extends StatelessWidget {
  const _LanguageChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final Color border = selected ? AppColors.brand : AppColors.borderDefault;
    final Color fill =
        selected ? AppColors.brandTint : AppColors.surfaceCard;
    final Color text =
        selected ? AppColors.brandPress : AppColors.textPrimary;

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppRadii.pill),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: AppSpacing.controlMd),
        child: Container(
          padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.s4, vertical: AppSpacing.s2),
          decoration: BoxDecoration(
            color: fill,
            borderRadius: BorderRadius.circular(AppRadii.pill),
            border: Border.all(color: border, width: selected ? 1.5 : 1),
          ),
          alignment: Alignment.center,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (selected) ...<Widget>[
                const Icon(Icons.check_rounded,
                    size: 16, color: AppColors.brandPress),
                const SizedBox(width: AppSpacing.s1),
              ],
              Text(
                label,
                style: AppTypography.display(
                  size: AppTypography.sizeMd,
                  weight: FontWeight.w700,
                  color: text,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
