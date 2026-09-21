import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme/app_theme.dart';
import '../../theme/onboarding_theme.dart';
import '../bottom_bar_inset.dart';
import '../kit/kit_square_icon_button.dart';

/// The docked bottom action bar (spec §2.2): a white bar with a hairline top
/// border, an optional listen tile, and the yellow next button with a trailing
/// arrow.
///
/// NO DEAD BUTTONS. The listen tile renders only when [onListen] is given AND
/// [isAudioSupported] — a screen with no audio behind it gets the bar without a
/// control that does nothing. [leading] replaces it entirely (e.g. the name
/// screen's Feedback pill).
///
/// [onNext] null renders the disabled state; [isLoading] shows a spinner.
///
/// It publishes its measured height to [bottomBarInset], so the app-wide
/// Feedback pill — which lives above the router's Navigator and cannot see this
/// page's bar — floats clear of it instead of covering the CTA.
///
/// [OnboardingVariant.formFlow] draws the form-flow mockups' bar: a paler
/// hairline, deeper padding, a 52dp button with 16dp corners and a larger
/// arrow, and a listen tile whose TAP area spans the button's full height.
class QuestionnaireBottomBar extends StatefulWidget {
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
    this.maxWidth = OnboardingLayout.maxContentWidth,
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

  /// Where the bar's INNER row stops and centres on a wide screen — the same
  /// width rule the body above it uses. A 440 docked Apply button under a 600
  /// list put a third left edge on one screen (see `ShiftBlueHeader.maxWidth`).
  final double maxWidth;

  @override
  State<QuestionnaireBottomBar> createState() => _QuestionnaireBottomBarState();
}

class _QuestionnaireBottomBarState extends State<QuestionnaireBottomBar> {
  final GlobalKey _barKey = GlobalKey();

  /// What this bar last published, so dispose only clears the inset while it is
  /// still OURS — a route pushed on top of us that published its own bar must
  /// not be reset to 0 by our teardown.
  double _published = 0;

  @override
  void initState() {
    super.initState();
    _publishInset();
  }

  @override
  void didUpdateWidget(QuestionnaireBottomBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    _publishInset();
  }

  @override
  void dispose() {
    final double mine = _published;
    // Deferred: dispose runs during tree finalization, and writing the listened
    // notifier synchronously here would markNeedsBuild the FAB overlay
    // mid-build. The closure touches only the global notifier.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (bottomBarInset.value == mine) bottomBarInset.value = 0;
    });
    super.dispose();
  }

  void _publishInset() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final double height = _barKey.currentContext?.size?.height ?? 0;
      _published = height;
      bottomBarInset.value = height;
    });
  }

  @override
  Widget build(BuildContext context) {
    final bool form = widget.variant == OnboardingVariant.formFlow;
    final bool enabled = widget.onNext != null && !widget.isLoading;
    final Color ink = enabled
        ? OnboardingColors.shiftBlue
        : OnboardingColors.disabledText;
    final Widget? left =
        widget.leading ??
        (widget.isAudioSupported && widget.onListen != null
            ? _ListenTile(onTap: widget.onListen!, form: form)
            : null);

    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: Container(
        key: _barKey,
        padding: EdgeInsets.only(
          left: 16,
          right: 16,
          top: form ? FormFlowLayout.bottomBarPaddingTop : 10,
          bottom:
              MediaQuery.paddingOf(context).bottom +
              (form ? FormFlowLayout.bottomBarPaddingBottom : 10),
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
            constraints: BoxConstraints(maxWidth: widget.maxWidth),
            child: Row(
              children: <Widget>[
                if (left != null) ...<Widget>[
                  left,
                  SizedBox(width: form ? FormFlowLayout.listenToButtonGap : 10),
                ],
                Expanded(
                  child: SizedBox(
                    height: form
                        ? OnboardingLayout.buttonHeight
                        : OnboardingLayout.dockedButtonHeight,
                    child: ElevatedButton(
                      key: widget.nextKey,
                      style: KitButtonStyles.primary.copyWith(
                        shape: WidgetStatePropertyAll<OutlinedBorder>(
                          RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(
                              form
                                  ? FormFlowLayout.buttonRadius
                                  : OnboardingRadii.docked,
                            ),
                          ),
                        ),
                        padding:
                            const WidgetStatePropertyAll<EdgeInsetsGeometry>(
                              EdgeInsets.symmetric(horizontal: 12),
                            ),
                      ),
                      onPressed: enabled
                          ? () {
                              HapticFeedback.lightImpact();
                              widget.onNext!();
                            }
                          : null,
                      child: widget.isLoading
                          ? Semantics(
                              label: widget.nextLabel,
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
                                    widget.nextLabel,
                                    style: OnboardingTypography.buttonLabel(
                                      color: ink,
                                    ),
                                  ),
                                  if (widget.showArrow) ...<Widget>[
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
const String _kListenCaption = 'SUNIE';

/// The listen tile: a speaker glyph over the SUNIE caption (spec §2.2).
///
/// The caption is what makes the tile READABLE to a worker who has never met an
/// icon-only speaker button — but it must not be what TalkBack says, so
/// [KitSquareIconButton] excludes it from semantics and announces the full
/// [_kListenLabel] sentence instead, and scales the pair down inside the fixed
/// tile so a large system font cannot reflow the bar.
///
/// In the form flow the painted tile is shorter than the button beside it, so
/// its 48dp+ tap box is centred in a full button-height column: a tap just
/// above or below the tile still reaches it.
class _ListenTile extends StatelessWidget {
  const _ListenTile({required this.onTap, required this.form});

  final VoidCallback onTap;
  final bool form;

  @override
  Widget build(BuildContext context) {
    if (!form) return _Tile(onTap: onTap);
    return SizedBox(
      width: FormFlowLayout.listenWidth,
      height: OnboardingLayout.buttonHeight,
      child: Center(child: _Tile(onTap: onTap)),
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({this.onTap});

  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return KitSquareIconButton(
      icon: Icons.volume_up_outlined,
      semanticLabel: _kListenLabel,
      caption: _kListenCaption,
      onTap: onTap,
      width: FormFlowLayout.listenWidth,
      height: OnboardingLayout.dockedButtonHeight,
    );
  }
}
