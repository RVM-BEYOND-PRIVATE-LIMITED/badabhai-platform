import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../../core/di/locator.dart';
import '../../../../core/theme/app_motion.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/util/taxonomy_labels.dart';
import '../../../../core/widgets/onboarding/brand_badge.dart';
import '../../../profile_tab/domain/profile_summary.dart';
import '../../../profile_tab/domain/profile_summary_repository.dart';
import '../../../profile_tab/presentation/widgets/profile_identity_card.dart'
    show profileExperienceLabel, profileInitials;
import '../../domain/resume_edit_repository.dart';
import '../../domain/resume_safe_fields.dart';

/// The four rows of the generation checklist, in order.
const List<String> kResumeBuildingSteps = <String>[
  'Details check ho gaye',
  'Trade profile ban raha hai',
  'Skills jud rahi hain',
  'Final PDF card taiyaar karna',
];

/// The live line under the last step. The PDF does carry the BadaBhai brand
/// and trust badge, so this is true; the design sample's "verified" is left
/// out because that word belongs to server attestation only (#1586).
const String kResumeBuildingStampLine = 'Applying BadaBhai digital stamp…';

/// The trust pill at the bottom. Worker-side BadaBhai is free; the design
/// sample's "Verified" network claim is left out (the resume itself says
/// BadaBhai does not guarantee hiring).
const String kResumeBuildingTrustLine = '100% Free • Factory Placement Network';

/// The design's own tokens for this screen.
abstract final class _BuildColors {
  static const Color navyDeep = Color(0xFF0A256E);
  static const Color stepInk = Color(0xFF475069);
  static const Color pillBg = Color(0xFFFEF3C7);
  static const Color pillText = Color(0xFFB45309);
  static const Color barTrack = Color(0xFFF1F5F9);
  static const Color barEnd = Color(0xFFF59E0B);
  static const Color liveBg = Color(0xFFFFFBEB);
  static const Color liveBorder = Color(0xFFFDE68A);
  static const Color teaserBg = Color(0x330F2B7A);
  static const Color teaserBorder = Color(0x59FFB32C);
  static const Color roleGreen = Color(0xFF86EFAC);
  static const Color glass12 = Color(0x1FFFFFFF);
  static const Color glass08 = Color(0x14FFFFFF);
  static const Color glass06 = Color(0x0FFFFFFF);
  static const Color white85 = Color(0xD9FFFFFF);
}

/// The state of one checklist row, derived from the paced step.
enum _StepState { done, live, pending }

/// OWNER ASK (2026-10-22) — the redesigned "Resume ban raha hai…" wait: a
/// full-bleed navy gradient, a brand pill, the title, a white STEP n/4 card with
/// a shimmering progress strip and the live step boxed in amber, a glass
/// preview of the worker's own resume card, and the trust pill.
///
/// The generation is async (the ResumeCubit), so the four steps are a PACED
/// client-side drawing — 0 → 0.92, so the bar never claims "done" before the
/// screen actually leaves.
///
/// The shimmer, the bolt and the sparkles LOOP for as long as the screen is up.
/// A widget test must `pump(duration)`, never `pumpAndSettle`, while it is on
/// screen.
class ResumeBuildingBody extends StatefulWidget {
  const ResumeBuildingBody({super.key});

  @override
  State<ResumeBuildingBody> createState() => _ResumeBuildingBodyState();
}

