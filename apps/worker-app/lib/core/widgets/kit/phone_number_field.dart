import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../auth/phone_format.dart';
import '../../theme/onboarding_theme.dart';

/// The phone input (spec §3.2): a 54dp white box with a fixed `+91`, a hairline
/// divider, then the digits in tabular mono.
///
/// The dial code is drawn BESIDE the field, never inside its controller, so it
/// cannot be selected, backspaced away, or sent twice. The field itself holds
/// digits only, capped at [kNationalNumberDigits] — so there is nothing to
/// strip and nothing malformed can reach the E.164 boundary.
///
/// A FOCUSED field rings navy at 1.8 (spec §3.3's one focus rule), not yellow:
/// yellow means SELECTED in v3, and an input is never "selected".
class PhoneNumberField extends StatelessWidget {
  const PhoneNumberField({
    super.key,
    required this.controller,
    required this.focusNode,
    this.autofocus = false,
    this.fieldKey,
    this.semanticLabel,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final bool autofocus;
  final Key? fieldKey;

  /// The persistent accessible name — TalkBack has nothing else to call this
  /// box once the hint is hidden behind typed digits.
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    // The border colour depends on focus, so the box has to REBUILD when focus
    // changes — reading `focusNode.hasFocus` in build alone would leave the
    // ring stale until something else happened to rebuild the screen.
    return ListenableBuilder(
      listenable: focusNode,
      builder: (BuildContext context, _) {
        final bool focused = focusNode.hasFocus;
        return GestureDetector(
          // The whole box is the target, not only the text run inside it.
          onTap: focusNode.requestFocus,
          child: Container(
            height: 54,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: BoxDecoration(
              color: OnboardingColors.paperWhite,
              borderRadius: BorderRadius.circular(OnboardingRadii.phoneField),
              border: Border.all(
                color: focused
                    ? OnboardingColors.shiftBlue
                    : OnboardingColors.borderDefault,
                width: focused ? 1.8 : 1.2,
              ),
            ),
            child: MediaQuery.withClampedTextScaling(
              maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
              child: Row(
                children: <Widget>[
                  Text(
                    kIndiaDialCode,
                    style: OnboardingTypography.subheadBold(
                      color: OnboardingColors.shiftBlue,
                    ),
                  ),
                  Container(
                    width: 1,
                    height: 24,
                    margin: const EdgeInsets.symmetric(horizontal: 14),
                    color: OnboardingColors.borderDefault,
                  ),
                  Expanded(
                    child: Semantics(
                      label: semanticLabel,
                      textField: true,
                      child: TextField(
                        key: fieldKey,
                        controller: controller,
                        focusNode: focusNode,
                        autofocus: autofocus,
                        keyboardType: TextInputType.phone,
                        autofillHints: const <String>[
                          AutofillHints.telephoneNumberNational,
                        ],
                        style: OnboardingTypography.mono(
                          size: 16,
                          weight: FontWeight.w600,
                          color: OnboardingColors.ink900,
                        ),
                        inputFormatters: <TextInputFormatter>[
                          FilteringTextInputFormatter.digitsOnly,
                          LengthLimitingTextInputFormatter(
                            kNationalNumberDigits,
                          ),
                        ],
                        decoration: InputDecoration(
                          hintText: 'XXXXXXXXXX',
                          hintStyle: OnboardingTypography.mono(
                            size: 16,
                            weight: FontWeight.w600,
                            color: OnboardingColors.ink500,
                          ),
                          counterText: '',
                          filled: false,
                          isCollapsed: true,
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
