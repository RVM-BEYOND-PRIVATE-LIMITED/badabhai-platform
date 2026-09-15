import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme/onboarding_theme.dart';

/// The docked bottom action bar (master spec §2.2): a white bar with a
/// hairline top border, an optional icon-only listen button, and the yellow
/// next button with a trailing arrow.
///
/// NO DEAD BUTTONS. The listen button renders only when [onListen] is given as
/// well as [isAudioSupported] — a screen with no audio behind it gets the bar
/// without a control that does nothing. [leading] replaces it entirely (e.g.
/// the name screen's Feedback pill).
///
/// [onNext] null renders the disabled state; [isLoading] shows a spinner.
///
/// [OnboardingVariant.formFlow] draws the form-flow mockups' bar: a paler
/// hairline, deeper padding, a 52dp button with 16dp corners and a larger
/// arrow, and a slightly smaller listen tile whose TAP area still spans the
/// button's full height.
class QuestionnaireBottomBar extends StatelessWidget {
  const QuestionnaireBottomBar({
    super.key,
    this.nextLabel = 'Aage badhein',
    required this.onNext,
    this.onListen,
    this.isAudioSupported = true,
    this.isLoading = false,
    this.showArrow = true,
    this.leading,
    this.nextKey,
    this.variant = OnboardingVariant.standard,
  });

  final String nextLabel;
  final VoidCallback? onNext;
  final VoidCallback? onListen;
  final bool isAudioSupported;
  final bool isLoading;
  final bool showArrow;
  final Widget? leading;

  /// Key on the next button, for tests.
  final Key? nextKey;

  final OnboardingVariant variant;

  @override
  Widget build(BuildContext context) {
    final bool form = variant == OnboardingVariant.formFlow;
    final bool enabled = onNext != null && !isLoading;
    final Color ink =
        enabled ? OnboardingColors.shiftBlue : OnboardingColors.disabledText;
    final Widget? left = leading ??
        (isAudioSupported && onListen != null
            ? (form
                ? _FormListenButton(onTap: onListen!)
                : _ListenButton(onTap: onListen!))
            : null);
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: Container(
        padding: EdgeInsets.only(
          left: 16,
          right: 16,
          top: form ? FormFlowLayout.bottomBarPaddingTop : 12,
          bottom: MediaQuery.paddingOf(context).bottom +
              (form ? FormFlowLayout.bottomBarPaddingBottom : 12),
        ),
        decoration: BoxDecoration(
          color: OnboardingColors.paperWhite,
          border: Border(
            top: BorderSide(
              color: form
                  ? FormFlowColors.bottomBarBorder
                  : OnboardingColors.borderDefault,
            ),
          ),
        ),
        child: Center(
          heightFactor: 1,
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: OnboardingLayout.maxContentWidth,
            ),
            child: Row(
              children: <Widget>[
                if (left != null) ...<Widget>[
                  left,
                  SizedBox(
                    width: form ? FormFlowLayout.listenToButtonGap : 10,
                  ),
                ],
                Expanded(
                  child: SizedBox(
                    height: form ? OnboardingLayout.buttonHeight : 48,
                    child: ElevatedButton(
                      key: nextKey,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: OnboardingColors.safetyYellow,
                        foregroundColor: OnboardingColors.shiftBlue,
                        disabledBackgroundColor: OnboardingColors.disabledBg,
                        disabledForegroundColor: OnboardingColors.disabledText,
                        elevation: 0,
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(
                            form ? FormFlowLayout.buttonRadius : 12,
                          ),
                        ),
                      ),
                      onPressed: enabled
                          ? () {
                              HapticFeedback.lightImpact();
                              onNext!();
                            }
                          : null,
                      child: isLoading
                          ? Semantics(
                              label: nextLabel,
                              child: const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2.5,
                                  color: OnboardingColors.shiftBlue,
                                ),
                              ),
                            )
                          : FittedBox(
                              fit: BoxFit.scaleDown,
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: <Widget>[
                                  Text(
                                    nextLabel,
                                    style: OnboardingTypography.buttonLabel(
                                      color: ink,
                                    ),
                                  ),
                                  if (showArrow) ...<Widget>[
                                    SizedBox(
                                      width: form
                                          ? FormFlowLayout.buttonArrowGap
                                          : 8,
                                    ),
                                    Icon(
                                      Icons.arrow_forward_rounded,
                                      size: form
                                          ? FormFlowLayout.buttonArrowSize
                                          : 20,
                                      color: ink,
                                    ),
                                  ],
                                ],
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

const String _kListenLabel = 'Sawaal sunein';
const IconData _kListenIcon = Icons.volume_up_outlined;

class _ListenButton extends StatelessWidget {
  const _ListenButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: _kListenLabel,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        // Mockup: a speaker glyph alone on a pale tile — no caption, so
        // nothing in the fixed 52x48 box can wrap at a large font size.
        child: Container(
          width: 52,
          height: 48,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: OnboardingColors.cardIconBg,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: OnboardingColors.borderSubtle, width: 1.2),
          ),
          child: const Icon(
            _kListenIcon,
            size: 22,
            color: OnboardingColors.shiftBlue,
          ),
        ),
      ),
    );
  }
}

/// The form-flow listen button: a [FormFlowLayout.listenWidth] x
/// [FormFlowLayout.listenHeight] tile. The painted tile is shorter than the
/// 48dp touch floor, so the TAP area is the full button-height box around it:
/// a tap on the tile itself is the ink well's (with its ripple clipped to the
/// tile); a tap just above or below it still reaches [onTap].
class _FormListenButton extends StatelessWidget {
  const _FormListenButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final BorderRadius radius = BorderRadius.circular(12);
    return Semantics(
      button: true,
      label: _kListenLabel,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: SizedBox(
          width: FormFlowLayout.listenWidth,
          height: OnboardingLayout.buttonHeight,
          child: Center(
            child: Material(
              color: OnboardingColors.cardIconBg,
              shape: RoundedRectangleBorder(
                borderRadius: radius,
                side: const BorderSide(
                  color: OnboardingColors.borderSubtle,
                  width: 1.2,
                ),
              ),
              child: InkWell(
                onTap: onTap,
                borderRadius: radius,
                child: const SizedBox(
                  width: FormFlowLayout.listenWidth,
                  height: FormFlowLayout.listenHeight,
                  child: Icon(
                    _kListenIcon,
                    size: 22,
                    color: OnboardingColors.shiftBlue,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