class _ResumeBuildingBodyState extends State<ResumeBuildingBody>
    with SingleTickerProviderStateMixin {
  /// One loop drives the bar shimmer, the bolt's glow and the sparkles.
  late final AnimationController _loop = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1800),
  );

  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (MediaQuery.maybeDisableAnimationsOf(context) ?? false) return;
    _loop.repeat();
  }

  @override
  void dispose() {
    _loop.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: <Color>[OnboardingColors.shiftBlue, _BuildColors.navyDeep],
        ),
      ),
      child: SafeArea(
        child: Column(
          children: <Widget>[
            Expanded(
              child: SingleChildScrollView(
                child: Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(
                      maxWidth: OnboardingLayout.maxContentWidth,
                    ),
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: <Widget>[
                          const _BuildHeader(),
                          const SizedBox(height: 24),
                          // The pacing tween — 0 → 0.92 so the bar never
                          // claims "done" before the cubit navigates away.
                          TweenAnimationBuilder<double>(
                            tween: Tween<double>(begin: 0, end: 0.92),
                            duration: AppMotion.slower * 6,
                            curve: AppMotion.easeInOut,
                            builder: (BuildContext context, double t, _) {
                              final int step = (t * kResumeBuildingSteps.length)
                                  .clamp(0, kResumeBuildingSteps.length - 0.001)
                                  .floor();
                              return _ProgressCard(
                                progress: t,
                                currentStep: step,
                                loop: _loop,
                              );
                            },
                          ),
                          const SizedBox(height: 24),
                          _ResumeTeaser(loop: _loop),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 4, 16, 12),
              child: _TrustPill(),
            ),
          ],
        ),
      ),
    );
  }
}

/// The brand pill (top right), the title and the subtitle.
class _BuildHeader extends StatelessWidget {
  const _BuildHeader();

  @override
  Widget build(BuildContext context) {
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Align(
            alignment: Alignment.centerRight,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
              decoration: BoxDecoration(
                color: _BuildColors.glass12,
                borderRadius: BorderRadius.circular(999),
              ),
              child: const BrandBadge(),
            ),
          ),
          const SizedBox(height: 18),
          Text(
            'Resume ban raha hai…',
            style: OnboardingTypography.anek(
              size: 28,
              weight: FontWeight.w900,
              color: OnboardingColors.textOnBlue,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            'Aapki baat se ek branded, share-ready resume taiyaar kar rahe hain.',
            style: OnboardingTypography.inter(
              size: 14,
              height: 1.45,
              color: _BuildColors.white85,
            ),
          ),
        ],
      ),
    );
  }
}

/// The white card: STEP n/4 + status pill, the shimmering bar, the four rows.
class _ProgressCard extends StatelessWidget {
  const _ProgressCard({
    required this.progress,
    required this.currentStep,
    required this.loop,
  });

  final double progress;
  final int currentStep;
  final Animation<double> loop;

  _StepState _stateOf(int index) {
    if (index < currentStep) return _StepState.done;
    if (index == currentStep) return _StepState.live;
    return _StepState.pending;
  }

  @override
  Widget build(BuildContext context) {
    final int total = kResumeBuildingSteps.length;
    final bool last = currentStep == total - 1;
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: OnboardingColors.paperWhite,
        borderRadius: BorderRadius.circular(24),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          // Chrome-clamped like the headers: a 2.0 font on a 320 phone made
          // the count + pill wider than the card.
          MediaQuery.withClampedTextScaling(
            maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
            child: Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    'STEP ${currentStep + 1}/$total',
                    style: OnboardingTypography.mono(
                      size: 12,
                      weight: FontWeight.w700,
                      color: _BuildColors.stepInk,
                    ).copyWith(letterSpacing: 1),
                  ),
                ),
                const SizedBox(width: 8),
                Flexible(
                  child: _StatusPill(
                    label: last ? 'Almost Done' : 'In progress',
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          _ShimmerBar(progress: progress, loop: loop),
          const SizedBox(height: 8),
          for (int i = 0; i < total; i++) ...<Widget>[
            if (i > 0 &&
                _stateOf(i) != _StepState.live &&
                _stateOf(i - 1) != _StepState.live)
              const Divider(height: 1, color: OnboardingColors.borderSubtle),
            _StepRow(
              label: kResumeBuildingSteps[i],
              state: _stateOf(i),
              detail: i == total - 1 ? kResumeBuildingStampLine : null,
              loop: loop,
            ),
          ],
        ],
      ),
    );
  }
}

