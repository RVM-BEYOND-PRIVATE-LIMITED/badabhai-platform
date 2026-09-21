import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme/onboarding_theme.dart';
import 'brand_badge.dart';

/// The viewport height, in the CHROME's own units, below which a header should
/// drop to its collapsed drawing.
///
/// 520 rather than the screen sizes in the matrix, because the comparison is
/// made in chrome units: a 320x568 handset at a 2.0 system font has as much
/// room for a header as a 437dp one at 100%, and that is the case where the
/// full drawing (badge row + step line + title + subtitle) ate 47-58% of the
/// screen and left no answer control above the fold.
const double _kCrowdedViewportHeight = 520;

/// An arbitrary font size used only to read the effective text scale back out
/// of a [TextScaler], which exposes no factor of its own.
const double _kScaleProbe = 100;

/// Whether the space left for a screen's BODY is short enough that the header
/// should give its context rows back — the keyboard being up on a small phone,
/// a landscape handset, or a short screen at a large system font.
///
/// Read off the WINDOW, not `MediaQuery`. A [Scaffold] with the default
/// `resizeToAvoidBottomInset` strips `viewInsets.bottom` from its body and just
/// hands it a shorter box — and these headers always sit in a Scaffold body, so
/// a MediaQuery reading of the keyboard inset there is always 0 and
/// auto-compact would be dead code that looked alive.
///
/// The height is then divided by the CHROME text scale (the clamped one, since
/// that is what the header is actually drawn at), because a header's cost in dp
/// grows with the font while the screen does not.
bool chromeCrowdsViewport(BuildContext context) {
  final ui.FlutterView view = View.of(context);
  final double dpr = view.devicePixelRatio;
  if (dpr <= 0) return false;
  final double keyboard = view.viewInsets.bottom / dpr;
  final double height = view.physicalSize.height / dpr - keyboard;
  if (height <= 0) return true;
  final double scale =
      MediaQuery.textScalerOf(context)
          .clamp(maxScaleFactor: OnboardingLayout.chromeMaxTextScale)
          .scale(_kScaleProbe) /
      _kScaleProbe;
  if (scale <= 0) return height < _kCrowdedViewportHeight;
  return height / scale < _kCrowdedViewportHeight;
}

