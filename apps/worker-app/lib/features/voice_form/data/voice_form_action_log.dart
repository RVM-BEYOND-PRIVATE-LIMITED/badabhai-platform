import 'dart:async';

import '../../../core/observability/analytics.dart';

/// Client-side batcher for the two voice-form action signals (#639):
/// `question_audio_played` (a MANUAL replay only) and `profiling_answer_spoken`.
///
/// Two rules the epic is strict about:
///  - **Never on the critical path.** [recordQuestionAudioPlayed] /
///    [recordAnswerSpoken] are synchronous buffer appends — they can never delay
///    or block an accessibility affordance (the replay). Emission happens later,
///    in [flush], and is best-effort: a failed sink is swallowed.
///  - **Ids/enums/counts only.** The buffered [BbAnalyticsEvent]s carry a 1-based
///    `question_index` count — never the question text, the transcript, or any
///    id. `analytics_pii_test.dart` scans the whole event set to keep it that way.
class VoiceFormActionLog {
  VoiceFormActionLog({Future<void> Function(BbAnalyticsEvent)? sink})
      : _sink = sink ?? BbAnalytics.instance.log;

  final Future<void> Function(BbAnalyticsEvent) _sink;
  final List<BbAnalyticsEvent> _buffer = <BbAnalyticsEvent>[];

  /// Buffered-but-unflushed count (test seam).
  int get pending => _buffer.length;

  /// A MANUAL replay of question [questionIndex] (1-based). Never call this for
  /// autoplay — the whole value of the signal is that it is deliberate.
  void recordQuestionAudioPlayed(int questionIndex) => _buffer
      .add(BbAnalytics.questionAudioPlayed(questionIndex: questionIndex));

  /// A spoken answer to question [questionIndex] (1-based).
  void recordAnswerSpoken(int questionIndex) =>
      _buffer.add(BbAnalytics.profilingAnswerSpoken(questionIndex: questionIndex));

  /// Best-effort flush of the batch. Never throws; a failed emit is dropped, not
  /// retried on the critical path. Safe to call repeatedly (drains the buffer).
  Future<void> flush() async {
    if (_buffer.isEmpty) return;
    final List<BbAnalyticsEvent> batch = List<BbAnalyticsEvent>.of(_buffer);
    _buffer.clear();
    for (final BbAnalyticsEvent event in batch) {
      try {
        await _sink(event);
      } catch (_) {
        // Best-effort — analytics is never allowed to surface or block.
      }
    }
  }
}
