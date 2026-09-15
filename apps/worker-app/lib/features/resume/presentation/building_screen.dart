import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_motion.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../router.dart';
import 'cubit/resume_cubit.dart';

/// Onboarding "Resume ban raha hai…" screen (spec §5.1 / `.aw-build`; master
/// Flutter UI kit screen 22).
///
/// Generates the resume on mount (the real work), then enters the shell at the
/// Resume tab — passing the generated text so the tab shows it without
/// re-generating. A minimum display window stops the spinner from flashing.
class BuildingScreen extends StatelessWidget {
  const BuildingScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ResumeCubit>(
      create: (_) => locator<ResumeCubit>()..generate(),
      child: const _BuildingView(),
    );
  }
}

class _BuildingView extends StatefulWidget {
  const _BuildingView();

  @override
  State<_BuildingView> createState() => _BuildingViewState();
}

class _BuildingViewState extends State<_BuildingView> {
  static const Duration _minDisplay = Duration(milliseconds: 900);
  bool _minElapsed = false;
  bool _navigated = false;

  @override
  void initState() {
    super.initState();
    Future<void>.delayed(_minDisplay, () {
      if (!mounted) return;
      _minElapsed = true;
      _maybeEnterShell();
    });
  }

  void _maybeEnterShell() {
    if (_navigated || !mounted) return;
    final ResumeState state = context.read<ResumeCubit>().state;
    if (_minElapsed && state.status == ResumeStatus.ready) {
      _navigated = true;
      context.go(Routes.resume, extra: state.resumeText);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: OnboardingColors.canvasBg,
      body: BlocConsumer<ResumeCubit, ResumeState>(
        listener: (BuildContext context, ResumeState state) {
          if (state.status == ResumeStatus.ready) _maybeEnterShell();
        },
        builder: (BuildContext context, ResumeState state) {
          if (state.status == ResumeStatus.failed) {
            // ResumeCubit's failed state does not carry the typed cause
            // (handled separately), so we use a cause-agnostic honest retry
            // line rather than a false "check internet".
            return _StatusLayout(
              icon: Icons.error_outline_rounded,
              iconColor: OnboardingColors.errorRed,
              iconBg: OnboardingColors.errorBg,
              title: 'Resume nahi ban paya.',
              subtitle: 'Thodi der baad dobara try karein.',
              actionLabel: 'Dobara koshish karein',
              onAction: () {
                _navigated = false;
                context.read<ResumeCubit>().generate();
              },
            );
          }
          if (state.status == ResumeStatus.noProfile) {
            return _StatusLayout(
              icon: Icons.person_off_outlined,
              iconColor: OnboardingColors.ink600,
              iconBg: OnboardingColors.cardIconBg,
              title: 'Profile taiyaar nahi hai.',
              subtitle:
                  'Chat mein kuch details share karein, phir dobara try karein.',
              actionLabel: 'Wapas jaayein',
              onAction: () => context.go('/'),
            );
          }
          return const _BuildingBody();
        },
      ),
    );
  }
}

/// The failed / no-profile surface in the kit: the Shift Blue header carries
/// the state's own title + subtitle (so the header never claims "ban raha hai"
/// on a screen where nothing is being built), a tinted icon disc sits in the
/// scrolling body, and the single recovery action docks at the bottom.
class _StatusLayout extends StatelessWidget {
  const _StatusLayout({
    required this.icon,
    required this.iconColor,
    required this.iconBg,
    required this.title,
    required this.subtitle,
    required this.actionLabel,
    required this.onAction,
  });

