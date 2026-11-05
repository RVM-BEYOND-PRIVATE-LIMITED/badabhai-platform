import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../router.dart';
import 'cubit/resume_cubit.dart';
import 'widgets/resume_building_body.dart';

/// Onboarding "Resume ban raha hai…" screen (v3 spec §3.22; master Flutter UI
/// kit screen 22).
///
/// Generates the resume on mount (the real work), then enters the shell at the
/// Resume tab — passing the generated text so the tab shows it without
/// re-generating. A minimum display window stops the spinner from flashing.
class BuildingScreen extends StatelessWidget {
  const BuildingScreen({super.key, this.force = false});

  /// When true, bypass the cached resume and re-generate from the server.
  /// Used after a trade-form section walk so the overlay runs against fresh
  /// pack answers (see resume-draft-overlay.ts).
  final bool force;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ResumeCubit>(
      create: (_) => locator<ResumeCubit>()..generate(force: force),
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
          // OWNER ASK (2026-10-22) — the redesigned generation wait.
          return const ResumeBuildingBody();
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
