import 'package:flutter/material.dart';

import '../../../../core/theme/app_haptics.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_action_bar.dart';

/// The 5-step chrome shared by Post-a-job and both edit screens (#2713).
///
/// Kept out of `post_job_screen.dart` so the edit forms can render the SAME
/// header, step meter, jump tabs and docked CTA without copying them.
class JobWizardScaffold extends StatelessWidget {
  const JobWizardScaffold({
    super.key,
    required this.title,
    required this.step,
    required this.stepCount,
    required this.stepNames,
    required this.stepShortNames,
    required this.body,
    required this.last,
    required this.loading,
    required this.onNext,
    required this.onExit,
    required this.onPrevious,
    required this.onSelectStep,
    this.subtitle = 'HIRING DETAILS',
    this.subtitleListenable,
    this.subtitleOf,
    this.lastLabel = 'Save changes',
    this.footerNote,
    this.scrollKey,
    this.canAdvance = true,
  });

  final String title;
  final int step;
  final int stepCount;
  final List<String> stepNames;
  final List<String> stepShortNames;
  final Widget body;
  final bool last;
  final bool loading;
  final VoidCallback onNext;
  final VoidCallback onExit;
  final VoidCallback onPrevious;
  final ValueChanged<int> onSelectStep;
  final String subtitle;
  final Listenable? subtitleListenable;
  final String Function()? subtitleOf;
  final String lastLabel;
  final String? footerNote;
  final Key? scrollKey;
  final bool canAdvance;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _kCanvas,
      bottomNavigationBar: BbActionBar(
        child: _WizardCta(
          last: last,
          lastLabel: lastLabel,
          loading: loading,
          onPressed: canAdvance ? onNext : null,
        ),
      ),
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            _header(context),
            Expanded(
              child: SingleChildScrollView(
                key: scrollKey,
                keyboardDismissBehavior:
                    ScrollViewKeyboardDismissBehavior.onDrag,
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.gutter,
                  AppSpacing.s4,
                  AppSpacing.gutter,
                  AppSpacing.s6,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    if (last)
                      body
                    else
                      MediaQuery(
                        data: MediaQuery.of(context).copyWith(
                          textScaler: const TextScaler.linear(0.88),
                        ),
                        child: body,
                      ),
                    const SizedBox(height: AppSpacing.s6),
                    Text(
                      footerNote ?? '100% FREE',
                      textAlign: TextAlign.center,
                      style: AppTypography.body(
                        size: AppTypography.size2xs,
                        weight: FontWeight.w700,
                        color: _kMuted.withValues(alpha: 0.55),
                        letterSpacing: 1.2,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _header(BuildContext context) => Container(
        color: _kPaper,
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.gutter,
          AppSpacing.s3,
          AppSpacing.gutter,
          AppSpacing.s3,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Row(
              children: <Widget>[
                _BackButton(
                  onPressed: step == 0 ? onExit : onPrevious,
                ),
                const SizedBox(width: AppSpacing.s3),
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Text(
                        title,
                        textAlign: TextAlign.center,
                        style: AppTypography.header(
                          size: AppTypography.sizeLg,
                          weight: FontWeight.w800,
                          color: _kBrandBlue,
                          letterSpacing: -0.4,
                        ),
                      ),
                      const SizedBox(height: 2),
                      if (subtitleListenable != null && subtitleOf != null)
                        ListenableBuilder(
                          listenable: subtitleListenable!,
                          builder: (BuildContext context, Widget? _) =>
                              _subtitleText(subtitleOf!()),
                        )
                      else
                        _subtitleText(subtitle),
                    ],
                  ),
                ),
                const SizedBox(width: AppSpacing.s3),
                const _WizardLogo(),
              ],
            ),
            const SizedBox(height: AppSpacing.s4),
            _stepMeter(),
            const SizedBox(height: AppSpacing.s2),
            _stepTabs(),
          ],
        ),
      );

  Widget _subtitleText(String text) => Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        textAlign: TextAlign.center,
        style: AppTypography.body(
          size: AppTypography.size2xs,
          weight: FontWeight.w700,
          color: _kMuted,
          letterSpacing: 0.8,
        ),
      );

  Widget _stepMeter() {
    final int percent = ((step + 1) / stepCount * 100).round();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: Text(
                'STEP ${step + 1} OF $stepCount: '
                '${stepNames[step].toUpperCase()}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppTypography.body(
                  size: AppTypography.size2xs,
                  weight: FontWeight.w800,
                  color: _kMuted,
                  letterSpacing: 0.7,
                ),
              ),
            ),
            const SizedBox(width: AppSpacing.s2),
            Text(
              '$percent%',
              style: AppTypography.body(
                size: AppTypography.size2xs,
                weight: FontWeight.w800,
                color: _kBrandBlue,
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.gap6),
        ClipRRect(
          borderRadius: BorderRadius.circular(AppRadii.pill),
          child: SizedBox(
            height: 4,
            child: ColoredBox(
              color: _kProgressTrack,
              child: TweenAnimationBuilder<double>(
                tween: Tween<double>(end: step / (stepCount - 1)),
                duration: const Duration(milliseconds: 260),
                curve: Curves.easeOut,
                builder: (BuildContext context, double value, Widget? _) =>
                    FractionallySizedBox(
                  alignment: Alignment.centerLeft,
                  widthFactor: value.clamp(0.0, 1.0),
                  child: const ColoredBox(color: _kBrandBlue),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _stepTabs() => SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            for (int i = 0; i < stepCount; i++) ...<Widget>[
              if (i > 0) const SizedBox(width: AppSpacing.s2),
              _StepPill(
                key: Key('job_wizard_step_$i'),
                number: i + 1,
                label: stepShortNames[i],
                active: i == step,
                onTap: () => onSelectStep(i),
              ),
            ],
          ],
        ),
      );
}

const Color _kBrandBlue = Color(0xFF05194C);
const Color _kBrandYellow = Color(0xFFFFB32C);
const Color _kCanvas = Color(0xFFF2F4F8);
const Color _kPaper = Color(0xFFFFFFFF);
const Color _kMuted = Color(0xFF667085);
const Color _kHairline = Color(0xFFD8DEE9);
const Color _kProgressTrack = Color(0xFFE5E9F1);
const Color _kPillIdle = Color(0xFFF2F4F8);

class _BackButton extends StatelessWidget {
  const _BackButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Back',
      child: Material(
        color: _kPaper,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: const BorderSide(color: _kHairline),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onPressed,
          child: const SizedBox(
            width: 40,
            height: 40,
            child: Icon(Icons.arrow_back_rounded, size: 20, color: _kBrandBlue),
          ),
        ),
      ),
    );
  }
}

