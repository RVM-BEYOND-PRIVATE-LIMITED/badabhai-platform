import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/util/devanagari_guard.dart';
import '../../../chat/presentation/widgets/voice_wave_visualizer.dart';
import '../../../voice/presentation/dictation_controller.dart';

/// Copy. Aap-form, no vocatives, no tum-form imperatives — every literal under
/// `lib/` is scanned by `persona_neutrality_test`.
const String kWorkDictationIdleLabel = 'Bol kar bharein';
const String kWorkDictationStopLabel = 'Rokein';

/// What a screen reader is told while the recogniser is live. A [CustomPaint]
/// has no semantics of its own, so without this the most important state on the
/// row — the mic is hot — reaches a blind worker as nothing at all.
const String kWorkDictationListeningLabel = 'Sun rahe hain…';

/// Shown when the recogniser ran and heard nothing at all. HONEST: it names what
/// happened and points at the box, rather than implying the feature is broken.
const String kWorkDictationHeardNothing =
    'Kuch sunai nahi diya. Dobara boliye ya neeche khud likhein.';

/// Stable finders for tests.
const Key kWorkDictationButtonKey = Key('tradeFormWorkDictationButton');
const Key kWorkDictationWaveKey = Key('tradeFormWorkDictationWave');
const Key kWorkDictationStatusKey = Key('tradeFormWorkDictationStatus');

/// LIVE voice-to-text for the work-history "Aap kya kaam karte the?" field.
///
/// ═══ WHY THIS REPLACED THE RECORD-AND-UPLOAD MIC ═══
///
/// The previous mic (#1472) recorded a clip, uploaded it to `/voice/*`, and
/// waited on Sarvam STT. Three things made that a dead end on this field:
/// nothing on the path is reached until the worker has ALREADY spoken (the
/// first network call lives in `stopAndTranscribe`), so a dormant voice stack
/// was discovered only after a recording existed and was then thrown away; it
/// needed a `chat_sessions` row to file the clip under, which a worker who
/// reached the form through résumé upload does not have; and it was a SECOND
/// dictation implementation alongside the chat composer's, free to drift.
///
/// This is the chat composer's own [DictationController] — the device
/// recogniser, transcribing AS THE WORKER SPEAKS. It talks to no BadaBhai
/// server: no upload, no `/voice/*` call, no AI spend, no session id, and no
/// bucket to provision. The words are ordinary text the worker can edit.
///
/// ═══ NO CLIP MEANS NO CLIP ID ═══
///
/// `work_done_voice_note_id` is provenance for a stored recording. There is no
/// recording here, so the caller sends the description alone — which is what
/// `PUT /workers/me/employment` has always accepted. The refusal it enforces is
/// the other direction: an id with no description beside it.
///
/// ═══ NOT A TEXT FIELD, DELIBERATELY ═══
///
/// The employment page's tests count `TextField`s positionally to assert which
/// inputs a card shows, so a control that contained one would silently break
/// them — and a worker does not need a second box to speak into. The recognised
/// words land in the field this sits under.
class TradeFormWorkDictation extends StatefulWidget {
  const TradeFormWorkDictation({
    super.key,
    required this.controller,
    required this.enabled,
    required this.maxLength,
    required this.onText,
  });

  /// The work-description field's own controller. Read to SEED the recogniser
  /// (so anything already typed is preserved and spoken words continue it), and
  /// written when the words land.
  final TextEditingController controller;

  final bool enabled;

  /// The server's own ceiling on the description. Recogniser output can run past
  /// it, and an over-length string is a 400 that costs the worker their WHOLE
  /// work history — so it is applied here, before the text is pushed.
  final int maxLength;

  /// Fired with the final text after it has been cleaned and capped, so the host
  /// can push the entry. Assigning [controller] bypasses both the field's input
  /// formatter and its `onChanged`, which is exactly why this exists.
  final ValueChanged<String> onText;

  @override
  State<TradeFormWorkDictation> createState() => _TradeFormWorkDictationState();
}

class _TradeFormWorkDictationState extends State<TradeFormWorkDictation> {
  late final DictationController _dictation;

  /// Worker-facing note under the control — a failure, or the Devanagari rule.
  /// Never carries the worker's own words.
  String? _note;

  @override
  void initState() {
    super.initState();
    _dictation = DictationController(
      onNotice: _showNote,
      // Backgrounding the app, or another card's mic taking the shared
      // recogniser, ends dictation with no Stop left to tap. Land the words
      // anyway — otherwise they are simply gone.
      onInterrupted: _land,
    )..addListener(_onDictationChanged);
  }

