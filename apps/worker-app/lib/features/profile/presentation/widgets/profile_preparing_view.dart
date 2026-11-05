import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/util/push_once.dart';
import '../../../../core/theme/app_motion.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/onboarding/brand_badge.dart';
import '../../../../router.dart';

/// The extraction wait's headline and subline.
///
/// Public so a test can pin the copy without re-typing it.
const String kPreparingProfileTitle = 'Bada Bhai is preparing your profile…';
const String kPreparingProfileCaption =
    'This takes a few seconds. Please wait while we curate your tailored '
    'factory job experience.';

/// The tip under the checklist — a real, checkable statement about this app:
/// everything on the profile can be changed later from Settings.
const String kPreparingProfileTipTitle = 'Quick tip';
const String kPreparingProfileTipText =
    'You can change your details, privacy settings and notifications anytime '
    'from account preferences.';

/// The three rows of the preparation checklist, in order.
const List<String> kPreparingProfileSteps = <String>[
  'Verifying account credentials',
  'Customizing recommendations',
  'Finalizing profile sync',
];

/// The line under each checklist row, in the same order.
///
/// HONEST COPY. The design sample read "Matching 18 CNC & Lathe roles in Surat
/// & Pune" and "Waiting for machine skills score" — a fixed count, trade and
/// two cities shown to EVERY worker, and a "score" the product does not have.
/// The extraction is one opaque server call with no per-step signal, so each
/// line says only what is really happening at that point.
const List<String> kPreparingProfileStepDetails = <String>[
  'OTP & mobile verified',
  'Reading your chat answers for skills & experience',
  'Waiting for your skills list',
];

/// The footer's two status labels.
const String kPreparingFooterEngine = 'BadaBhai Engine';
const String kPreparingFooterSync = 'Secure SSL Sync';

/// The design's own tokens for this screen. They are not in the shared theme
/// because no other screen draws them.
abstract final class _PrepColors {
  static const Color canvasTop = Color(0xFFF8FAFC);
  static const Color cardBorder = Color(0xFFE2E8F0);
  static const Color liveBg = Color(0xFFFFFBEB);
  static const Color liveBorder = Color(0xFFFDE68A);
  static const Color liveBadgeBg = Color(0xFFFEF3C7);
  static const Color liveBadgeText = Color(0xFFB45309);
  static const Color pendingRing = Color(0xFFCBD5E1);
  static const Color pendingDetail = Color(0xFF94A3B8);
  static const Color tipBg = Color(0xFFEFF6FF);
  static const Color tipBorder = Color(0xFFBFDBFE);
  static const Color tipInk = Color(0xFF1D4ED8);
  static const Color avatarShadow = Color(0x0F000000);
  static const Color feedbackBorder = Color(0x40FFFFFF);
}

/// The state of one checklist row, derived from the paced step.
enum _StepState { done, live, pending }

/// OWNER ASK (2026-10-22) — the redesigned "Profile preparation" wait: navy
/// header (back, brand, FEEDBACK pill, "Your profile"), a radar-orbit hero, the
/// headline, a three-step checklist with the live step boxed in amber, a quick
/// tip, and a status footer with a progress strip.
///
/// The extraction is ONE opaque server call — there is no per-step signal on
/// the wire — so the checklist is a PACED client-side drawing and it never
/// runs to "all done": the pacing stops inside the second row, and the screen
/// leaves on the cubit's state change, never on a timer.
///
/// The radar and the progress strip LOOP for as long as this view is up (the
/// wait has no known end). A widget test must `pump(duration)`, never
/// `pumpAndSettle`, while it is on screen.
class ProfilePreparingView extends StatefulWidget {
  const ProfilePreparingView({super.key, this.onBack});

  /// Draws the back arrow when non-null.
  final VoidCallback? onBack;

  @override
  State<ProfilePreparingView> createState() => _ProfilePreparingViewState();
}