/// The official BadaBhai two-person mark on the dark-blue theme disc.
class _WizardLogo extends StatelessWidget {
  const _WizardLogo();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'BadaBhai',
      image: true,
      child: Container(
        width: 40,
        height: 40,
        padding: const EdgeInsets.all(6),
        decoration: const BoxDecoration(
          color: _kBrandBlue,
          shape: BoxShape.circle,
        ),
        child: Image.asset(
          'assets/brand/badabhai-mark.png',
          fit: BoxFit.contain,
          filterQuality: FilterQuality.high,
          excludeFromSemantics: true,
        ),
      ),
    );
  }
}

class _StepPill extends StatelessWidget {
  const _StepPill({
    super.key,
    required this.number,
    required this.label,
    required this.active,
    required this.onTap,
  });

  final int number;
  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final Color foreground = active ? _kPaper : _kMuted;
    return Semantics(
      button: true,
      selected: active,
      label: 'Step $number $label',
      child: Material(
        color: active ? _kBrandBlue : _kPaper,
        borderRadius: BorderRadius.circular(AppRadii.sm),
        child: InkWell(
          borderRadius: BorderRadius.circular(AppRadii.sm),
          onTap: onTap,
          child: Container(
            height: 44,
            padding: const EdgeInsets.symmetric(horizontal: 10),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(AppRadii.sm),
              border: Border.all(
                color: active ? _kBrandBlue : _kHairline,
              ),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Container(
                  width: 18,
                  height: 18,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color:
                        active ? _kPaper.withValues(alpha: 0.16) : _kPillIdle,
                    shape: BoxShape.circle,
                  ),
                  child: Text(
                    '$number',
                    style: AppTypography.body(
                      size: 10,
                      weight: FontWeight.w800,
                      color: foreground,
                    ),
                  ),
                ),
                const SizedBox(width: 5),
                Text(
                  label,
                  maxLines: 1,
                  style: AppTypography.body(
                    size: 11,
                    weight: FontWeight.w700,
                    color: foreground,
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

class _WizardCta extends StatelessWidget {
  const _WizardCta({
    required this.last,
    required this.lastLabel,
    required this.loading,
    required this.onPressed,
  });

  final bool last;
  final String lastLabel;
  final bool loading;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final bool enabled = onPressed != null && !loading;
    return SizedBox(
      height: AppSpacing.controlLg,
      child: FilledButton(
        onPressed: enabled
            ? () {
                AppHaptics.tap();
                onPressed!();
              }
            : null,
        style: FilledButton.styleFrom(
          backgroundColor: _kBrandYellow,
          foregroundColor: _kBrandBlue,
          disabledBackgroundColor: _kBrandYellow.withValues(alpha: 0.45),
          disabledForegroundColor: _kBrandBlue.withValues(alpha: 0.55),
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
          textStyle: AppTypography.heading(
            size: AppTypography.sizeBase,
            weight: FontWeight.w700,
          ),
        ),
        child: loading
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: _kBrandBlue,
                ),
              )
            : Row(
                mainAxisAlignment: MainAxisAlignment.center,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Text(last ? lastLabel : 'Aage badhein'),
                  if (!last) ...<Widget>[
                    const SizedBox(width: AppSpacing.s2),
                    const Icon(Icons.arrow_forward_rounded, size: 18),
                  ],
                ],
              ),
      ),
    );
  }
}
