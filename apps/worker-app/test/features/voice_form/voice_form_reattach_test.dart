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

/// A gateway whose submit returns whatever [onSubmit] scripts — so a 409
/// re-attach (a [ReattachedTo] step) can be exercised through the cubit.
///
/// [answered] is the server-truth set the cubit reads via [answeredQuestionKeys]
/// to CONFIRM a re-attach's answer actually landed before recovering the spoken
/// signal (#775): put the question's key in it to simulate "the earlier attempt
/// landed", leave it empty to simulate a 409 from another cause.
class ScriptedGateway implements VoiceFormGateway {
  ScriptedGateway(this.onSubmit, {this.answered = const <String>{}});

  final VoiceFormStep Function(int submitNo) onSubmit;
  final Set<String> answered;
  int submits = 0;
  int answeredReads = 0;

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
  Future<List<VoiceReviewRow>> reviewRows() async => const <VoiceReviewRow>[];

  @override
  Future<VoiceCorrectionOutcome> correct(
    VoiceAnswer answer, {
    required String questionKey,
  }) => throw UnimplementedError();


  @override
  Future<Set<String>> answeredQuestionKeys() async {
    answeredReads++;
    return answered;
  }
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

  test('a 409 re-attach never banks the stale answer into the local echo',
      () async {
    // The classic retry-after-timeout: the answer landed server-side, the client
    // re-sent, the server rejected the re-send as stale. The rejected clip is
    // NEVER banked into `_answers` — the echo heals via #700's server-fed review.
    final ScriptedGateway gateway =
        ScriptedGateway((int n) => const ReattachedTo(VoiceFormDone()));
    final VoiceFormCubit cubit = build(gateway);
    addTearDown(cubit.close);

    await cubit.start();
    await cubit.answerBySpeaking(); // spoken answer to q1 → 409 → re-attach

    expect(cubit.state, isA<VoiceFormReview>());
    expect((cubit.state as VoiceFormReview).answers, isEmpty);
  });

  test(
      '#775 — a re-attach the server CONFIRMS landed recovers the spoken signal '
      '(exact, still not banked)', () async {
    // The server records q1 as answered — the earlier attempt landed. The spoken
    // engagement signal, under-counted only on this flaky-2G path, is recovered.
    final ScriptedGateway gateway = ScriptedGateway(
      (int n) => const ReattachedTo(VoiceFormDone()),
      answered: const <String>{'q1'},
    );
    final VoiceFormCubit cubit = build(gateway);
    addTearDown(cubit.close);

    await cubit.start();
    await cubit.answerBySpeaking(); // spoken q1 → 409 → reattach; server has q1
    await Future<void>.delayed(Duration.zero); // let the done-flush settle

    expect(gateway.answeredReads, 1, reason: 'confirmed from server truth');
    // The echo is still not banked; only the SIGNAL is recovered.
    expect((cubit.state as VoiceFormReview).answers, isEmpty);
    expect(
      sunk.map((BbAnalyticsEvent e) => e.name),
      contains('profiling_answer_spoken'),
    );
  });

  test(
      '#775 — a re-attach the server does NOT confirm never over-counts',
      () async {
    // A 409 from another cause (e.g. a reopen mid-offer): the server does NOT
    // record q1 answered, so the signal must NOT fire.
    final ScriptedGateway gateway = ScriptedGateway(
      (int n) => const ReattachedTo(VoiceFormDone()),
      answered: const <String>{}, // q1 is NOT answered server-side
    );
    final VoiceFormCubit cubit = build(gateway);
    addTearDown(cubit.close);

    await cubit.start();
    await cubit.answerBySpeaking();
    await Future<void>.delayed(Duration.zero);

    expect(gateway.answeredReads, 1);
    expect(
      sunk.map((BbAnalyticsEvent e) => e.name),
      isNot(contains('profiling_answer_spoken')),
    );
  });

  test('#775 — a re-attach of a NON-spoken answer never emits the spoken signal',
      () async {
    // The signal is SPOKEN-only. A chip answer that re-attaches must not fire it,
    // even when the server confirms the question landed — so the server truth is
    // not even read.
    final ScriptedGateway gateway = ScriptedGateway(
      (int n) => const ReattachedTo(VoiceFormDone()),
      answered: const <String>{'q1'},
    );
    final VoiceFormCubit cubit = build(gateway);
    addTearDown(cubit.close);

    await cubit.start();
    await cubit.answerByChips(<String>['x']); // NOT spoken
    await Future<void>.delayed(Duration.zero);

    expect(gateway.answeredReads, 0, reason: 'spoken-only: no confirmation read');
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
