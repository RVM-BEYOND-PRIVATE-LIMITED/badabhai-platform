import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_spinner.dart';
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

class _BuildingBody extends StatelessWidget {
  const _BuildingBody();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.gutter),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const BbSpinner(),
            const SizedBox(height: AppSpacing.s5),
            Text('Resume ban raha hai…',
                textAlign: TextAlign.center,
                style: AppTypography.display(
                    size: AppTypography.sizeXl, weight: FontWeight.w800)),
            const SizedBox(height: AppSpacing.s2),
            Text(
              'Aapki baat se ek branded, share-ready resume taiyaar kar rahe hain.',
              textAlign: TextAlign.center,
              style: AppTypography.body(color: AppColors.textSecondary),
            ),
          ],
        ),
      ),
    );
  }
}