  final IconData icon;
  final Color iconColor;
  final Color iconBg;
  final String title;
  final String subtitle;
  final String actionLabel;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        // No back arrow: the building screen is entered with `go`, and the
        // recovery action below is the way out (unchanged from before).
        ShiftBlueHeader(title: title, subtitle: subtitle),
        Expanded(
          child: SafeArea(
            top: false,
            bottom: false,
            child: OnboardingBody(
              fillViewport: true,
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  Container(
                    width: 88,
                    height: 88,
                    decoration: BoxDecoration(
                      color: iconBg,
                      shape: BoxShape.circle,
                    ),
                    child: Icon(icon, size: 44, color: iconColor),
                  ),
                ],
              ),
            ),
          ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Center(
              heightFactor: 1,
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  maxWidth: OnboardingLayout.maxContentWidth,
                ),
                child: PrimaryActionButton(
                  label: actionLabel,
                  showArrow: false,
                  onPressed: onAction,
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// The state of one row in the step ticker, derived from the paced step.
enum _StepState { done, live, pending }

/// Kit screen 22 — Resume generation loading. The Shift Blue header carries the
/// title and subtitle; below it a white progress card holds a thin safety-yellow
/// DETERMINATE bar, a mono "STEP n/4" count, and a four-row step ticker
/// (Done = green check, Live = small spinner, Baaki = muted with a tag). Never
/// a bare spinner — the step count is known, so progress is shown as steps.
///
/// The generation work is async (the ResumeCubit), so the four steps are a
/// paced client-side animation across the display window — the
/// resume-generation logic + navigation are untouched, this is only the waiting
/// surface.
class _BuildingBody extends StatelessWidget {
  const _BuildingBody();

  /// Ticker rows, in order. Row state follows the paced step: rows before it
  /// are done, the row at it is live, rows after it are still pending.
  static const List<String> _steps = <String>[
    'Details check ho gaye',
    'Trade profile ban raha hai',
    'Skills jud rahi hain',
    'Final PDF card taiyaar karna',
  ];

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        const ShiftBlueHeader(
          title: 'Resume ban raha hai…',
          subtitle:
              'Aapki baat se ek branded, share-ready resume taiyaar kar rahe hain.',
        ),
        Expanded(
          child: SafeArea(
            top: false,
            // Scroll instead of overflowing on a short handset at large text.
            child: OnboardingBody(
              padding: const EdgeInsets.all(16),
              // The pacing tween — 0 → 0.92 so the bar never claims "done"
              // before the cubit actually navigates away. Determinate
              // throughout; at its end the last row is still live, not done.
              child: TweenAnimationBuilder<double>(
                tween: Tween<double>(begin: 0, end: 0.92),
                duration: AppMotion.slower * 6, // ~2.9s across the four steps
                curve: AppMotion.easeInOut,
                builder: (BuildContext context, double t, _) {
                  final int step =
                      (t * _steps.length).clamp(0, _steps.length - 0.001).floor();
                  return _ProgressCard(progress: t, currentStep: step);
                },
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// The white progress card: bar + step count + the four ticker rows.
class _ProgressCard extends StatelessWidget {
  const _ProgressCard({required this.progress, required this.currentStep});

  final double progress;
  final int currentStep;

  _StepState _stateOf(int index) {
    if (index < currentStep) return _StepState.done;
    if (index == currentStep) return _StepState.live;
    return _StepState.pending;
  }

  @override
  Widget build(BuildContext context) {
    final int total = _BuildingBody._steps.length;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: OnboardingColors.paperWhite,
        border: Border.all(color: OnboardingColors.borderSubtle),
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            'STEP ${currentStep + 1}/$total',
            style: OnboardingTypography.monoLabel(
              color: OnboardingColors.shiftBlue,
            ),
          ),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: LinearProgressIndicator(
              value: progress,
              minHeight: 6,
              backgroundColor: OnboardingColors.cardIconBg,
              valueColor: const AlwaysStoppedAnimation<Color>(
                OnboardingColors.safetyYellow,
              ),
            ),
          ),
          const SizedBox(height: 12),
          for (int i = 0; i < total; i++) ...<Widget>[
            if (i > 0)
              const Divider(height: 1, color: OnboardingColors.borderSubtle),
            _StepRow(label: _BuildingBody._steps[i], state: _stateOf(i)),
          ],
        ],
      ),
    );
  }
}

/// One ticker row: a state indicator, the step label, and — for a pending step
/// — the muted "Baaki" tag.
class _StepRow extends StatelessWidget {
  const _StepRow({required this.label, required this.state});

  final String label;
  final _StepState state;

  @override
  Widget build(BuildContext context) {
    final bool pending = state == _StepState.pending;
    return MergeSemantics(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Row(
          children: <Widget>[
            SizedBox(width: 24, height: 24, child: _indicator()),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                label,
                style: OnboardingTypography.inter(
                  size: 14,
                  weight: state == _StepState.live
                      ? FontWeight.w700
                      : FontWeight.w500,
                  color: pending
                      ? OnboardingColors.ink500
                      : OnboardingColors.ink900,
                  height: 1.35,
                ),
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
        ),
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
            size: 16,
            color: OnboardingColors.successGreen,
            semanticLabel: 'Ho gaya',
          ),
        );
      case _StepState.live:
        return const Padding(
          padding: EdgeInsets.all(3),
          child: CircularProgressIndicator(
            strokeWidth: 2.5,
            color: OnboardingColors.shiftBlue,
          ),
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
