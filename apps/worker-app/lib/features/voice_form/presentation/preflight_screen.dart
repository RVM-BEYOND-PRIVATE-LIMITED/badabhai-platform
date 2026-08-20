import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../core/widgets/bb_scroll_safe_body.dart';
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

// #680.2 — permission-denied is DISTINCT from a dead mic: the fix is settings,
// not the mic, so the title must point there and not contradict its subtitle.
const String _kPermissionTitle = 'Mic ki permission chahiye';

// #680.4 — a consent (403) / session (401) failure on /voice/upload-url is NOT
// "voice is off"; it routes to the consent screen / re-login.
const String _kConsentTitle = 'Pehle sehmati chahiye';
const String _kConsentBody = 'Voice profile ke liye sehmati zaroori hai.';
const String _kConsentAction = 'Sehmati dein';
const String _kReauthTitle = 'Dobara login karein';
const String _kReauthBody = 'Aapka session khatam ho gaya. Dobara login karein.';
const String _kReauthAction = 'Login karein';

const String _kStartLabel = 'Shuru karein';
const String _kStartAnywayLabel = 'Phir bhi shuru karein';
const String _kRetryLabel = 'Dobara koshish karein';
const String _kBackLabel = 'Wapas jaayein';

/// Title reused for "voice is off right now" — the 503 abort and an unexpected
/// failure land on the same honest heading.
const String _kVoiceOffTitle = 'Voice abhi available nahi hai';

/// The quiet-place pre-flight screen (#627). Asks mic permission once, measures
/// the room for 5s, hands the floor to the shared endpointer, probes the upload
/// bucket, then either offers a start (with an honest per-tier verdict and an
/// escape hatch on every noisy tier) or aborts.
///
/// Stateful because [PreflightCubit.run] is ONE-SHOT per instance (#680.3): a
/// real "Dobara koshish karein" must REMOUNT the cubit, which a bumped
/// [_attempt] key does — recreating the BlocProvider builds a fresh cubit and
/// re-runs the whole pre-flight.
///
/// Route-agnostic: [onStart] begins, [onExit] backs out, and [onConsentRequired]
/// / [onReauthRequired] route a consent / session failure to the right place
/// (falling back to a plain back-out when not wired).
class PreflightScreen extends StatefulWidget {
  const PreflightScreen({
    super.key,
    required this.onStart,
    this.onExit,
    this.onConsentRequired,
    this.onReauthRequired,
  });

  final VoidCallback onStart;
  final VoidCallback? onExit;

  /// The upload probe hit a consent gate (403) — route to the consent screen.
  final VoidCallback? onConsentRequired;

  /// The session expired (401) — route to re-login.
  final VoidCallback? onReauthRequired;

  @override
  State<PreflightScreen> createState() => _PreflightScreenState();
}

class _PreflightScreenState extends State<PreflightScreen> {
  /// Bumped on retry so the [BlocProvider] key changes and a FRESH one-shot
  /// cubit is built + re-run (#680.3).
  int _attempt = 0;

  void _retry() => setState(() => _attempt++);

  @override
  Widget build(BuildContext context) {
    return BlocProvider<PreflightCubit>(
      key: ValueKey<int>(_attempt),
      create: (_) => PreflightCubit(
        recorder: locator<SessionVoiceRecorder>(),
        endpointer: locator<SilenceEndpointer>(),
        probe: locator<VoicePreflightProbe>(),
      )..run(),
      child: BbScaffold(
        appBar: const BbAppBar(title: _kTitle),
        body: BlocBuilder<PreflightCubit, PreflightState>(
          builder: (BuildContext context, PreflightState state) =>
              _body(state),
        ),
      ),
    );
  }

  Widget _body(PreflightState state) {
    return switch (state) {
      PreflightRequestingPermission() =>
        const BbStatusView.loading(caption: _kProbingCaption),
      PreflightCalibrating() =>
        const BbStatusView.loading(caption: _kListeningCaption),
      PreflightProbing() =>
        const BbStatusView.loading(caption: _kProbingCaption),
      // #680.2 — a permission-specific title over the settings subtitle. Retry
      // remounts (re-asks permission after the worker fixes settings).
      PreflightPermissionDenied() => BbStatusView(
          icon: Icons.mic_off_outlined,
          iconColor: AppColors.danger,
          title: _kPermissionTitle,
          subtitle: state.failure.message,
          action: _retryThenBack(),
        ),
      PreflightUnavailable() => BbStatusView(
          icon: Icons.cloud_off_outlined,
          iconColor: AppColors.textMuted,
          title: _kVoiceOffTitle,
          subtitle: state.failure.message,
          action: _ghostBack(),
        ),
      PreflightFailed() => _failed(state.failure),
      PreflightReady() => _ready(state),
    };
  }

  /// #680.4 — route consent / auth failures to the right destination instead of
  /// the generic "voice is off" bucket; a transient failure gets a REAL retry.
  Widget _failed(Failure failure) {
    if (failure is ConsentRequiredFailure) {
      return BbStatusView(
        icon: Icons.verified_user_outlined,
        iconColor: AppColors.warning,
        title: _kConsentTitle,
        subtitle: _kConsentBody,
        action: widget.onConsentRequired != null
            ? BbButton(
                label: _kConsentAction,
                onPressed: widget.onConsentRequired,
              )
            : _ghostBack(),
      );
    }
    if (failure is UnauthorizedFailure) {
      return BbStatusView(
        icon: Icons.lock_outline,
        iconColor: AppColors.warning,
        title: _kReauthTitle,
        subtitle: _kReauthBody,
        action: widget.onReauthRequired != null
            ? BbButton(label: _kReauthAction, onPressed: widget.onReauthRequired)
            : _ghostBack(),
      );
    }
    return BbStatusView(
      icon: Icons.error_outline,
      iconColor: AppColors.danger,
      title: _kVoiceOffTitle,
      subtitle: failure.message,
      action: _retryThenBack(),
    );
  }

  Widget _ghostBack() => BbButton(
      label: _kBackLabel,
      variant: BbButtonVariant.ghost,
      onPressed: widget.onExit);

  /// A working "Dobara koshish karein" (remounts the cubit) plus a ghost back.
  Widget _retryThenBack() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        BbButton(
          label: _kRetryLabel,
          variant: BbButtonVariant.outline,
          onPressed: _retry,
        ),
        const SizedBox(height: AppSpacing.s2),
        _ghostBack(),
      ],
    );
  }

  Widget _ready(PreflightReady state) {
    final (String title, String bodyCopy) = switch (state.verdict) {
      PreflightVerdict.quiet => (_kQuietTitle, _kQuietBody),
      PreflightVerdict.loud => (_kLoudTitle, _kLoudBody),
      PreflightVerdict.veryLoud => (_kVeryLoudTitle, _kVeryLoudBody),
      PreflightVerdict.micDead => (_kMicDeadTitle, _kMicDeadBody),
    };
    final bool clean = state.verdict == PreflightVerdict.quiet;
    // Scroll-safe: the verdict + start CTA centre on a tall screen and scroll
    // (never a RenderFlex overflow) on a short handset or at a large text scale.
    return BbScrollSafeBody(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Icon(
            clean ? Icons.check_circle_outline : Icons.graphic_eq,
            size: AppSpacing.s9,
            color: clean ? AppColors.success : AppColors.warning,
          ),
          const SizedBox(height: AppSpacing.s4),
          Text(title,
              style: AppTypography.display(size: AppTypography.sizeXl),
              textAlign: TextAlign.center),
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
            onPressed: widget.onStart,
          ),
        ],
      ),
    );
  }
}
