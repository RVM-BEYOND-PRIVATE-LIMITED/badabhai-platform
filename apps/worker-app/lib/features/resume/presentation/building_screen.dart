import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_motion.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../router.dart';
import 'cubit/resume_cubit.dart';

/// Onboarding "Resume ban raha hai…" screen (spec §5.1 / `.aw-build`).
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
      body: BlocConsumer<ResumeCubit, ResumeState>(
        listener: (BuildContext context, ResumeState state) {
          if (state.status == ResumeStatus.ready) _maybeEnterShell();
        },
        builder: (BuildContext context, ResumeState state) {
          if (state.status == ResumeStatus.failed) {
            // ResumeCubit's failed state does not carry the typed cause
            // (handled separately), so we use a cause-agnostic honest retry
            // line rather than a false "check internet".
            return BbStatusView(
              icon: Icons.error_outline_rounded,
              title: 'Resume nahi ban paya.',
              subtitle: 'Thodi der baad dobara try karein.',
              action: FilledButton(
                onPressed: () {
                  _navigated = false;
                  context.read<ResumeCubit>().generate();
                },
                child: const Text('Dobara koshish karein'),
              ),
            );
          }
          return const _BuildingBody();
        },
      ),
    );
  }
}

/// Kit 05 — Resume building. A deep-blue full-bleed surface with a DETERMINATE
/// progress bar (haldi on a translucent track), an Anek "STEP n/3" label, and a
/// translucent checklist (✓ done / ● current). Never a bare spinner — the step
/// count is known, so progress is shown as steps.
///
/// The generation work is async (the ResumeCubit), so the three steps are a
/// paced client-side animation across the display window — the resume-generation
/// logic + navigation are untouched, this is only the waiting surface.
class _BuildingBody extends StatelessWidget {
  const _BuildingBody();

  /// Step copy paced with the progress tween — Anek, uppercase, haldi.
  static const List<String> _stepLabels = <String>[
    'STEP 1/3 — DETAILS CHECK HO RAHE HAIN',
    'STEP 2/3 — SKILLS JOD RAHE HAIN',
    'STEP 3/3 — RESUME TAIYAAR HO RAHA HAI',
  ];

  /// Checklist rows, glyph-prefixed per the current step (✓ done, ● current).
  static const List<String> _checklist = <String>[
    'Details check ho gaye',
    'Trade profile ban raha hai',
    'Skills jud rahi hain',
  ];

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: AppColors.blue,
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s7,
            AppSpacing.gutter,
            AppSpacing.gutter,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text('Resume ban raha hai…',
                  style: AppTypography.display(
                      size: AppTypography.sizeXl,
                      weight: FontWeight.w800,
                      color: AppColors.onBlue)),
              const SizedBox(height: AppSpacing.s1),
              Text(
                'Aapki baat se ek branded, share-ready resume taiyaar kar rahe hain.',
                style: AppTypography.body(
                    size: AppTypography.sizeSm, color: AppColors.onBlueMuted),
              ),
              const SizedBox(height: AppSpacing.s6),
              // The pacing tween — 0 → 0.92 so the bar never claims "done" before
              // the cubit actually navigates away. Determinate throughout.
              TweenAnimationBuilder<double>(
                tween: Tween<double>(begin: 0, end: 0.92),
                duration: AppMotion.slower * 6, // ~2.9s across the three steps
                curve: AppMotion.easeInOut,
                builder: (BuildContext context, double t, _) {
                  final int step = (t * 3).clamp(0, 2.999).floor();
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      ClipRRect(
                        borderRadius: BorderRadius.circular(AppRadii.xs),
                        child: LinearProgressIndicator(
                          value: t,
                          minHeight: 9,
                          backgroundColor: Colors.white.withValues(alpha: 0.15),
                          valueColor: const AlwaysStoppedAnimation<Color>(
                              AppColors.haldi),
                        ),
                      ),
                      const SizedBox(height: AppSpacing.s2),
                      Text(
                        _stepLabels[step],
                        style: AppTypography.display(
                          size: AppTypography.sizeXs,
                          weight: FontWeight.w600,
                          color: AppColors.haldi,
                          letterSpacing: 0.4,
                        ),
                      ),
                      const SizedBox(height: AppSpacing.s5),
                      _Checklist(currentStep: step),
                    ],
                  );
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The translucent checklist card — ✓ for completed steps, ● for the current one.
class _Checklist extends StatelessWidget {
  const _Checklist({required this.currentStep});

  final int currentStep;

  @override
  Widget build(BuildContext context) {
    final String text = <String>[
      for (int i = 0; i < _BuildingBody._checklist.length; i++)
        '${i < currentStep ? '✓' : '●'}  ${_BuildingBody._checklist[i]}',
    ].join('\n');

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.s3),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.08),
        border: Border.all(color: Colors.white.withValues(alpha: 0.18)),
        borderRadius: BorderRadius.circular(AppRadii.sm),
      ),
      child: Text(
        text,
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          color: AppColors.onBlueMuted,
          height: 1.8,
        ),
      ),
    );
  }
}
