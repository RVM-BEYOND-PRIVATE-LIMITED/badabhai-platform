import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';

/// A custom on-screen 0–9 keypad + backspace — NO OS keyboard.
///
/// Built for gloved / low-literacy hands: every key is a large tap target
/// (≥64px, well over the 48px `--tap` floor), digits only, and a clear
/// backspace. The OS keyboard is deliberately avoided so the PIN entry surface
/// is consistent across every device and never shows a number row that could be
/// screen-recorded by an IME.
///
/// UI kit v3: white keys behind a `borderDefault` hairline at 1.2, the kit's
/// 14 radius, and the digits in Roboto Mono navy — spec §1.2 puts codes in mono.
/// The kit has no keypad of its own (its PIN screens use the OS keyboard); this
/// one exists for the security and literacy reasons above, so it is restyled
/// rather than replaced.
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

  /// One key's painted size. Kept from the JUL31 keypad: 80x64 is far above the
  /// 48dp floor, and the [FittedBox] in [_row] is what keeps it legal at 320dp.
  static const double keyWidth = 80;
  static const double keyHeight = 64;

  @override
  Widget build(BuildContext context) {
    // The keys are FIXED-SIZE tiles, so the digit on them is chrome, not copy:
    // it clamps at [OnboardingLayout.chromeMaxTextScale] like every other piece
    // of chrome (ruling R1). Unclamped, a 2.0 system font printed a 48px glyph
    // inside a 64px box that the 320dp [FittedBox] then shrank further — the
    // digits crowded their own tiles while telling the worker nothing more.
    // The PIN row above and the copy around it still scale the whole way.
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: Column(
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
            _BackspaceKey(onTap: enabled ? onBackspace : null),
          ]),
        ],
      ),
    );
  }

  Widget _digitKey(String digit) =>
      _DigitKey(digit: digit, onTap: enabled ? () => onDigit(digit) : null);

  // Three 80px keys plus their 12px side padding need 312, but a 320dp handset
  // inside the auth screens' 20px gutter offers 280 — a RenderFlex overflow
  // that CLIPPED THE BACKSPACE KEY (#1469), the one control the whole "fix a
  // wrong PIN" story depends on. scaleDown is inert at 360dp and above.
  Widget _row(List<Widget> keys) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: FittedBox(
      fit: BoxFit.scaleDown,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          for (final Widget key in keys)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: key,
            ),
        ],
      ),
    ),
  );
}

/// The shared key surface: a white 80x64 tile behind the kit's hairline, with
/// the press ink CLIPPED to the tile.
///
/// Its own [Material] is the load-bearing part. The keys used to be a bare
/// [InkResponse] with `radius: 48` over the SCAFFOLD's material, so a tap
/// painted a 48dp-radius circular splash in the theme's yellow that was never
/// bounded by the key: it washed across the background behind the neighbouring
/// keys and off the left edge of the screen. A locked-out worker's only screen
/// is not the place to look broken. The `Material` + matching `borderRadius` +
/// `clipBehavior` keep the splash inside the key it belongs to.
class _KeySurface extends StatelessWidget {
  const _KeySurface({required this.onTap, required this.child});

  final VoidCallback? onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final BorderRadius radius = BorderRadius.circular(OnboardingRadii.pinBox);
    return Material(
      color: OnboardingColors.paperWhite,
      borderRadius: radius,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        borderRadius: radius,
        child: Container(
          width: BbPinKeypad.keyWidth,
          height: BbPinKeypad.keyHeight,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: radius,
            border: Border.all(
              color: OnboardingColors.borderDefault,
              width: 1.2,
            ),
          ),
          child: child,
        ),
      ),
    );
  }
}

/// One large digit key. 80x64 painted — comfortably above the 48px floor.
class _DigitKey extends StatelessWidget {
  const _DigitKey({required this.digit, required this.onTap});

  final String digit;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return _KeySurface(
      onTap: onTap,
      child: Text(
        digit,
        style: OnboardingTypography.mono(
          size: 24,
          weight: FontWeight.w700,
          color: OnboardingColors.shiftBlue,
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
      // The SAME tile as the digits. It used to be a bare glyph on the canvas,
      // which gave the one key that fixes a mistyped PIN the weakest
      // affordance on the screen.
      child: _KeySurface(
        onTap: onTap,
        child: Icon(
          Icons.backspace_outlined,
          size: 24,
          color: onTap == null
              ? OnboardingColors.disabledText
              : OnboardingColors.ink600,
        ),
      ),
    );
  }
}

/// Empty cell to keep the 0/backspace row aligned under the grid.
class _KeySpacer extends StatelessWidget {
  const _KeySpacer();

  @override
  Widget build(BuildContext context) => const SizedBox(
    width: BbPinKeypad.keyWidth,
    height: BbPinKeypad.keyHeight,
  );
}