  @override
  void dispose() {
    _dictation
      ..removeListener(_onDictationChanged)
      ..dispose();
    super.dispose();
  }

  void _onDictationChanged() {
    if (mounted) setState(() {});
  }

  void _showNote(String text) {
    if (mounted) setState(() => _note = text);
  }

  /// Tap the mic: start voice-to-text. Anything already typed is PRESERVED —
  /// recognised words append onto it inside the controller — so the mic never
  /// eats a half-typed description.
  ///
  /// The keyboard is dismissed for the duration because the recognised block
  /// REPLACES the field's contents when it lands: anything typed while the mic
  /// ran would be destroyed by that assignment, silently.
  Future<void> _start() async {
    if (!widget.enabled) return;
    setState(() => _note = null);
    FocusScope.of(context).unfocus();
    await _dictation.start(initialText: widget.controller.text);
  }

  /// Tap Rokein: end listening and drop the words into the SAME box, so the
  /// worker reads them and fixes them before saving. Nothing is uploaded.
  void _stop() {
    final String heard = _dictation.stop();
    if (heard.isEmpty) {
      // The recogniser ran and produced NOTHING. Saying so is the point:
      // silently dropping the waveform reads as "the app is broken".
      _showNote(kWorkDictationHeardNothing);
      return;
    }
    _land(heard);
  }

  /// Put recognised [text] in the field with the caret at the end.
  ///
  /// DEVANAGARI IS STRIPPED AND SAID SO, matching the chat composer's
  /// `_landDictation` and this field's own [DevanagariBlockFormatter] on typed
  /// input — the résumé prints Roman script and no transliteration exists on the
  /// render path. What this does NOT do is the old mic's mistake: it never
  /// reports a perfectly good recording as "Awaaz nahi pakad paaye" and throws
  /// it away. If the strip empties the text, the worker is told the SCRIPT was
  /// the problem, which is the only message they can act on.
  void _land(String text) {
    if (text.isEmpty) return;
    final String romanized = stripDevanagari(text);
    final String cleaned = romanized.trim();
    final String capped = cleaned.length > widget.maxLength
        ? cleaned.substring(0, widget.maxLength).trimRight()
        : cleaned;

    setState(() {
      _note = romanized != text ? kDevanagariBlockedHint : null;
      widget.controller.value = TextEditingValue(
        text: capped,
        selection: TextSelection.collapsed(offset: capped.length),
      );
    });
    widget.onText(capped);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const SizedBox(height: AppSpacing.s2),
        Align(
          alignment: Alignment.centerLeft,
          child: _dictation.listening ? _listeningRow() : _idleButton(),
        ),
        if (_note != null)
          Padding(
            key: kWorkDictationStatusKey,
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

  Widget _idleButton() {
    return TextButton.icon(
      key: kWorkDictationButtonKey,
      onPressed: widget.enabled ? _start : null,
      icon: const Icon(Icons.mic_rounded, color: AppColors.blue),
      label: Text(
        kWorkDictationIdleLabel,
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          weight: FontWeight.w600,
          color: AppColors.blue,
        ),
      ),
      style: TextButton.styleFrom(
        // The worker tap floor; a mic that is hard to hit is no mic.
        minimumSize: const Size(0, AppSpacing.tap),
      ),
    );
  }

  /// The LIVE row: a slim waveform beside the stop control. A cue, not a
  /// control — every dp it takes pushes the card's own Save further down a
  /// 640dp-tall phone, which is why it is a strip rather than the chat
  /// composer's full-width bar.
  Widget _listeningRow() {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        TextButton.icon(
          key: kWorkDictationButtonKey,
          onPressed: _stop,
          icon: const Icon(Icons.stop_circle_rounded, color: AppColors.danger),
          label: Text(
            kWorkDictationStopLabel,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              weight: FontWeight.w600,
              color: AppColors.danger,
            ),
          ),
          style: TextButton.styleFrom(
            minimumSize: const Size(0, AppSpacing.tap),
          ),
        ),
        const SizedBox(width: AppSpacing.s2),
        Semantics(
          container: true,
          liveRegion: true,
          label: kWorkDictationListeningLabel,
          excludeSemantics: true,
          child: SizedBox(
            key: kWorkDictationWaveKey,
            width: 72,
            height: 28,
            child: VoiceWaveVisualizer(level: _dictation.level),
          ),
        ),
      ],
    );
  }
}
