import 'package:flutter/material.dart';

import '../theme/onboarding_theme.dart';

/// Centered icon + title + (optional) subtitle + (optional) action — the shared
/// empty / error / consent layout, plus a [BbStatusView.loading] spinner mode.
///
/// The glyph sits in a 54dp pale-blue disc (spec §3.5's shield circle), so an
/// empty state reads as a deliberate piece of the design rather than a stray
/// grey icon floating on the canvas. An error tone swaps the disc to the error
/// tint.
///
/// **It scrolls.** A status view is the whole body of its screen, and a two-line
/// title plus a subtitle plus a button at a 2.0 text scale is taller than a
/// 568dp handset — this used to overflow rather than scroll. The content is
/// still vertically centred whenever there is room.
///
/// The centring is `Center` OUTSIDE the scroll view, deliberately — see
/// [build].
class BbStatusView extends StatelessWidget {
  const BbStatusView({
    super.key,
    required IconData this.icon,
    required String this.title,
    this.iconColor = OnboardingColors.shiftBlue,
    this.subtitle,
    this.action,
  }) : caption = null,
       _loading = false;

  /// Spinner mode: a centered [CircularProgressIndicator] with an optional
  /// [caption] beneath it.
  const BbStatusView.loading({super.key, this.caption})
    : icon = null,
      title = null,
      iconColor = OnboardingColors.shiftBlue,
      subtitle = null,
      action = null,
      _loading = true;

  final IconData? icon;
  final String? title;

  /// The glyph's colour. Also tints the disc behind it: an error red glyph gets
  /// the error tint, anything else the informational blue.
  final Color iconColor;
  final String? subtitle;
  final Widget? action;

  /// Optional text shown under the spinner in loading mode.
  final String? caption;

  final bool _loading;

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            // A branded navy ring, never a naked default-Material spinner.
            // Where a step count is known prefer BbProgressBar (determinate).
            const CircularProgressIndicator(
              color: OnboardingColors.shiftBlue,
              strokeWidth: 2.5,
            ),
            if (caption != null) ...<Widget>[
              const SizedBox(height: 16),
              Text(
                caption!,
                textAlign: TextAlign.center,
                style: OnboardingTypography.bodyMuted(),
              ),
            ],
          ],
        ),
      );
    }

    final bool isError = iconColor == OnboardingColors.errorRed;
    // CENTRE OUTSIDE, SCROLL INSIDE — and NO `LayoutBuilder`.
    //
    // `Center` sizes the scroll view to the content when there is room (so the
    // block is exactly centred, as it always was) and to the available height
    // when there is not (so it scrolls instead of overflowing at a 2.0 text
    // scale).
    //
    // A `LayoutBuilder` here reads the viewport height, which looks like the
    // same thing and is not: several hosts ask this widget for an INTRINSIC
    // height — `SliverFillRemaining(hasScrollBody: false)` does, on the job
    // search screen — and a LayoutBuilder cannot answer that ("LayoutBuilder
    // does not support returning intrinsic dimensions"), so the whole screen
    // was replaced by an error box. Keep this subtree intrinsic-safe.
    return Center(
      child: SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Container(
                width: 54,
                height: 54,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: isError
                      ? OnboardingColors.errorBg
                      : OnboardingColors.infoBg,
                  shape: BoxShape.circle,
                ),
                child: Icon(icon, size: 26, color: iconColor),
              ),
              const SizedBox(height: 16),
              Text(
                title!,
                textAlign: TextAlign.center,
                style: OnboardingTypography.anek(
                  size: 18,
                  weight: FontWeight.w700,
                ),
              ),
              if (subtitle != null) ...<Widget>[
                const SizedBox(height: 8),
                Text(
                  subtitle!,
                  textAlign: TextAlign.center,
                  style: OnboardingTypography.bodyMuted(),
                ),
              ],
              if (action != null) ...<Widget>[
                const SizedBox(height: 24),
                action!,
              ],
            ],
          ),
        ),
      ),
    );
  }
}
