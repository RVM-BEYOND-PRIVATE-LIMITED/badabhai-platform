import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../voice/data/session_voice_recorder.dart';
import '../data/voice_preflight_probe.dart';
import '../domain/silence_endpointer.dart';
import '../domain/preflight_models.dart';
import 'cubit/preflight_cubit.dart';

// ---- Hinglish copy (bada-bhai persona; aap-form, no vocative, no exclamation).
// Every literal here is scanned by test/persona_neutrality_test.dart. -----------

const String _kTitle = 'Awaaz jaanch';
const String _kListeningCaption = 'Ek pal, aas-paas ki awaaz sun rahe hain.';
const String _kProbingCaption = 'Taiyaari ho rahi hai.';

const String _kQuietTitle = 'Jagah shaant hai';
const String _kQuietBody = 'Aap shuru kar sakte hain.';

const String _kLoudTitle = 'Thodi aawaaz hai';
const String _kLoudBody = 'Chalega. Shaant jagah mile to aur behtar rahega.';

const String _kVeryLoudTitle = 'Kaafi shor hai';
const String _kVeryLoudBody =
    'Auto-aage badhna band rahega. Har jawab ke baad khud aage badhein.';

const String _kMicDeadTitle = 'Mic se awaaz nahi aa rahi';
const String _kMicDeadBody =
    'Mic check karein. Aap chunkar bhi jawab de sakte hain.';

const String _kStartLabel = 'Shuru karein';
const String _kStartAnywayLabel = 'Phir bhi shuru karein';
const String _kRetryLabel = 'Dobara koshish karein';
const String _kBackLabel = 'Wapas jaayein';

/// The quiet-place pre-flight screen (#627). Asks mic permission once, measures
/// the room for 5s, hands the floor to the shared endpointer, probes the upload
/// bucket, then either offers a start (with an honest per-tier verdict and an
/// escape hatch on every noisy tier) or aborts on a dormant bucket.
///
/// Route-agnostic on purpose: [onStart] fires when the worker chooses to begin,
/// and [onExit] backs out. The session route that [onStart] leads to lands in a
/// later issue — this screen owns only the gate, never the destination.
class PreflightScreen extends StatelessWidget {
  const PreflightScreen({super.key, required this.onStart, this.onExit});

  /// The worker chose to begin (from any tier — the calibration is complete).
  final VoidCallback onStart;

  /// Back out of the pre-flight (denied / unavailable / a change of mind).
  final VoidCallback? onExit;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<PreflightCubit>(
      create: (_) => PreflightCubit(
        recorder: locator<SessionVoiceRecorder>(),
        endpointer: locator<SilenceEndpointer>(),
        probe: locator<VoicePreflightProbe>(),
      )..run(),
      child: BbScaffold(
        appBar: const BbAppBar(title: _kTitle),
        body: BlocBuilder<PreflightCubit, PreflightState>(
          builder: (BuildContext context, PreflightState state) =>
              _body(context, state),
        ),
      ),
    );
  }

  Widget _body(BuildContext context, PreflightState state) {
    return switch (state) {
      PreflightRequestingPermission() =>
        const BbStatusView.loading(caption: _kProbingCaption),
      PreflightCalibrating() =>
        const BbStatusView.loading(caption: _kListeningCaption),
      PreflightProbing() =>
        const BbStatusView.loading(caption: _kProbingCaption),
      PreflightPermissionDenied() => BbStatusView(
          icon: Icons.mic_off_outlined,
          iconColor: AppColors.danger,
          title: _kMicDeadTitle,
          subtitle: state.failure.message,
          action: _ghostBack(),
        ),
      PreflightUnavailable() => BbStatusView(
          icon: Icons.cloud_off_outlined,
          iconColor: AppColors.textMuted,
          title: _kVoiceOffTitle,
          subtitle: state.failure.message,
          action: _ghostBack(),
        ),
      PreflightFailed() => BbStatusView(
          icon: Icons.error_outline,
          iconColor: AppColors.danger,
          title: _kVoiceOffTitle,
          subtitle: state.failure.message,
          action: BbButton(
            label: _kRetryLabel,
            variant: BbButtonVariant.outline,
            onPressed: onExit,
          ),
        ),
      PreflightReady() => _ready(state),
    };
  }

  Widget _ghostBack() =>
      BbButton(label: _kBackLabel, variant: BbButtonVariant.ghost, onPressed: onExit);

  Widget _ready(PreflightReady state) {
    final (String title, String bodyCopy) = switch (state.verdict) {
      PreflightVerdict.quiet => (_kQuietTitle, _kQuietBody),
      PreflightVerdict.loud => (_kLoudTitle, _kLoudBody),
      PreflightVerdict.veryLoud => (_kVeryLoudTitle, _kVeryLoudBody),
      PreflightVerdict.micDead => (_kMicDeadTitle, _kMicDeadBody),
    };
    // A quiet room gets a plain hero start; every noisier tier gets the ghost
    // "start anyway" escape so the worker is never trapped behind a noise check.
    final bool clean = state.verdict == PreflightVerdict.quiet;
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Icon(
            clean ? Icons.check_circle_outline : Icons.graphic_eq,
            size: AppSpacing.s9,
            color: clean ? AppColors.success : AppColors.warning,
          ),
          const SizedBox(height: AppSpacing.s4),
          Text(title, style: AppTypography.display(size: 22), textAlign: TextAlign.center),
          const SizedBox(height: AppSpacing.s2),
          Text(
            bodyCopy,
            style: AppTypography.body(color: AppColors.textSecondary),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: AppSpacing.s7),
          BbButton(
            label: clean ? _kStartLabel : _kStartAnywayLabel,
            block: true,
            onPressed: onStart,
          ),
        ],
      ),
    );
  }
}

/// Title reused for "voice is off right now" — both the 503 abort and an
/// unexpected failure land the worker on the same honest heading.
const String _kVoiceOffTitle = 'Voice abhi available nahi hai';
