import 'package:flutter/material.dart';

import '../../../../core/error/failure.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/util/devanagari_guard.dart';
import '../../domain/spoken_work_description.dart';

/// Copy. Aap-form, no vocatives, no tum-form imperatives — every literal under
/// `lib/` is scanned by `persona_neutrality_test`.
const String kWorkMicIdleLabel = 'Bol kar bharein';
const String kWorkMicRecordingLabel = 'Sun rahe hain… rokne ke liye dabayein';
const String kWorkMicWorkingLabel = 'Likh rahe hain…';
const String kWorkMicPermissionDenied =
    'Mic ki permission nahi mili. Neeche khud likh sakte hain.';
const String kWorkMicFailed =
    'Awaaz nahi pakad paaye. Dobara try karein, ya neeche khud likhein.';

/// Stable finders for tests.
const Key kWorkMicButtonKey = Key('tradeFormWorkMicButton');
const Key kWorkMicStatusKey = Key('tradeFormWorkMicStatus');

/// The mic beside the work-history "Aap kya kaam karte the?" field (#1472).
///
/// SPEAKING IS AN EXTRA, NEVER A DEPENDENCY. The text field beside this widget
/// stays fully usable in every state: no permission, no consent, a failed
/// transcription, and — the default today — the whole voice stack switched off
/// server-side (`VOICE_NOTES_BUCKET` unset ⇒ 503). On a 503 this hides itself
/// entirely rather than showing a dead button, matching the chat mic.
///
/// NOT A TEXT FIELD, deliberately: the employment page's tests count
/// `TextField`s positionally to assert which inputs a card shows, so a mic that
/// contained one would silently break them — and a worker does not need a
/// second box to speak into.
class TradeFormWorkMic extends StatefulWidget {
  const TradeFormWorkMic({
    super.key,
    required this.recorder,
    required this.sessionId,
    required this.enabled,
    required this.onTranscript,
  });

  /// Null when the app has no mic wired at all (the trade-form tests register
  /// only the cubit) — the widget then renders nothing.
  final SpokenWorkDescriptionRecorder? recorder;

  /// The trade form's own session, from the schema response. Null on an older
  /// server that does not send one; treated exactly like a 503 — no mic.
  final String? sessionId;

  final bool enabled;

  /// Fired with the worker's words and the clip they came from. The caller
  /// puts the text in the box and keeps the id beside it.
  final void Function(String transcript, String voiceNoteId) onTranscript;

  @override
  State<TradeFormWorkMic> createState() => _TradeFormWorkMicState();
}

enum _MicPhase { idle, recording, working }

class _TradeFormWorkMicState extends State<TradeFormWorkMic> {
  _MicPhase _phase = _MicPhase.idle;
  String? _note;

  /// Set once the server has told us the voice stack is off. Latched, so a
  /// worker is not offered a mic that just failed for everyone.
  bool _unavailable = false;

  bool get _canSpeak =>
      widget.recorder != null && widget.sessionId != null && !_unavailable;

  Future<void> _onPressed() async {
    if (_phase == _MicPhase.working) return;
    if (_phase == _MicPhase.recording) {
      await _stop();
      return;
    }
    await _start();
  }

  Future<void> _start() async {
    final SpokenWorkDescriptionRecorder recorder = widget.recorder!;
    setState(() => _note = null);
    final bool granted = await recorder.ensurePermission();
    if (!mounted) return;
    if (!granted) {
      // Not a failure of the form — say what happened and point at the box.
      setState(() => _note = kWorkMicPermissionDenied);
      return;
    }
    try {
      await recorder.start();
      if (!mounted) return;
      setState(() => _phase = _MicPhase.recording);
    } on VoiceUnavailableFailure {
      if (!mounted) return;
      setState(() => _unavailable = true);
    } catch (_) {
      if (!mounted) return;
      setState(() => _note = kWorkMicFailed);
    }
  }

  Future<void> _stop() async {
    setState(() => _phase = _MicPhase.working);
    try {
      final SpokenWorkDescription spoken =
          await widget.recorder!.stopAndTranscribe(
        sessionId: widget.sessionId!,
      );
      if (!mounted) return;
      setState(() => _phase = _MicPhase.idle);
      // The résumé prints Roman script, and the field's own formatter only
      // runs on typed input — an assigned transcript bypasses it — so the
      // guard is applied HERE instead.
      final String clean = stripDevanagari(spoken.transcript).trim();
      if (clean.isEmpty) {
        setState(() => _note = kWorkMicFailed);
        return;
      }
      widget.onTranscript(clean, spoken.voiceNoteId);
    } on VoiceUnavailableFailure {
      // The stack is off server-side. Stop offering the mic; the box is fine.
      if (!mounted) return;
      setState(() {
        _phase = _MicPhase.idle;
        _unavailable = true;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _phase = _MicPhase.idle;
        _note = kWorkMicFailed;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_canSpeak) return const SizedBox.shrink();

    final String label = switch (_phase) {
      _MicPhase.idle => kWorkMicIdleLabel,
      _MicPhase.recording => kWorkMicRecordingLabel,
      _MicPhase.working => kWorkMicWorkingLabel,
    };
    final bool live = _phase == _MicPhase.recording;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const SizedBox(height: AppSpacing.s2),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            key: kWorkMicButtonKey,
            onPressed: (widget.enabled && _phase != _MicPhase.working)
                ? _onPressed
                : null,
            icon: Icon(
              live ? Icons.stop_circle_rounded : Icons.mic_rounded,
              color: live ? AppColors.danger : AppColors.blue,
            ),
            label: Text(
              label,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                weight: FontWeight.w600,
                color: live ? AppColors.danger : AppColors.blue,
              ),
            ),
            style: TextButton.styleFrom(
              // The worker tap floor; a mic that is hard to hit is no mic.
              minimumSize: const Size(0, AppSpacing.tap),
            ),
          ),
        ),
        if (_note != null)
          Padding(
            key: kWorkMicStatusKey,
            padding: const EdgeInsets.only(top: AppSpacing.s1),
            child: Text(
              _note!,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textMuted,
              ),
            ),
          ),
      ],
    );
  }
}
