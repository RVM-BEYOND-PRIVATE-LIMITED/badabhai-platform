import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/onboarding/primary_action_button.dart';

/// "Get started" in English and the languages of India, in the order the
/// splash CTA rolls through them. English FIRST: it is what the worker sees
/// the moment the button lands, and what TalkBack always reads.
const List<String> kGetStartedLabels = <String>[
  'Get started', // English
  'शुरू करें', // Hindi
  'सुरू करा', // Marathi
  'ప్రారంభించండి', // Telugu
  'தொடங்குங்கள்', // Tamil
  'ಪ್ರಾರಂಭಿಸಿ', // Kannada
  'ആരംഭിക്കുക', // Malayalam
  'শুরু করুন', // Bengali
  'શરૂ કરો', // Gujarati
  'ਸ਼ੁਰੂ ਕਰੋ', // Punjabi
  'ଆରମ୍ଭ କରନ୍ତୁ', // Odia
  'আৰম্ভ কৰক', // Assamese
  'شروع کریں', // Urdu
];

/// How long English holds before the roll starts, and how long every other
/// language holds. English stays a little longer: it is the app's own word.
const Duration kGetStartedEnglishHold = Duration(milliseconds: 2400);
const Duration kGetStartedLanguageHold = Duration(milliseconds: 1600);

/// The splash's "Get started" CTA, animated (CEO ask):
///
///  - it RISES into place as the splash opens (slide up, fade, scale);
///  - its label ROLLS through [kGetStartedLabels] — each language slides up
///    out of the button as the next slides up into it;
///  - every new language sends a light SHINE across the yellow and bumps the
///    arrow forward.
///
/// It is the kit's [PrimaryActionButton] underneath, so size, colour, haptic
/// and the disabled shade are the same as every other CTA. No shadow or glow
/// (the locked design has none).
///
/// With the phone's "remove animations" setting on, it is the plain English
/// button: no roll, no shine. TalkBack always hears "Get started", never the
/// moving label.
class AnimatedGetStartedButton extends StatefulWidget {
  const AnimatedGetStartedButton({super.key, required this.onPressed});

  final VoidCallback onPressed;

  @override
  State<AnimatedGetStartedButton> createState() =>
      _AnimatedGetStartedButtonState();
}

class _AnimatedGetStartedButtonState extends State<AnimatedGetStartedButton>
    with TickerProviderStateMixin {
  late final AnimationController _entrance = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 750),
  );
  late final AnimationController _shine = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );

  Timer? _roll;
  int _index = 0;
  bool _still = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final bool still = MediaQuery.disableAnimationsOf(context);
    if (still == _still && (_roll != null || still)) return;
    _still = still;
    _roll?.cancel();
    _roll = null;
    if (still) {
      _index = 0;
      _entrance.value = 1;
      _shine.value = 0;
      return;
    }
    if (_entrance.value == 0) unawaited(_entrance.forward());
    _schedule(kGetStartedEnglishHold);
  }

  void _schedule(Duration hold) {
    _roll = Timer(hold, () {
      if (!mounted) return;
      setState(() => _index = (_index + 1) % kGetStartedLabels.length);
      unawaited(_shine.forward(from: 0));
      _schedule(_index == 0 ? kGetStartedEnglishHold : kGetStartedLanguageHold);
    });
  }

  @override
  void dispose() {
    _roll?.cancel();
    _entrance.dispose();
    _shine.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Animation<double> rise = CurvedAnimation(
      parent: _entrance,
      curve: Curves.easeOutBack,
    );
    final Animation<double> fade = CurvedAnimation(
      parent: _entrance,
      curve: const Interval(0, 0.6, curve: Curves.easeOut),
    );
    return Semantics(
      button: true,
      label: kGetStartedLabels.first,
      excludeSemantics: true,
      child: FadeTransition(
        opacity: fade,
        child: AnimatedBuilder(
          animation: rise,
          builder: (BuildContext context, Widget? child) => Transform.translate(
            offset: Offset(0, 28 * (1 - rise.value)),
            child: Transform.scale(
              scale: 0.92 + 0.08 * rise.value,
              child: child,
            ),
          ),
          child: _button(),
        ),
      ),
    );
  }

  Widget _button() {
    return AnimatedBuilder(
      animation: _shine,
      builder: (BuildContext context, _) {
        // The arrow bumps forward and back once per new language.
        final double bump = math.sin(math.pi * _shine.value) * 5;
        return Stack(
          children: <Widget>[
            PrimaryActionButton(
              label: kGetStartedLabels.first,
              onPressed: widget.onPressed,
              arrowOffset: Offset(bump, 0),
              labelChild: _RollingLabel(text: kGetStartedLabels[_index]),
            ),
            if (_shine.isAnimating) _Shine(progress: _shine.value),
          ],
        );
      },
    );
  }
}

/// The label: each new language slides UP into the button while the old one
/// slides up and out, and the button's width eases to fit it.
class _RollingLabel extends StatelessWidget {
  const _RollingLabel({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return AnimatedSize(
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeOutCubic,
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 450),
        switchInCurve: Curves.easeOutCubic,
        switchOutCurve: Curves.easeInCubic,
        layoutBuilder: (Widget? current, List<Widget> previous) => Stack(
          alignment: Alignment.center,
          clipBehavior: Clip.none,
          children: <Widget>[...previous, ?current],
        ),
        transitionBuilder: (Widget child, Animation<double> animation) {
          final bool incoming = child.key == ValueKey<String>(text);
          final Animation<Offset> slide = Tween<Offset>(
            begin: incoming ? const Offset(0, 0.9) : const Offset(0, -0.9),
            end: Offset.zero,
          ).animate(animation);
          return ClipRect(
            child: SlideTransition(
              position: slide,
              child: FadeTransition(
                opacity: animation,
                child: ScaleTransition(
                  scale: Tween<double>(begin: 0.85, end: 1).animate(animation),
                  child: child,
                ),
              ),
            ),
          );
        },
        child: Text(
          text,
          key: ValueKey<String>(text),
          maxLines: 1,
          style: OnboardingTypography.buttonLabel(),
        ),
      ),
    );
  }
}

/// A soft white band sweeping left to right across the yellow, clipped to the
/// button's corners. Paint only — it never takes a tap.
class _Shine extends StatelessWidget {
  const _Shine({required this.progress});

  final double progress;

  @override
  Widget build(BuildContext context) {
    return Positioned.fill(
      child: IgnorePointer(
        child: ClipRRect(
          borderRadius: const BorderRadius.all(
            Radius.circular(OnboardingRadii.button),
          ),
          child: LayoutBuilder(
            builder: (BuildContext context, BoxConstraints box) {
              final double band = box.maxWidth * 0.35;
              final double left =
                  -band +
                  (box.maxWidth + band) * Curves.easeInOut.transform(progress);
              return Stack(
                children: <Widget>[
                  Positioned(
                    left: left,
                    top: 0,
                    bottom: 0,
                    width: band,
                    child: Transform(
                      transform: Matrix4.skewX(-0.35),
                      child: const DecoratedBox(
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            colors: <Color>[
                              Color(0x00FFFFFF),
                              Color(0x8CFFFFFF),
                              Color(0x00FFFFFF),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}
