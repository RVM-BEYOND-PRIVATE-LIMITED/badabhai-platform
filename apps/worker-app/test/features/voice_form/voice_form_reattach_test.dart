import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:record/record.dart';

import 'package:badabhai_worker_app/core/observability/analytics.dart';
import 'package:badabhai_worker_app/features/voice/data/session_voice_recorder.dart';
import 'package:badabhai_worker_app/features/voice_form/data/voice_form_action_log.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/question_audio_player.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/silence_endpointer.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_correction_outcome.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_gateway.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/cubit/voice_form_cubit.dart';
import 'voice_form_doubles.dart';

class MockAudioRecorder extends Mock implements AudioRecorder {}

class FakeTts implements QuestionAudioPlayer {
  @override
  Future<void> play(VoiceQuestion question) async {}
  @override
  Future<void> stop() async {}
}

/// A gateway whose submit returns whatever [onSubmit] scripts — so a 409
/// re-attach (a [ReattachedTo] step) can be exercised through the cubit.
class ScriptedGateway implements VoiceFormGateway {
  ScriptedGateway(this.onSubmit);

  final VoiceFormStep Function(int submitNo) onSubmit;
  int submits = 0;

  @override
  String? get sessionId => 'sess-test';

  @override
  Future<VoiceFormStep> start() async => const NextQuestion(
        VoiceQuestion(id: 'q1', prompt: 'Q1'),
        index: 1,
        total: 2,
      );

  @override
  Future<VoiceFormStep> submit(VoiceAnswer answer, {String? questionKey}) async {
    submits++;
    return onSubmit(submits);
  }

  @override
  Future<void> finalize() async {}

  /// Unused here — this fake exists for the 409 re-attach path, which never corrects.
  /// Present because `VoiceFormGateway` declares it (#700): Dart requires every member of
  /// an implemented interface, so omitting it is a COMPILE error, not an unused stub.
  @override
  Future<VoiceCorrectionOutcome> correct(
    VoiceAnswer answer, {
    required String questionKey,
  }) => throw UnimplementedError();
}

/// #727 — a 409 on submit re-attaches as a [ReattachedTo]; the cubit must NOT
/// bank the rejected answer nor emit `profiling_answer_spoken`.
void main() {
  setUpAll(() {
    registerFallbackValue(const RecordConfig());
    registerFallbackValue(Duration.zero);
  });

  late MockAudioRecorder plugin;
  late FakeRegistrar registrar;
  late List<BbAnalyticsEvent> sunk;
  late VoiceFormActionLog actionLog;
  int stopN = 0;

  setUp(() {
    plugin = MockAudioRecorder();
    registrar = FakeRegistrar();
    sunk = <BbAnalyticsEvent>[];
    actionLog = VoiceFormActionLog(
      sink: (List<BbAnalyticsEvent> batch) async => sunk.addAll(batch),
    );
    stopN = 0;
    when(() => plugin.hasPermission()).thenAnswer((_) async => true);
    when(() => plugin.start(any(), path: any(named: 'path')))
        .thenAnswer((_) async {});
    when(() => plugin.cancel()).thenAnswer((_) async {});
    when(() => plugin.dispose()).thenAnswer((_) async {});
    when(() => plugin.onAmplitudeChanged(any()))
        .thenAnswer((_) => const Stream<Amplitude>.empty());
    when(() => plugin.onStateChanged())
        .thenAnswer((_) => const Stream<RecordState>.empty());
    when(() => plugin.stop()).thenAnswer((_) async => 'clip-${stopN++}.m4a');
  });

  VoiceFormCubit build(VoiceFormGateway gateway) => VoiceFormCubit(
        gateway: gateway,
        recorder: SessionVoiceRecorder(recorder: plugin),
        endpointer: SilenceEndpointer(),
        tts: FakeTts(),
        registrar: registrar,
        session: testSession(),
        sleep: (_) async {},
        actionLog: actionLog,
      );

  test('a 409 re-attach does NOT bank the answer and emits no spoken signal',
      () async {
    // First (and only) submit re-attaches straight to done — the classic
    // retry-after-timeout: the answer landed server-side, the client re-sent,
    // the server rejected the re-send as stale.
    final ScriptedGateway gateway =
        ScriptedGateway((int n) => const ReattachedTo(VoiceFormDone()));
    final VoiceFormCubit cubit = build(gateway);
    addTearDown(cubit.close);

    await cubit.start();
    await cubit.answerBySpeaking(); // spoken answer to q1 → 409 → re-attach

    // Routed to done → review, but with NOTHING banked (the answer was stale).
    expect(cubit.state, isA<VoiceFormReview>());
    expect((cubit.state as VoiceFormReview).answers, isEmpty);

    // The flush ran on done; no profiling_answer_spoken was ever recorded.
    expect(
      sunk.map((BbAnalyticsEvent e) => e.name),
      isNot(contains('profiling_answer_spoken')),
    );
  });

  test('a 409 re-attach presents the CURRENT question without banking',
      () async {
    // Submit 1 → re-attach to a different question (q2). Submit 2 → done.
    final ScriptedGateway gateway = ScriptedGateway(
      (int n) => n == 1
          ? const ReattachedTo(
              NextQuestion(
                VoiceQuestion(id: 'q2', prompt: 'Q2'),
                index: 2,
                total: 2,
              ),
            )
          : const VoiceFormDone(),
    );
    final VoiceFormCubit cubit = build(gateway);
    addTearDown(cubit.close);

    await cubit.start();
    await cubit.answerBySpeaking(); // q1 → 409 → present q2, NOT banked

    expect(cubit.state, isA<VoiceFormAsking>());
    expect((cubit.state as VoiceFormAsking).question.id, 'q2');

    await cubit.answerBySpeaking(); // q2 → done

    // Only the ONE real answer (to q2) was banked — never the stale q1 one.
    expect(cubit.state, isA<VoiceFormReview>());
    expect((cubit.state as VoiceFormReview).answers, hasLength(1));
  });
}