/// The Shift Blue header (spec §2.1): a full-bleed navy band carrying the
/// status-bar inset; a top row with the back arrow and the BadaBhai lockup; an
/// optional uppercase STEP badge; then the white Anek title and an optional
/// muted subtitle.
///
/// This is the header for every PUSHED or AUTH screen — detail, search, edit,
/// settings, PIN, onboarding. A tab root (Jobs / Resume / Profile) has no back
/// arrow and no brand badge, so it uses `KitTabHeader` instead.
///
/// Kept beyond the spec's sketch, because the sketch is one 390x844 artboard
/// and this ships on everything:
///
///  - text scaling clamps at [OnboardingLayout.chromeMaxTextScale] (an
///    unclamped two-line subtitle at 200% font ate most of a small phone);
///  - the inner column caps at [OnboardingLayout.maxContentWidth] and centres
///    on tablets and in landscape;
///  - [compact] / [autoCompact] drop the badge row when vertical space is the
///    scarce thing — see [autoCompact].
///
/// [OnboardingVariant.formFlow] draws the form-flow mockups' header: a 20dp
/// gutter, a lower top row, a more spaced slate STEP line and a deeper bottom.
/// The brand lockup ([BrandBadge]) is the SAME on every variant — the owner
/// removed its pill and made it one global drawing. Every other screen keeps
/// the standard header drawing.
class ShiftBlueHeader extends StatelessWidget {
  const ShiftBlueHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.stepBadge,
    this.onBack,
    this.showBrandBadge = true,
    this.trailing,
    this.actions = const <Widget>[],
    this.titleColor = OnboardingColors.textOnBlue,
    this.variant = OnboardingVariant.standard,
    this.compact = false,
    this.autoCompact = true,
    this.maxWidth = OnboardingLayout.maxContentWidth,
  });

  final String title;
  final String? subtitle;

  /// e.g. "Step 2 of 6" — rendered uppercase above the title.
  final String? stepBadge;

  /// Draws the back arrow when non-null: a 22dp glyph on the header's gutter
  /// inside a 48dp tap target.
  final VoidCallback? onBack;
  final bool showBrandBadge;

  /// Replaces the brand badge on the right of the top row when non-null (e.g.
  /// a Feedback link on a screen that owns one). [actions] supersedes it.
  final Widget? trailing;

  /// Trailing controls, each already a 48dp hit box. A superset of [trailing];
  /// when both are given, [actions] wins.
  final List<Widget> actions;

  /// The title colour. White by default; the form flow's question screens use
  /// safety yellow.
  final Color titleColor;

  final OnboardingVariant variant;

  /// Drops the brand-badge row: the back arrow and the title share one row and
  /// the subtitle is capped at one line. For a screen that needs its vertical
  /// space back.
  final bool compact;

  /// Renders [compact] BY ITSELF once the viewport is short enough that the
  /// full drawing would leave the body a sliver — see [chromeCrowdsViewport].
  /// Set false to pin the full drawing.
  final bool autoCompact;

  /// Where the header's INNER row stops and centres on a wide screen.
  ///
  /// It must match the width rule of the body underneath, or one screen shows
  /// two left edges: a 440 navy title over a 600 list read as an 80dp step on
  /// each side at 768x1024. Form and auth screens keep 440; a screen whose body
  /// is a 600 list passes [OnboardingLayout.maxTabContentWidth].
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    final double top = MediaQuery.paddingOf(context).top;
    final bool form = variant == OnboardingVariant.formFlow;
    // The form flow's header is its own drawing; it does not collapse.
    final bool dense =
        !form && (compact || (autoCompact && chromeCrowdsViewport(context)));
    final double side = form ? FormFlowLayout.gutter : 16;

    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: MediaQuery.withClampedTextScaling(
        maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
        child: Container(
          width: double.infinity,
          color: OnboardingColors.shiftBlue,
          padding: EdgeInsets.only(
            top: top + (form ? FormFlowLayout.headerTopPadding : 8),
            bottom: form
                ? FormFlowLayout.headerBottomPadding
                : (dense ? 12 : 18),
            left: side,
            right: side,
          ),
          child: Align(
            alignment: Alignment.topCenter,
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: maxWidth),
              child: dense ? _buildDense() : _buildFull(form),
            ),
          ),
        ),
      ),
    );
  }

  /// The spec drawing: badge row, step badge, title, subtitle.
  Widget _buildFull(bool form) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        SizedBox(
          height: OnboardingLayout.tapTarget,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: <Widget>[
              if (onBack != null)
                _BackButton(onBack: onBack!)
              else
                const SizedBox(width: 24),
              _trailingSlot(),
            ],
          ),
        ),
        if (stepBadge != null) ...<Widget>[
          SizedBox(height: form ? FormFlowLayout.headerRowToStepGap : 8),
          _stepBadgeText(form),
        ],
        const SizedBox(height: 8),
        Text(title, style: OnboardingTypography.headerTitle(color: titleColor)),
        if (subtitle != null && subtitle!.isNotEmpty) ...<Widget>[
          const SizedBox(height: 4),
          Text(subtitle!, style: _subtitleStyle),
        ],
      ],
    );
  }

  /// The collapsed drawing: back and title on ONE row, no brand badge, subtitle
  /// held to a single line. Actions are kept — a collapsed header still has to
  /// offer whatever the screen put in it.
  Widget _buildDense() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Row(
          children: <Widget>[
            if (onBack != null) _BackButton(onBack: onBack!),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  if (stepBadge != null) ...<Widget>[
                    _stepBadgeText(false),
                    const SizedBox(height: 2),
                  ],
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: OnboardingTypography.headerTitle(color: titleColor),
                  ),
                ],
              ),
            ),
            ...actions,
          ],
        ),
        if (subtitle != null && subtitle!.isNotEmpty) ...<Widget>[
          const SizedBox(height: 4),
          Text(
            subtitle!,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: _subtitleStyle,
          ),
        ],
      ],
    );
  }

  Widget _trailingSlot() {
    if (actions.isNotEmpty) {
      return Row(mainAxisSize: MainAxisSize.min, children: actions);
    }
    if (trailing != null) return trailing!;
    if (showBrandBadge) return const BrandBadge();
    return const SizedBox.shrink();
  }

  /// The STEP line. ONE line, always: at a large system font on a narrow phone
  /// 'STEP 1 OF 2 • AVAILABILITY & TERMS' wrapped and pushed the whole header
  /// another 19dp down the screen, for context the progress strip already
  /// carries.
  Widget _stepBadgeText(bool form) => Text(
    stepBadge!.toUpperCase(),
    maxLines: 1,
    overflow: TextOverflow.ellipsis,
    style: form
        ? OnboardingTypography.formStepLine()
        : OnboardingTypography.inter(
            size: 10,
            weight: FontWeight.w700,
            letterSpacing: 1,
            color: OnboardingColors.textOnBlueMuted,
          ),
  );

  TextStyle get _subtitleStyle => OnboardingTypography.inter(
    size: 13,
    color: OnboardingColors.textOnBlueMuted,
    height: 1.35,
  );
}

/// The header's back arrow: a 22dp glyph sitting ON the header's gutter, inside
/// a 48dp tap target. The glyph aligns to the gutter rather than centring in
/// its target, so the arrow lines up with the title beneath it while the tap
/// area stays legal.
class _BackButton extends StatelessWidget {
  const _BackButton({required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      tooltip: 'Wapas',
      onPressed: onBack,
      padding: EdgeInsets.zero,
      alignment: Alignment.centerLeft,
      constraints: const BoxConstraints.tightFor(
        width: OnboardingLayout.tapTarget,
        height: OnboardingLayout.tapTarget,
      ),
      icon: const Icon(
        Icons.arrow_back_rounded,
        color: OnboardingColors.textOnBlue,
        size: 22,
      ),
    );
  }
}
