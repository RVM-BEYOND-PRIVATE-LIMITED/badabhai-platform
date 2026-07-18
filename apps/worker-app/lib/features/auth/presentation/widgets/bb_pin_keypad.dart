import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';

/// A custom on-screen 0–9 keypad + backspace — NO OS keyboard.
///
/// Built for gloved / low-literacy hands: every key is a large tap target
/// (≥64px, well over the 48px `--tap` floor), digits only, and a clear
/// backspace. The OS keyboard is deliberately avoided so the PIN entry surface
/// is consistent across every device and never shows a number row that could be
/// screen-recorded by an IME.
///
/// SECURITY: this widget is STATELESS over the PIN — it only emits key events
/// ([onDigit] / [onBackspace]). The PIN value is assembled and held by the
/// parent screen's local state; nothing here stores, logs, or echoes a digit.
class BbPinKeypad extends StatelessWidget {
  const BbPinKeypad({
    super.key,
    required this.onDigit,
    required this.onBackspace,
    this.enabled = true,
  });

  /// Fired with the tapped digit ('0'–'9').
  final ValueChanged<String> onDigit;

  /// Fired when backspace is tapped (parent drops the last digit).
  final VoidCallback onBackspace;

  /// When false (e.g. PIN locked), every key is inert.
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        for (final List<String> row in const <List<String>>[
          <String>['1', '2', '3'],
          <String>['4', '5', '6'],
          <String>['7', '8', '9'],
        ])
          _row(row.map(_digitKey).toList()),
        _row(<Widget>[
          const _KeySpacer(),
          _digitKey('0'),
          _BackspaceKey(
            onTap: enabled ? onBackspace : null,
          ),
        ]),
      ],
    );
  }

  Widget _digitKey(String digit) => _DigitKey(
        digit: digit,
        onTap: enabled ? () => onDigit(digit) : null,
      );

  Widget _row(List<Widget> keys) => Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.s1),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            for (final Widget key in keys)
              Padding(
                padding:
                    const EdgeInsets.symmetric(horizontal: AppSpacing.s3),
                child: key,
              ),
          ],
        ),
      );
}

/// One large digit key. 72px target — comfortably above the 48px floor.
class _DigitKey extends StatelessWidget {
  const _DigitKey({required this.digit, required this.onTap});

  final String digit;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return InkResponse(
      onTap: onTap,
      radius: AppSpacing.s9,
      child: Container(
        width: AppSpacing.s11, // 80
        height: AppSpacing.s10, // 64
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: AppColors.surfaceCard,
          borderRadius: BorderRadius.circular(AppRadii.lg),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        child: Text(
          digit,
          style: AppTypography.display(
            size: AppTypography.size2xl,
            weight: FontWeight.w700,
          ),
        ),
      ),
    );
  }
}

/// TalkBack label for the icon-only backspace key (#375).
const String kBackspaceSemanticLabel = 'Aakhri digit hatayein';

class _BackspaceKey extends StatelessWidget {
  const _BackspaceKey({required this.onTap});

  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    // #375 — the digit keys are announced because they carry text; this one is a
    // bare Icon, so TalkBack read only "button". A worker who mistyped a digit
    // could not find the key to correct it and drove into the PIN lockout — on
    // the auth path, on a keypad whose whole reason for existing is low-literacy
    // accessibility.
    return Semantics(
      button: true,
      label: kBackspaceSemanticLabel,
      child: InkResponse(
        onTap: onTap,
        radius: AppSpacing.s9,
        child: SizedBox(
          width: AppSpacing.s11,
          height: AppSpacing.s10,
          child: Icon(
            Icons.backspace_outlined,
            size: AppSpacing.s6,
            color: onTap == null ? AppColors.textFaint : AppColors.textSecondary,
          ),
        ),
      ),
    );
  }
}

/// Empty cell to keep the 0/backspace row aligned under the grid.
class _KeySpacer extends StatelessWidget {
  const _KeySpacer();

  @override
  Widget build(BuildContext context) =>
      const SizedBox(width: AppSpacing.s11, height: AppSpacing.s10);
}
