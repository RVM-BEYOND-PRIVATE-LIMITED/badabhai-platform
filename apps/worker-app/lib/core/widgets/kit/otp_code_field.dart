import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme/onboarding_theme.dart';

/// Builds the caret for the cell being typed into, given the height it may
/// occupy. Null → the active cell's navy ring IS the caret.
///
/// Injected rather than imported: the blinking caret and its
/// `debugDeterministicCaret` freeze live with the PIN widgets, and a core kit
/// widget must not reach into a feature to draw itself. A caller that wants the
/// blink passes it; this field works without one.
typedef OtpCaretBuilder = Widget Function(double height);

/// The segmented OTP entry (spec §3.3): [length] painted cells with ONE real
/// [TextField] laid invisibly over them.
///
/// **Six real fields is the obvious build and the wrong one.** SMS auto-read
/// and iOS `oneTimeCode` autofill deliver the whole code to a single field; a
/// worker pasting a code copied out of their SMS app has one place to drop it,
/// not six; and TalkBack would announce six disconnected "edit box"es to
/// exactly the worker who cannot read the screen to work out what they mean.
///
/// So the cells are pure decoration — [ExcludeSemantics], never hit-tested —
/// and the field on top keeps the real keyboard, the selection/paste menu,
/// autofill and a single semantics node. Its text is drawn transparent (not
/// zero-sized: a collapsed field cannot be tapped or long-pressed) and the
/// cells below render the digits.
///
/// The spec draws six 48x54 boxes. They are sized from the width actually
/// available instead — full size wherever they fit, proportionally smaller on a
/// 320dp handset — so the row can never overflow.
class OtpCodeField extends StatelessWidget {
  const OtpCodeField({
    super.key,
    required this.controller,
    required this.focusNode,
    this.autofocus = true,
    this.length = 6,
    this.semanticLabel,
    this.fieldKey,
    this.caretBuilder,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final bool autofocus;
  final int length;

  /// Defaults to 'SMS code, N digits'.
  final String? semanticLabel;
  final Key? fieldKey;
  final OtpCaretBuilder? caretBuilder;

  /// Painted cell width at full size (spec §3.3).
  static const double cellWidth = 48;

  /// Painted cell height at full size (spec §3.3).
  static const double cellHeight = 54;

  static const double _gap = 6;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double boxWidth = math.min(
          cellWidth,
          (constraints.maxWidth - _gap * (length - 1)) / length,
        );
        final double boxHeight = boxWidth * cellHeight / cellWidth;
        return SizedBox(
          height: boxHeight,
          child: Stack(
            children: <Widget>[
              Positioned.fill(
                child: ExcludeSemantics(
                  child: ListenableBuilder(
                    listenable: Listenable.merge(<Listenable>[
                      controller,
                      focusNode,
                    ]),
                    child: const SizedBox.shrink(),
                    builder: (BuildContext context, _) => _OtpCells(
                      code: controller.text,
                      focused: focusNode.hasFocus,
                      length: length,
                      boxWidth: boxWidth,
                      boxHeight: boxHeight,
                      caretBuilder: caretBuilder,
                    ),
                  ),
                ),
              ),
              Positioned.fill(
                // MergeSemantics collapses the label into the field's own node,
                // so TalkBack reads one "SMS code, 6 digits, edit box" instead
                // of a stray label followed by an unnamed box.
                child: MergeSemantics(
                  child: Semantics(
                    label: semanticLabel ?? 'SMS code, $length digits',
                    child: TextField(
                      key: fieldKey,
                      controller: controller,
                      focusNode: focusNode,
                      // Single-purpose screen: the worker arrives to type one
                      // thing, so the keyboard is up without a hunt.
                      autofocus: autofocus,
                      keyboardType: TextInputType.number,
                      textAlign: TextAlign.center,
                      textAlignVertical: TextAlignVertical.center,
                      // Digits only, capped at the length the API mints — so a
                      // pasted "Your OTP is 123456" cannot land as-is, and a
                      // stray 7th digit cannot push the code out of range.
                      inputFormatters: <TextInputFormatter>[
                        FilteringTextInputFormatter.digitsOnly,
                        LengthLimitingTextInputFormatter(length),
                      ],
                      // iOS surfaces the SMS code above the keyboard natively.
                      // Android ignores this unless an autofill service handles
                      // SMS OTP, which is why the real Android path is the
                      // Play Services User Consent reader.
                      autofillHints: const <String>[AutofillHints.oneTimeCode],
                      // Long-press → Paste stays alive; it is how a worker who
                      // switched to the SMS app gets the code back here.
                      enableInteractiveSelection: true,
                      // The caret would sit at the centre of the row, nowhere
                      // near the cell being filled.
                      showCursor: false,
                      cursorColor: Colors.transparent,
                      style: OnboardingTypography.otpDigit(
                        color: Colors.transparent,
                      ),
                      decoration: const InputDecoration(
                        counterText: '',
                        filled: false,
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        contentPadding: EdgeInsets.zero,
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// The painted OTP cells. Decoration only — handed the code the real field
/// already holds, and it never owns or mutates it.
class _OtpCells extends StatelessWidget {
  const _OtpCells({
    required this.code,
    required this.focused,
    required this.length,
    required this.boxWidth,
    required this.boxHeight,
    required this.caretBuilder,
  });

  /// The digits typed so far. NOT persisted, NOT logged, NOT put in cubit
  /// state: a one-time code in an error dump is a credential.
  final String code;

  /// Whether the real field has focus — only then does a cell show the ring.
  final bool focused;
  final int length;
  final double boxWidth;
  final double boxHeight;
  final OtpCaretBuilder? caretBuilder;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: <Widget>[for (int i = 0; i < length; i++) _cell(i)],
    );
  }

  Widget _cell(int index) {
    final bool filled = index < code.length;
    // The next empty box is the one being typed into; once the code is full the
    // ring stays on the last box rather than vanishing off the end.
    final bool active =
        focused && index == (code.length >= length ? length - 1 : code.length);
    final OtpCaretBuilder? caret = caretBuilder;

    final Widget? child;
    if (filled) {
      child = FittedBox(
        fit: BoxFit.scaleDown,
        child: Text(code[index], style: OnboardingTypography.otpDigit()),
      );
    } else if (active && caret != null) {
      child = caret(boxHeight * 0.45);
    } else {
      child = null;
    }

    return Container(
      width: boxWidth,
      height: boxHeight,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: OnboardingColors.paperWhite,
        borderRadius: BorderRadius.circular(OnboardingRadii.otpBox),
        border: Border.all(
          // Spec §3.3: the focused cell rings NAVY at 1.8. Yellow is reserved
          // for a selected card or chip.
          color: active
              ? OnboardingColors.shiftBlue
              : OnboardingColors.borderDefault,
          width: active ? 1.8 : 1.2,
        ),
      ),
      child: child,
    );
  }
}