/// The amber "Almost Done" / "In progress" pill.
class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: _BuildColors.pillBg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Container(
            width: 6,
            height: 6,
            decoration: const BoxDecoration(
              color: OnboardingColors.safetyYellow,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 5),
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: OnboardingTypography.inter(
                size: 11,
                weight: FontWeight.w800,
                color: _BuildColors.pillText,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The 5px progress strip: amber gradient fill at [progress], with a light
/// sweep running across the fill on [loop].
class _ShimmerBar extends StatelessWidget {
  const _ShimmerBar({required this.progress, required this.loop});

  final double progress;
  final Animation<double> loop;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Resume progress',
      value: '${(progress * 100).round()}%',
      child: ClipRRect(
        borderRadius: BorderRadius.circular(3),
        child: SizedBox(
          height: 5,
          child: Stack(
            children: <Widget>[
              const Positioned.fill(
                child: ColoredBox(color: _BuildColors.barTrack),
              ),
              FractionallySizedBox(
                widthFactor: progress.clamp(0.0, 1.0),
                heightFactor: 1,
                child: AnimatedBuilder(
                  animation: loop,
                  builder: (BuildContext context, _) {
                    // The sweep travels -1 → 2 across the fill.
                    final double x = -1 + 3 * loop.value;
                    return DecoratedBox(
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          colors: const <Color>[
                            OnboardingColors.safetyYellow,
                            _BuildColors.barEnd,
                          ],
                        ),
                      ),
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment(x - 0.6, 0),
                            end: Alignment(x + 0.6, 0),
                            colors: const <Color>[
                              Color(0x00FFFFFF),
                              Color(0x8CFFFFFF),
                              Color(0x00FFFFFF),
                            ],
                          ),
                        ),
                      ),
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One checklist row. The live row sits in the amber box with a spinner; the
/// last step's live box adds the pulsing bolt and the stamp line.
class _StepRow extends StatelessWidget {
  const _StepRow({
    required this.label,
    required this.state,
    required this.loop,
    this.detail,
  });

  final String label;
  final _StepState state;
  final Animation<double> loop;

  /// Shown under the label while this row is live.
  final String? detail;

  @override
  Widget build(BuildContext context) {
    final bool live = state == _StepState.live;
    final bool pending = state == _StepState.pending;
    final Widget content = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        SizedBox(width: 22, height: 22, child: _indicator()),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(
                label,
                style: live
                    ? OnboardingTypography.anek(
                        size: 15,
                        weight: FontWeight.w800,
                        color: OnboardingColors.ink900,
                      )
                    : OnboardingTypography.inter(
                        size: 14,
                        weight: FontWeight.w600,
                        height: 1.35,
                        color: pending
                            ? OnboardingColors.ink500
                            : OnboardingColors.ink900,
                      ),
              ),
              if (live && detail != null) ...<Widget>[
                const SizedBox(height: 4),
                Row(
                  children: <Widget>[
                    AnimatedBuilder(
                      animation: loop,
                      builder: (BuildContext context, Widget? child) {
                        final double glow =
                            0.6 +
                            0.4 *
                                (0.5 -
                                    0.5 * math.cos(2 * math.pi * loop.value));
                        return Opacity(opacity: glow, child: child);
                      },
                      child: const Icon(
                        Icons.bolt_rounded,
                        size: 16,
                        color: OnboardingColors.safetyYellow,
                      ),
                    ),
                    const SizedBox(width: 4),
                    Expanded(
                      child: Text(
                        detail!,
                        style: OnboardingTypography.inter(
                          size: 12,
                          weight: FontWeight.w600,
                          color: _BuildColors.pillText,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
        if (pending) ...<Widget>[
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: OnboardingColors.chipBg,
              border: Border.all(color: OnboardingColors.borderSubtle),
              borderRadius: BorderRadius.circular(OnboardingRadii.badge),
            ),
            child: Text(
              'Baaki',
              style: OnboardingTypography.inter(
                size: 11,
                weight: FontWeight.w700,
                color: OnboardingColors.ink500,
              ),
            ),
          ),
        ],
      ],
    );
    return MergeSemantics(
      child: AnimatedContainer(
        duration: AppMotion.base,
        margin: EdgeInsets.symmetric(vertical: live ? 8 : 0),
        padding: EdgeInsets.symmetric(
          horizontal: live ? 14 : 0,
          vertical: live ? 14 : 12,
        ),
        decoration: BoxDecoration(
          color: live ? _BuildColors.liveBg : Colors.transparent,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: live ? _BuildColors.liveBorder : Colors.transparent,
            width: 1.5,
          ),
        ),
        child: content,
      ),
    );
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
            size: 15,
            color: OnboardingColors.successGreen,
            semanticLabel: 'Ho gaya',
          ),
        );
      case _StepState.live:
        return const CircularProgressIndicator(
          strokeWidth: 2.2,
          color: OnboardingColors.safetyYellow,
        );
      case _StepState.pending:
        return Container(
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(
              color: OnboardingColors.borderDefault,
              width: 1.5,
            ),
          ),
        );
    }
  }
}

/// The worker's OWN data for the glass preview — never a sample person.
class _TeaserData {
  const _TeaserData({
    required this.title,
    required this.initials,
    required this.role,
    required this.attested,
    required this.chips,
  });

  final String title;
  final String initials;
  final String? role;
  final bool attested;
  final List<String> chips;
}

/// Loads the preview's data once, fail-silent: a missing repository, a 401,
/// an offline handset or an empty profile all simply leave the card out.
Future<_TeaserData?> _loadTeaser() async {
  if (!locator.isRegistered<ProfileSummaryRepository>()) return null;
  try {
    final ProfileSummary s = await locator<ProfileSummaryRepository>()
        .summary();
    ResumeSafeFields? fields;
    if (locator.isRegistered<ResumeEditRepository>()) {
      try {
        fields = await locator<ResumeEditRepository>().load();
      } catch (_) {
        fields = null;
      }
    }
    final String name = (fields?.displayName ?? s.displayName ?? '').trim();
    final String trade = replaceTaxonomyIds(s.tradeLabel ?? '').trim();
    if (name.isEmpty && trade.isEmpty) return null;
    final List<String> skills = <String>[
      ...s.skills,
      ...s.machines,
    ].map(replaceTaxonomyIds).where((String v) => v.trim().isNotEmpty).toList();
    final double? years = s.experienceYears;
    return _TeaserData(
      title: name.isNotEmpty ? name : trade,
      initials: profileInitials(name.isNotEmpty ? name : trade) ?? 'BB',
      role: name.isNotEmpty && trade.isNotEmpty ? trade : null,
      attested: s.attested,
      chips: <String>[
        if (years != null) profileExperienceLabel(years),
        if (skills.isNotEmpty) skills.take(2).join(' / '),
        if (fields?.nightShiftReady ?? false) 'Night Shift Ready',
      ],
    );
  } catch (_) {
    return null;
  }
}

/// The glass preview of the worker's resume card, with two drifting amber
/// sparkles. Hidden until (and unless) the worker's own data has loaded.
class _ResumeTeaser extends StatefulWidget {
  const _ResumeTeaser({required this.loop});

  final Animation<double> loop;

  @override
  State<_ResumeTeaser> createState() => _ResumeTeaserState();
}

class _ResumeTeaserState extends State<_ResumeTeaser> {
  late final Future<_TeaserData?> _data = _loadTeaser();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<_TeaserData?>(
      future: _data,
      builder: (BuildContext context, AsyncSnapshot<_TeaserData?> snap) {
        final _TeaserData? d = snap.data;
        return AnimatedSwitcher(
          duration: AppMotion.slow,
          child: d == null
              ? const SizedBox.shrink()
              : _TeaserCard(
                  key: const ValueKey<String>('teaser'),
                  data: d,
                  loop: widget.loop,
                ),
        );
      },
    );
  }
}

class _TeaserCard extends StatelessWidget {
  const _TeaserCard({super.key, required this.data, required this.loop});

  final _TeaserData data;
  final Animation<double> loop;

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: <Widget>[
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: _BuildColors.teaserBg,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: _BuildColors.teaserBorder),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Container(
                    width: 40,
                    height: 40,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: OnboardingColors.shiftBlue,
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: OnboardingColors.safetyYellow,
                        width: 1.5,
                      ),
                    ),
                    child: Text(
                      data.initials,
                      style: OnboardingTypography.anek(
                        size: 14,
                        weight: FontWeight.w800,
                        color: OnboardingColors.textOnBlue,
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Row(
                          children: <Widget>[
                            Flexible(
                              child: Text(
                                data.title,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: OnboardingTypography.inter(
                                  size: 14,
                                  weight: FontWeight.w800,
                                  color: OnboardingColors.textOnBlue,
                                ),
                              ),
                            ),
                            // The tick is earned by server attestation only.
                            if (data.attested) ...<Widget>[
                              const SizedBox(width: 5),
                              const Icon(
                                Icons.verified_rounded,
                                size: 16,
                                color: OnboardingColors.safetyYellow,
                              ),
                            ],
                          ],
                        ),
                        if (data.role != null || data.attested) ...<Widget>[
                          const SizedBox(height: 2),
                          Text(
                            <String>[
                              if (data.role != null) data.role!,
                              if (data.attested) 'Verified Profile',
                            ].join(' • '),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: OnboardingTypography.mono(
                              size: 11,
                              color: _BuildColors.roleGreen,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: _BuildColors.glass12,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      'PDF CARD',
                      style: OnboardingTypography.mono(
                        size: 9,
                        weight: FontWeight.w800,
                        color: OnboardingColors.textOnBlue,
                      ),
                    ),
                  ),
                ],
              ),
              if (data.chips.isNotEmpty) ...<Widget>[
                const SizedBox(height: 14),
                const Divider(height: 1, color: _BuildColors.glass12),
                const SizedBox(height: 12),
                Row(
                  children: <Widget>[
                    for (int i = 0; i < data.chips.length; i++) ...<Widget>[
                      if (i > 0) const SizedBox(width: 8),
                      Expanded(child: _GlassChip(label: data.chips[i])),
                    ],
                  ],
                ),
              ],
            ],
          ),
        ),
        _Sparkle(loop: loop, anchor: const Alignment(1.04, -1.25), phase: 0),
        _Sparkle(loop: loop, anchor: const Alignment(-1.03, 0.55), phase: 0.5),
      ],
    );
  }
}

