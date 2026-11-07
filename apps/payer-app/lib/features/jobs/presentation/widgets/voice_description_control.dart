import 'package:flutter/material.dart';

import '../../../../core/audio/speech_dictation.dart';
import '../../../../core/data/models.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';

/// The mic toggle beside the job Description field (#2720).
///
/// Speaks a Hinglish note into the device recogniser, POSTs the transcript to
/// the draft endpoint, and lands the returned English description in the
/// poster's EDITABLE box. A null draft leaves whatever was typed untouched and
/// shows a small retry state. Nothing here stores or publishes anything — the
/// normal create/edit path persists the reviewed text.
class VoiceDescriptionControl extends StatefulWidget {
  const VoiceDescriptionControl({
    super.key,
    required this.onDraft,
    required this.onFilled,
    this.dictation,
  });

  /// POST the transcript; the caller supplies the Step-1 trade/role labels.
  final Future<JobDescriptionDraft> Function(String spokenText) onDraft;

  /// The draft to put in the editable Description box (non-null only).
  final ValueChanged<String> onFilled;

  /// Test seam; production uses the platform recogniser.
  final SpeechDictation? dictation;

  @override
  State<VoiceDescriptionControl> createState() =>
      _VoiceDescriptionControlState();
}

enum _VoiceStatus { idle, listening, drafting, failed }

class _VoiceDescriptionControlState extends State<VoiceDescriptionControl> {
  late final SpeechDictation _dictation =
      widget.dictation ?? SpeechToTextDictation();

  _VoiceStatus _status = _VoiceStatus.idle;
  String _heard = '';
  String _message = '';

  /// Guards a late async answer from an older attempt.
  int _attempt = 0;

  bool get _busy => _status == _VoiceStatus.drafting;

  @override
  void dispose() {
    if (_status == _VoiceStatus.listening) _dictation.cancel();
    super.dispose();
  }

  Future<void> _toggle() async {
    switch (_status) {
      case _VoiceStatus.listening:
        await _finish();
      case _VoiceStatus.drafting:
        return;
      case _VoiceStatus.failed:
        // A transcript is already in hand: retry that, never re-record.
        if (_heard.isNotEmpty) {
          await _draft(_heard);
        } else {
          await _start();
        }
      case _VoiceStatus.idle:
        await _start();
    }
  }

  Future<void> _start() async {
    bool ready;
    try {
      ready = await _dictation.initialize();
    } catch (_) {
      ready = false;
    }
    if (!mounted) return;
    if (!ready) {
      setState(() {
        _status = _VoiceStatus.failed;
        _heard = '';
        _message = 'Microphone unavailable. Type the description instead.';
      });
      return;
    }
    _heard = '';
    setState(() {
      _status = _VoiceStatus.listening;
      _message = '';
    });
    try {
      await _dictation.listen(
        onResult: (String words, bool isFinal) {
          final String heard = words.trim();
          if (heard.isNotEmpty) _heard = heard;
        },
        onDone: () {
          // The platform ended the session on its own (silence timeout): settle
          // and draft what was heard, exactly as a Stop tap would.
          if (mounted && _status == _VoiceStatus.listening) _finish();
        },
      );
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _status = _VoiceStatus.failed;
        _message = 'Could not start the microphone. Type the description instead.';
      });
    }
  }

  Future<void> _finish() async {
    if (_status != _VoiceStatus.listening) return;
    setState(() => _status = _VoiceStatus.drafting);
    try {
      await _dictation.stop();
    } catch (_) {
      // Best effort — the transcript already in hand is what matters.
    }
    final String transcript = _heard.trim();
    if (transcript.isEmpty) {
      if (!mounted) return;
      setState(() {
        _status = _VoiceStatus.failed;
        _message = "Didn't catch that. Tap and speak again.";
      });
      return;
    }
    await _draft(transcript);
  }

  Future<void> _draft(String spokenText) async {
    final int attempt = ++_attempt;
    setState(() {
      _status = _VoiceStatus.drafting;
      _message = '';
    });
    try {
      final JobDescriptionDraft draft = await widget.onDraft(spokenText);
      if (!mounted || attempt != _attempt) return;
      final String? description = draft.description?.trim();
      if (description == null || description.isEmpty) {
        setState(() {
          _status = _VoiceStatus.failed;
          _message = 'No draft this time. Your text is unchanged — retry or keep it.';
        });
        return;
      }
      widget.onFilled(description);
      if (!mounted || attempt != _attempt) return;
      setState(() {
        _status = _VoiceStatus.idle;
        _message = 'Draft added. Review it before posting.';
      });
    } catch (_) {
      if (!mounted || attempt != _attempt) return;
      setState(() {
        _status = _VoiceStatus.failed;
        _message = 'Could not draft the description. Your text is unchanged.';
      });
    }
  }

  String get _label => switch (_status) {
        _VoiceStatus.idle => 'Speak description',
        _VoiceStatus.listening => 'Stop and draft',
        _VoiceStatus.drafting => 'Drafting…',
        _VoiceStatus.failed => _heard.isNotEmpty ? 'Retry draft' : 'Try again',
      };

  String get _hint => switch (_status) {
        _VoiceStatus.idle => _message.isEmpty
            ? 'Speak in Hinglish — we draft the English description for you to review.'
            : _message,
        _VoiceStatus.listening => 'Listening… speak now, then tap Stop.',
        _VoiceStatus.drafting => 'Turning your note into English…',
        _VoiceStatus.failed => _message,
      };

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Align(
          alignment: Alignment.centerLeft,
          child: BbButton(
            buttonKey: const Key('voice_description_button'),
            label: _label,
            variant: BbButtonVariant.secondary,
            size: BbButtonSize.md,
            iconLeft: _status == _VoiceStatus.listening
                ? Icons.stop_rounded
                : Icons.mic_rounded,
            loading: _busy,
            onPressed: _busy ? null : _toggle,
          ),
        ),
        const SizedBox(height: AppSpacing.s1),
        Text(
          _hint,
          key: const Key('voice_description_hint'),
          style: AppTypography.body(
            size: AppTypography.sizeXs,
            color: AppColors.textMuted,
            height: 1.35,
          ),
        ),
        if (_status == _VoiceStatus.failed && _heard.isNotEmpty)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              key: const Key('voice_description_retry'),
              onPressed: () => _draft(_heard),
              child: const Text('Retry'),
            ),
          ),
      ],
    );
  }
}