class _ProfilePreparingViewState extends State<ProfilePreparingView>
    with TickerProviderStateMixin {
  /// The rings' breath: 0.97 → 1.03 and back, 2.4s each way.
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2400),
  );

  /// One full turn of the amber orbit every 3s, linear.
  late final AnimationController _orbit = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 3),
  );

  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    // Reduced motion: hold the drawing still instead of looping.
    if (MediaQuery.maybeDisableAnimationsOf(context) ?? false) return;
    _pulse.repeat(reverse: true);
    _orbit.repeat();
  }

  @override
  void dispose() {
    _pulse.dispose();
    _orbit.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: <Color>[_PrepColors.canvasTop, OnboardingColors.paperWhite],
        ),
      ),
      child: Column(
        children: <Widget>[
          _PrepHeader(onBack: widget.onBack),
          Expanded(
            child: LayoutBuilder(
              builder: (BuildContext context, BoxConstraints box) {
                return SingleChildScrollView(
                  child: ConstrainedBox(
                    constraints: BoxConstraints(minHeight: box.maxHeight),
                    child: Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(
                          maxWidth: OnboardingLayout.maxContentWidth,
                        ),
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: <Widget>[
                              _RadarOrbit(pulse: _pulse, orbit: _orbit),
                              const SizedBox(height: 8),
                              Text(
                                kPreparingProfileTitle,
                                textAlign: TextAlign.center,
                                style: OnboardingTypography.anek(
                                  size: 20,
                                  weight: FontWeight.w800,
                                  color: OnboardingColors.ink900,
                                ),
                              ),
                              const SizedBox(height: 6),
                              Text(
                                kPreparingProfileCaption,
                                textAlign: TextAlign.center,
                                style: OnboardingTypography.inter(
                                  size: 13,
                                  height: 1.45,
                                  color: OnboardingColors.ink600,
                                ),
                              ),
                              const SizedBox(height: 20),
                              _PrepChecklist(pulse: _pulse),
                              const SizedBox(height: 14),
                              const _QuickTip(),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
          const _PrepFooter(),
        ],
      ),
    );
  }
}

/// The navy header: back arrow + brand monogram on the left, the FEEDBACK pill
/// on the right, then "Your profile".
class _PrepHeader extends StatelessWidget {
  const _PrepHeader({this.onBack});

  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: OnboardingColors.shiftBlue,
      child: SafeArea(
        bottom: false,
        child: MediaQuery.withClampedTextScaling(
          maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(4, 4, 12, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                SizedBox(
                  height: OnboardingLayout.tapTarget,
                  child: Row(
                    children: <Widget>[
                      if (onBack != null)
                        IconButton(
                          tooltip: 'Wapas',
                          onPressed: onBack,
                          icon: const Icon(
                            Icons.arrow_back_rounded,
                            color: OnboardingColors.textOnBlue,
                          ),
                        )
                      else
                        const SizedBox(width: 12),
                      // The monogram yields first on a narrow phone at a
                      // large font: its word ellipsises, the pill stays whole.
                      const Expanded(child: _BrandMonogram()),
                      const SizedBox(width: 8),
                      const _FeedbackPill(),
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.only(left: 12, top: 6),
                  child: Text(
                    'Your profile',
                    style: OnboardingTypography.anek(
                      size: 26,
                      weight: FontWeight.w800,
                      color: OnboardingColors.textOnBlue,
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

/// The brand mark (white + yellow figures) beside "BADABHAI".
class _BrandMonogram extends StatelessWidget {
  const _BrandMonogram();

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Image.asset(
          BrandBadge.markAsset,
          width: 26,
          height: 26,
          filterQuality: FilterQuality.high,
          excludeFromSemantics: true,
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            'BADABHAI',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: OnboardingTypography.mono(
              size: 12,
              weight: FontWeight.w700,
              color: OnboardingColors.textOnBlue,
            ).copyWith(letterSpacing: 1.2),
          ),
        ),
      ],
    );
  }
}

/// The header's FEEDBACK pill: same destination and anti-stack push as the
/// kit's Feedback action, drawn as the design's outlined pill.
class _FeedbackPill extends StatelessWidget {
  const _FeedbackPill();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Feedback',
      excludeSemantics: true,
      child: InkWell(
        onTap: () => context.pushOnce(
          Routes.feedback,
          extra: GoRouterState.of(context).uri.path,
        ),
        borderRadius: BorderRadius.circular(8),
        child: ConstrainedBox(
          constraints: const BoxConstraints(
            minHeight: OnboardingLayout.tapTarget,
          ),
          child: Center(
            widthFactor: 1,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: _PrepColors.feedbackBorder),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  const Icon(
                    Icons.chat_bubble_rounded,
                    size: 13,
                    color: OnboardingColors.safetyYellow,
                  ),
                  const SizedBox(width: 6),
                  Text(
                    'FEEDBACK',
                    style: OnboardingTypography.inter(
                      size: 11,
                      weight: FontWeight.w700,
                      letterSpacing: 1,
                      color: OnboardingColors.textOnBlue,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The hero: three breathing hairline rings, a rotating amber orbit with a
/// glowing beacon, and the white avatar disc. Decorative — the headline below
/// says what is happening.
class _RadarOrbit extends StatelessWidget {
  const _RadarOrbit({required this.pulse, required this.orbit});

  final Animation<double> pulse;
  final Animation<double> orbit;

  static const double _box = 200;
  static const List<double> _ringDiameters = <double>[130, 160, 190];
  static const double _orbitDiameter = 108;
  static const double _avatar = 88;
  static const double _beacon = 10;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: SizedBox(
        width: _box,
        height: _box,
        child: Stack(
          alignment: Alignment.center,
          children: <Widget>[
            AnimatedBuilder(
              animation: pulse,
              builder: (BuildContext context, Widget? child) {
                final double t = Curves.easeInOut.transform(pulse.value);
                return Transform.scale(scale: 0.97 + 0.06 * t, child: child);
              },
              child: Stack(
                alignment: Alignment.center,
                children: <Widget>[
                  for (final double d in _ringDiameters)
                    Container(
                      width: d,
                      height: d,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        border: Border.all(color: _PrepColors.cardBorder),
                      ),
                    ),
                ],
              ),
            ),
            RotationTransition(
              turns: orbit,
              child: SizedBox(
                width: _orbitDiameter + _beacon,
                height: _orbitDiameter + _beacon,
                child: Stack(
                  alignment: Alignment.center,
                  children: <Widget>[
                    const CustomPaint(
                      size: Size.square(_orbitDiameter),
                      painter: _OrbitPainter(),
                    ),
                    // The beacon rides the orbit's leading (brightest) end.
                    Align(
                      alignment: Alignment.centerRight,
                      child: Container(
                        width: _beacon,
                        height: _beacon,
                        decoration: const BoxDecoration(
                          color: OnboardingColors.safetyYellow,
                          shape: BoxShape.circle,
                          boxShadow: <BoxShadow>[
                            BoxShadow(
                              color: OnboardingColors.safetyYellow,
                              blurRadius: 8,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            Container(
              width: _avatar,
              height: _avatar,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: OnboardingColors.paperWhite,
                shape: BoxShape.circle,
                border: Border.all(color: _PrepColors.cardBorder, width: 2),
                boxShadow: const <BoxShadow>[
                  BoxShadow(color: _PrepColors.avatarShadow, blurRadius: 16),
                ],
              ),
              child: const Icon(
                Icons.person_outline_rounded,
                size: 42,
                color: OnboardingColors.shiftBlue,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The amber orbit: a sweep from transparent to full safety yellow, ending at
/// angle 0 (the right-hand side) where the beacon sits.
class _OrbitPainter extends CustomPainter {
  const _OrbitPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final Rect rect = Offset.zero & size;
    final Paint paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round
      ..shader = const SweepGradient(
        colors: <Color>[Color(0x00FFB32C), OnboardingColors.safetyYellow],
      ).createShader(rect);
    canvas.drawArc(rect.deflate(1.5), 0, 2 * math.pi, false, paint);
  }

  @override
  bool shouldRepaint(covariant _OrbitPainter oldDelegate) => false;
}

/// The white checklist card. ONE finite tween paces which row is live; it
/// stops inside the second row so the card never claims the profile is done.
class _PrepChecklist extends StatelessWidget {
  const _PrepChecklist({required this.pulse});

  final Animation<double> pulse;

  /// `floor(0.66 * 3) == 1`: the LAST row is never reached.
  static const double _pacedTo = 0.66;

  @override
  Widget build(BuildContext context) {
    final int count = kPreparingProfileSteps.length;
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0, end: 1),
      duration: AppMotion.slower * 5,
      curve: AppMotion.easeInOut,
      builder: (BuildContext context, double t, _) {
        final int live = (t * _pacedTo * count).clamp(0, count - 1).floor();
        return Container(
          width: double.infinity,
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: OnboardingColors.paperWhite,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: _PrepColors.cardBorder, width: 1.2),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              for (int i = 0; i < count; i++) ...<Widget>[
                if (i > 0) const _DottedConnector(),
                _PrepStepRow(
                  title: kPreparingProfileSteps[i],
                  detail: kPreparingProfileStepDetails[i],
                  state: i < live
                      ? _StepState.done
                      : (i == live ? _StepState.live : _StepState.pending),
                  pulse: pulse,
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

/// The dotted line joining two checklist rows, under the indicators' column.
class _DottedConnector extends StatelessWidget {
  const _DottedConnector();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: 22),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Column(
          children: <Widget>[
            for (int i = 0; i < 3; i++)
              Container(
                width: 2,
                height: 2,
                margin: const EdgeInsets.symmetric(vertical: 1.5),
                decoration: const BoxDecoration(
                  color: _PrepColors.pendingRing,
                  shape: BoxShape.circle,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// One checklist row. The live row sits in the amber box with a spinner and a
/// pulsing LIVE badge.
class _PrepStepRow extends StatelessWidget {
  const _PrepStepRow({
    required this.title,
    required this.detail,
    required this.state,
    required this.pulse,
  });

  final String title;
  final String detail;
  final _StepState state;
  final Animation<double> pulse;

  @override
  Widget build(BuildContext context) {
    final bool live = state == _StepState.live;
    final Widget row = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.only(top: 1),
          child: SizedBox(width: 20, height: 20, child: _indicator()),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Wrap(
                crossAxisAlignment: WrapCrossAlignment.center,
                spacing: 8,
                runSpacing: 4,
                children: <Widget>[
                  Text(
                    title,
                    style: OnboardingTypography.inter(
                      size: 14,
                      weight: FontWeight.w700,
                      height: 1.3,
                      color: state == _StepState.pending
                          ? OnboardingColors.ink500
                          : OnboardingColors.ink900,
                    ),
                  ),
                  if (live) _LiveBadge(pulse: pulse),
                ],
              ),
              const SizedBox(height: 2),
              Text(detail, style: _detailStyle()),
            ],
          ),
        ),
      ],
    );
    return MergeSemantics(
      child: AnimatedContainer(
        duration: AppMotion.base,
        padding: EdgeInsets.all(live ? 12 : 6),
        decoration: BoxDecoration(
          color: live ? _PrepColors.liveBg : Colors.transparent,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: live ? _PrepColors.liveBorder : Colors.transparent,
          ),
        ),
        child: row,
      ),
    );
  }

  TextStyle _detailStyle() {
    switch (state) {
      case _StepState.done:
        return OnboardingTypography.mono(
          size: 11,
          weight: FontWeight.w600,
          color: OnboardingColors.successGreen,
        );
      case _StepState.live:
        return OnboardingTypography.inter(
          size: 12,
          weight: FontWeight.w600,
          height: 1.35,
          color: OnboardingColors.ink600,
        );
      case _StepState.pending:
        return OnboardingTypography.mono(
          size: 11,
          color: _PrepColors.pendingDetail,
        );
    }
  }

  Widget _indicator() {
    switch (state) {
      case _StepState.done:
        return Container(
          decoration: const BoxDecoration(
            color: OnboardingColors.successBg,
            shape: BoxShape.circle,
          ),
          child: const Icon(
            Icons.check_rounded,
            size: 14,
            color: OnboardingColors.successGreen,
            semanticLabel: 'Done',
          ),
        );
      case _StepState.live:
        return const Padding(
          padding: EdgeInsets.all(1),
          child: CircularProgressIndicator(
            strokeWidth: 2,
            color: OnboardingColors.safetyYellow,
            backgroundColor: _PrepColors.liveBorder,
          ),
        );
      case _StepState.pending:
        return Container(
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: _PrepColors.pendingRing, width: 2),
          ),
          child: Center(
            child: Container(
              width: 6,
              height: 6,
              decoration: const BoxDecoration(
                color: _PrepColors.pendingRing,
                shape: BoxShape.circle,
              ),
            ),
          ),
        );
    }
  }
}

/// The LIVE badge on the active row; its dot pulses with the rings.
class _LiveBadge extends StatelessWidget {
  const _LiveBadge({required this.pulse});

  final Animation<double> pulse;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: _PrepColors.liveBadgeBg,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          FadeTransition(
            opacity: Tween<double>(begin: 0.35, end: 1).animate(pulse),
            child: Container(
              width: 6,
              height: 6,
              decoration: const BoxDecoration(
                color: OnboardingColors.safetyYellow,
                shape: BoxShape.circle,
              ),
            ),
          ),
          const SizedBox(width: 4),
          Text(
            'LIVE',
            style: OnboardingTypography.inter(
              size: 10,
              weight: FontWeight.w800,
              letterSpacing: 0.6,
              color: _PrepColors.liveBadgeText,
            ),
          ),
        ],
      ),
    );
  }
}

/// The light-blue tip card.
class _QuickTip extends StatelessWidget {
  const _QuickTip();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: _PrepColors.tipBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _PrepColors.tipBorder),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(
            Icons.info_rounded,
            size: 18,
            color: OnboardingColors.shiftBlue,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  kPreparingProfileTipTitle.toUpperCase(),
                  style: OnboardingTypography.mono(
                    size: 10,
                    weight: FontWeight.w800,
                    color: _PrepColors.tipInk,
                  ).copyWith(letterSpacing: 0.8),
                ),
                const SizedBox(height: 3),
                Text(
                  kPreparingProfileTipText,
                  style: OnboardingTypography.inter(
                    size: 12,
                    weight: FontWeight.w500,
                    height: 1.4,
                    color: OnboardingColors.ink600,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The docked footer: a thin amber progress strip, then the engine label with
/// a live dot and the sync label.
class _PrepFooter extends StatelessWidget {
  const _PrepFooter();

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: OnboardingColors.paperWhite,
        border: Border(top: BorderSide(color: _PrepColors.cardBorder)),
      ),
      child: SafeArea(
        top: false,
        child: MediaQuery.withClampedTextScaling(
          maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                ClipRRect(
                  borderRadius: BorderRadius.circular(2),
                  child: const LinearProgressIndicator(
                    minHeight: 3,
                    color: OnboardingColors.safetyYellow,
                    backgroundColor: _PrepColors.cardBorder,
                  ),
                ),
                const SizedBox(height: 8),
                Row(
                  children: <Widget>[
                    Container(
                      width: 7,
                      height: 7,
                      decoration: const BoxDecoration(
                        color: OnboardingColors.successGreen,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        kPreparingFooterEngine,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: OnboardingTypography.mono(
                          size: 11,
                          color: OnboardingColors.ink500,
                        ),
                      ),
                    ),
                    Text(
                      kPreparingFooterSync,
                      style: OnboardingTypography.mono(
                        size: 11,
                        weight: FontWeight.w700,
                        color: OnboardingColors.ink900,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
