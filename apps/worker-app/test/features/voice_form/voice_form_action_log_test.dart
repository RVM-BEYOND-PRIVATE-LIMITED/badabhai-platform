import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:record/record.dart';

import 'package:badabhai_worker_app/core/observability/analytics.dart';
import 'package:badabhai_worker_app/features/voice/data/session_voice_recorder.dart';
import 'package:badabhai_worker_app/features/voice_form/data/voice_form_action_log.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/question_audio_player.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/silence_endpointer.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_gateway.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_correction_outcome.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_review_row.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/cubit/voice_form_cubit.dart';
import 'voice_form_doubles.dart';

class MockAudioRecorder extends Mock implements AudioRecorder {}

class FakeTts implements QuestionAudioPlayer {
  @override
  Future<void> play(VoiceQuestion question) async {}
  @override
  Future<void> stop() async {}
}

class OneQGateway implements VoiceFormGateway {
  @override
  String? get sessionId => 'sess-test';

  @override
  Future<VoiceFormStep> start() async =>
      const NextQuestion(VoiceQuestion(id: 'q1', prompt: 'Q1'),
          index: 1, total: 1);
  @override
  Future<VoiceFormStep> submit(VoiceAnswer answer, {String? questionKey}) async =>
      const VoiceFormDone();
  @override
  Future<void> finalize() async {}

  @override
  Future<List<VoiceReviewRow>> reviewRows() async => const <VoiceReviewRow>[];

  @override
  Future<VoiceCorrectionOutcome> correct(
    VoiceAnswer answer, {
    required String questionKey,
  }) => throw UnimplementedError();
}

void main() {
  setUpAll(() {
    registerFallbackValue(const RecordConfig());
    registerFallbackValue(Duration.zero);
  });

  group('VoiceFormActionLog (#639)', () {
    test('records buffer synchronously; flush emits then drains', () async {
      final List<BbAnalyticsEvent> sunk = <BbAnalyticsEvent>[];
      final VoiceFormActionLog log =
          VoiceFormActionLog(sink: (List<BbAnalyticsEvent> b) async => sunk.addAll(b));

      log.recordQuestionAudioPlayed(3);
      log.recordAnswerSpoken(3);
      expect(log.pending, 2);
      expect(sunk, isEmpty, reason: 'nothing emitted until flush');

      await log.flush();
      expect(log.pending, 0);
      expect(sunk.map((BbAnalyticsEvent e) => e.name),
          <String>['question_audio_played', 'profiling_answer_spoken']);
      expect(sunk.first.parameters['question_index'], 3);
      expect(sunk.first.parameters.containsKey('question_id'), isFalse);
    });

    test('flush is best-effort — a throwing sink never propagates', () async {
      final VoiceFormActionLog log = VoiceFormActionLog(
          sink: (List<BbAnalyticsEvent> b) async => throw Exception("offline"));
      log.recordAnswerSpoken(1);
      await log.flush(); // must not throw
      expect(log.pending, 0, reason: 'drained regardless of sink failure');
    });
  });

  group('cubit hooks (#639)', () {
    late MockAudioRecorder plugin;
    late List<BbAnalyticsEvent> sunk;
    late VoiceFormActionLog log;

    setUp(() {
      plugin = MockAudioRecorder();
      sunk = <BbAnalyticsEvent>[];
      log = VoiceFormActionLog(sink: (List<BbAnalyticsEvent> b) async => sunk.addAll(b));
      when(() => plugin.hasPermission()).thenAnswer((_) async => true);
      when(() => plugin.start(any(), path: any(named: 'path')))
          .thenAnswer((_) async {});
      when(() => plugin.cancel()).thenAnswer((_) async {});
      when(() => plugin.dispose()).thenAnswer((_) async {});
      when(() => plugin.stop()).thenAnswer((_) async => 'clip.m4a');
      when(() => plugin.onAmplitudeChanged(any()))
          .thenAnswer((_) => const Stream<Amplitude>.empty());
      when(() => plugin.onStateChanged())
          .thenAnswer((_) => const Stream<RecordState>.empty());
    });

    VoiceFormCubit build() => VoiceFormCubit(
          gateway: OneQGateway(),
          recorder: SessionVoiceRecorder(recorder: plugin),
          endpointer: SilenceEndpointer(),
          tts: FakeTts(),
          registrar: FakeRegistrar(),
          session: testSession(),
          sleep: (_) async {},
          actionLog: log,
        );

    test('a MANUAL replay records question_audio_played', () async {
      final VoiceFormCubit cubit = build();
      addTearDown(cubit.close);
      await cubit.start();
      await cubit.replay();

      expect(log.pending, 1);
      expect(log.pending, greaterThan(0));
    });

    test('a spoken answer records profiling_answer_spoken and flushes on done',
        () async {
      final VoiceFormCubit cubit = build();
      addTearDown(cubit.close);
      await cubit.start();
      await cubit.answerBySpeaking(); // Q1 spoken → done → flush
      await Future<void>.delayed(Duration.zero); // let the flush microtask run

      expect(sunk.map((BbAnalyticsEvent e) => e.name),
          contains('profiling_answer_spoken'));
      expect(sunk
          .firstWhere((BbAnalyticsEvent e) => e.name == 'profiling_answer_spoken')
          .parameters['question_index'], 1);
    });

    test('a CHIP answer does NOT record profiling_answer_spoken', () async {
      final VoiceFormCubit cubit = build();
      addTearDown(cubit.close);
      await cubit.start();
      await cubit.answerByChips(<String>['x']); // no speaking → no signal
      await Future<void>.delayed(Duration.zero);

      expect(sunk.map((BbAnalyticsEvent e) => e.name),
          isNot(contains('profiling_answer_spoken')));
    });
  });
}