class _GlassChip extends StatelessWidget {
  const _GlassChip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 7),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: _BuildColors.glass08,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        textAlign: TextAlign.center,
        style: OnboardingTypography.mono(
          size: 11,
          color: OnboardingColors.textOnBlue,
        ),
      ),
    );
  }
}

/// A soft amber dot drifting on a sine path near a corner of the card.
class _Sparkle extends StatelessWidget {
  const _Sparkle({
    required this.loop,
    required this.anchor,
    required this.phase,
  });

  final Animation<double> loop;
  final Alignment anchor;
  final double phase;

  @override
  Widget build(BuildContext context) {
    return Positioned.fill(
      child: IgnorePointer(
        child: ExcludeSemantics(
          child: AnimatedBuilder(
            animation: loop,
            builder: (BuildContext context, Widget? child) {
              final double a = 2 * math.pi * (loop.value + phase);
              return Align(
                alignment: anchor,
                child: Transform.translate(
                  offset: Offset(3 * math.cos(a), 4 * math.sin(a)),
                  child: child,
                ),
              );
            },
            child: Container(
              width: 6,
              height: 6,
              decoration: const BoxDecoration(
                color: OnboardingColors.safetyYellow,
                shape: BoxShape.circle,
                boxShadow: <BoxShadow>[
                  BoxShadow(
                    color: OnboardingColors.safetyYellow,
                    blurRadius: 6,
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

/// The capsule trust pill at the bottom. No feedback action on this screen.
class _TrustPill extends StatelessWidget {
  const _TrustPill();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
        decoration: BoxDecoration(
          color: _BuildColors.glass06,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: _BuildColors.glass12),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(
              Icons.verified_user_rounded,
              size: 16,
              color: OnboardingColors.safetyYellow,
            ),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                kResumeBuildingTrustLine,
                textAlign: TextAlign.center,
                style: OnboardingTypography.inter(
                  size: 12,
                  weight: FontWeight.w600,
                  color: _BuildColors.white85,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
